import { GraphQueryApi, GraphStore, loadGraphApiCached, type INode } from '@shrkcrft/graph';
import type { IToolDefinition } from '../server/tool-definition.ts';
import { FORMAT_INPUT_PROPERTY, formatObjectArrays } from '../server/columnar-format.ts';
import { graphResultStaleness } from './graph-staleness.ts';

const NEXT = 'shrk graph index';

/** The edge kinds `mode` can isolate. Kept next to the schema so they cannot drift. */
const MODES = ['import', 'reexport', 'type-only', 'all'] as const;
type ImporterMode = (typeof MODES)[number];

interface IImportersInput {
  module?: string;
  mode?: ImporterMode;
  limit?: number;
}

export const getGraphImportersTool: IToolDefinition = {
  name: 'get_graph_importers',
  description:
    'Before MOVING or DELETING a module: every module that imports it, alias-resolved and tagged by edge kind (value import · type-only · re-export). Use this instead of grep — a text search misses path aliases, `.js`-suffixed ESM specifiers, and re-export chains. Distinct from get_graph_callers, which is symbol-scoped and counts call sites, so it cannot see a type-only import (no call site exists) or a re-export (the module stays publicly surfaced under another path). Accepts a repo-relative path OR a package specifier; both resolve to the same node. mode "reexport" answers the decisive question: is this safe to delete, or does something surface it? Read-only; needs `shrk graph index`.',
  cliCommand: 'graph importers',
  inputSchema: {
    type: 'object',
    properties: {
      module: { type: 'string' },
      mode: { type: 'string', enum: [...MODES] },
      limit: { type: 'integer', minimum: 1 },
      ...FORMAT_INPUT_PROPERTY,
    },
    required: ['module'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const args = input as IImportersInput;
    const target = (args.module ?? '').trim();
    if (!target) {
      return { isError: true, error: { code: 'invalid-input', message: 'module is required' } };
    }
    const mode: ImporterMode = MODES.includes(args.mode as ImporterMode)
      ? (args.mode as ImporterMode)
      : 'all';
    // `limit` caps the returned list; `total` stays the true uncapped count, so
    // a truncated result never reads as a complete one.
    const limit =
      typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
        ? Math.floor(args.limit)
        : 200;

    const store = new GraphStore(ctx.inspection.projectRoot);
    if (!store.exists()) {
      return {
        isError: true,
        error: {
          code: 'graph-missing',
          message: `Code-intelligence index is missing. Run '${NEXT}'.`,
          details: { nextCommand: NEXT },
        },
      };
    }
    const api =
      loadGraphApiCached(ctx.inspection.projectRoot) ??
      GraphQueryApi.fromStore(ctx.inspection.projectRoot);

    const file = resolveModule(api, target);
    if (!file) {
      return {
        isError: true,
        error: {
          code: 'not-found',
          message: `No module matched "${target}". Pass a repo-relative file path or a package specifier.`,
          details: { target },
        },
      };
    }

    const all = api.importerEdgesOf(file.id);
    const selected = all.filter((e) => matchesMode(e.kind, e.typeOnly, mode));
    // Targeted staleness over the target + the reported importers: a stale index
    // must never serve an importer whose file is gone.
    const fresh = graphResultStaleness(api, ctx.inspection.projectRoot, [
      file.path,
      ...selected.map((e) => e.node.path),
    ]);
    const live = selected.filter((e) => !e.node.path || !fresh.deletedSet.has(e.node.path));

    const counts = {
      import: all.filter((e) => e.kind === 'import' && !e.typeOnly).length,
      typeOnly: all.filter((e) => e.typeOnly).length,
      reexport: all.filter((e) => e.kind === 'reexport').length,
    };
    const data = {
      schema: 'sharkcraft.graph-importers/v1',
      module: summarise(file),
      mode,
      limit,
      total: live.length,
      counts,
      importers: live.slice(0, limit).map((e) => ({
        ...summarise(e.node),
        edge: e.typeOnly ? 'type-only' : e.kind,
      })),
      ...(counts.reexport > 0
        ? {
            note:
              `${counts.reexport} importer(s) RE-EXPORT this module — deleting or moving it changes a public surface. ` +
              'Call again with mode "reexport" to isolate the bridge chain.',
          }
        : {}),
      ...(fresh.field ?? {}),
    };
    return { data: formatObjectArrays(data, input) };
  },
};

/**
 * `mode: 'import'` means a VALUE import specifically — a type-only edge is
 * reported under `type-only` and nowhere else, so the three narrow modes
 * partition the set and summing them cannot double-count.
 */
function matchesMode(kind: 'import' | 'reexport', typeOnly: boolean, mode: ImporterMode): boolean {
  if (mode === 'all') return true;
  if (mode === 'type-only') return typeOnly;
  if (mode === 'reexport') return kind === 'reexport';
  return kind === 'import' && !typeOnly;
}

/**
 * Resolve a target to a FILE node from a path or a package specifier.
 *
 * Mirrors the CLI `resolveModuleTarget`: the specifier is resolved through the
 * INDEXER's own resolution rather than re-derived here, so the two surfaces
 * cannot disagree about which node a package name means — and neither invents a
 * second alias resolver that diverges on exactly the edges this tool exists to
 * surface.
 */
function resolveModule(api: GraphQueryApi, target: string): INode | undefined {
  const direct = api.findFile(target);
  if (direct) return direct;
  if (target.startsWith('file:')) return api.neighbours(target)?.node;
  const bySpecifier = api.fileForSpecifier(target);
  if (bySpecifier) return bySpecifier;
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js']) {
    const f = api.findFile(target + ext);
    if (f) return f;
  }
  return undefined;
}

/** The node fields worth returning — the same shape every graph tool emits. */
function summarise(node: INode): { id: string; kind: string; label: string; path?: string } {
  return {
    id: node.id,
    kind: node.kind,
    label: node.label ?? node.id,
    ...(node.path ? { path: node.path } : {}),
  };
}
