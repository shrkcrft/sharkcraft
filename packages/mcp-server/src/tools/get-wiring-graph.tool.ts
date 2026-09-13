import {
  buildRegistrationGraph,
  measureIdiomRoleCoverage,
  planeScanExcludeDirs,
  registrationChain,
  registrationOrphansVerdict,
  registrationUnprovidedVerdict,
} from '@shrkcrft/boundaries';
import { settleVerdict, type IVerdictCoverage } from '@shrkcrft/core';
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
    // THE plane scan scope — the tree `shrk wiring unprovided` walks.
    const excludeDirs = planeScanExcludeDirs(projectRoot, loaded.value.sharkcraftDir);
    const graph = buildRegistrationGraph(projectRoot, idioms, { excludeDirs });
    // Settled against what the graph READ and what every idiom's ROLES examined
    // (round 13, P4 — THE role authority `gates check` reads), through the one
    // helper `shrk wiring unprovided | orphans` and finish's unprovided
    // sub-gate use. An idiom file over the read cap is named, and an absence it
    // could refute (a provider or consumer that may sit in it) is `unproven`:
    // never a finding, never a pass. A role whose globs matched no file is a
    // gap too — it answered `verdict: 'pass'` with `coverage: null` over a
    // declared role that examined nothing. The CLI says NOT VERIFIED there;
    // this tool says the same.
    const roles = measureIdiomRoleCoverage(projectRoot, idioms, excludeDirs);
    const unprovidedV = registrationUnprovidedVerdict(graph, idioms, roles);
    const orphansV = registrationOrphansVerdict(graph, idioms, roles);
    const coverage: IVerdictCoverage[] = [];
    for (const c of [...unprovidedV.coverage, ...orphansV.coverage]) {
      if (!coverage.some((d) => JSON.stringify(d) === JSON.stringify(c))) coverage.push(c);
    }
    const unprovided = unprovidedV.findings;
    const orphans = orphansV.findings;
    // THE core settle (the CLI verbs fold the same records through the gate
    // envelope, which calls it): a clean answer over a gap is not a pass, and
    // an expectEmpty acceptance is reported only when the answer is clean.
    const settled = settleVerdict(unprovided.length > 0 ? 1 : 0, coverage);
    const shortfalls = settled.shortfalls;
    const notVerified = shortfalls.length > 0;
    const chain = token !== undefined ? (registrationChain(graph, token) ?? null) : undefined;

    return {
      data: {
        schema: graph.schema,
        idioms: graph.idioms,
        diagnostics: graph.diagnostics,
        verdict: unprovided.length > 0 ? 'fail' : notVerified ? 'not-verified' : 'pass',
        unprovidedCount: unprovided.length,
        unprovided,
        orphanCount: orphans.length,
        orphans,
        coverage,
        accepted: settled.accepted,
        ...(notVerified
          ? {
              ...(graph.readScope && graph.readScope.unread.length > 0 ? { unread: graph.readScope.unread } : {}),
              shortfall: shortfalls.join('; '),
              shortfalls,
              ...(unprovidedV.unproven.length > 0 ? { unprovidedUnproven: unprovidedV.unproven } : {}),
              ...(orphansV.unproven.length > 0 ? { orphansUnproven: orphansV.unproven } : {}),
            }
          : {}),
        ...(token !== undefined ? { token, chain } : {}),
        nextCommand: notVerified
          ? 'shrk wiring unprovided   # NOT VERIFIED — an idiom file was not read or a role examined nothing; the verb names it'
          : unprovided.length > 0
            ? 'shrk wiring unprovided   # inspect the silent-at-runtime tokens, then wire a provider'
            : 'shrk wiring chain <token>',
      },
    };
  },
};
