import {
  buildRegistrationGraph,
  registrationChain,
  registrationOrphans,
  registrationUnprovided,
} from '@shrkcrft/boundaries';
import { resolveProjectConfig } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

/**
 * Read-only MCP surface for the runtime registration/DI graph. Mirrors
 * `shrk wiring unprovided | orphans | chain` so an agent can query the
 * silent-at-runtime wiring facts the import graph structurally can't see —
 * without shelling out. Read-only by contract: it calls the PURE
 * `buildRegistrationGraph` (a tree walk, no writes) and never touches the
 * CLI's persisted cache; the CLI stays the only write/gate path.
 */
export const getWiringGraphTool: IToolDefinition = {
  name: 'get_wiring_graph',
  description:
    'Query the runtime registration/DI graph (declared → provided → consumed) for the silent-at-runtime bugs the import graph CANNOT see: tokens declared/injected but never PROVIDED ("unprovided" — resolves to undefined at runtime, typecheck-green) and providers nothing CONSUMES ("orphans" — a dead registration). Pass `token` to also get that token\'s full declared→provided→consumed chain + verdict. Read-only; needs `registrationGraph[]` idioms in sharkcraft.config.ts. Mirrors `shrk wiring unprovided|orphans|chain` — the CLI is the gate/write path, this is orientation.',
  inputSchema: {
    type: 'object',
    properties: {
      token: {
        type: 'string',
        description: "Optional: also return this token's declared→provided→consumed chain + verdict.",
      },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const token =
      typeof (input as { token?: unknown }).token === 'string'
        ? (input as { token: string }).token
        : undefined;
    const projectRoot = ctx.inspection.projectRoot;

    const loaded = await resolveProjectConfig(projectRoot);
    if (!loaded.ok) {
      return {
        data: {
          ok: false,
          error: loaded.error.message,
          note: 'sharkcraft.config.ts failed to load',
        },
      };
    }
    const idioms = loaded.value.config.registrationGraph ?? [];
    if (idioms.length === 0) {
      return {
        data: {
          schema: 'sharkcraft.registration-graph/v1',
          idioms: [],
          unprovidedCount: 0,
          unprovided: [],
          orphanCount: 0,
          orphans: [],
          note: 'no registration idioms configured — declare registrationGraph[] (declared/provided/consumed shapes) in sharkcraft.config.ts to model DI wiring as a queryable graph (see docs/wiring.md)',
          nextCommand: 'shrk wiring unprovided',
        },
      };
    }

    // Pure read-only build — no persisted cache is written (MCP is read-only;
    // the `shrk wiring` CLI owns the on-disk cache).
    const graph = buildRegistrationGraph(projectRoot, idioms);
    const unprovided = registrationUnprovided(graph);
    const orphans = registrationOrphans(graph);
    const chain = token !== undefined ? (registrationChain(graph, token) ?? null) : undefined;

    return {
      data: {
        schema: graph.schema,
        idioms: graph.idioms,
        diagnostics: graph.diagnostics,
        unprovidedCount: unprovided.length,
        unprovided,
        orphanCount: orphans.length,
        orphans,
        ...(token !== undefined ? { token, chain } : {}),
        nextCommand:
          unprovided.length > 0
            ? 'shrk wiring unprovided   # inspect the silent-at-runtime tokens, then wire a provider'
            : 'shrk wiring chain <token>',
      },
    };
  },
};
