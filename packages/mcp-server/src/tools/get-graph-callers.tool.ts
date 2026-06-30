import { GraphQueryApi, GraphStore, loadGraphApiCached, type INode } from '@shrkcrft/graph';
import type { IToolDefinition } from '../server/tool-definition.ts';
import { FORMAT_INPUT_PROPERTY, formatObjectArrays } from '../server/columnar-format.ts';
import { callGraphLanguageNote, graphResultStaleness } from './graph-staleness.ts';

const NEXT = 'shrk graph index';

interface ICallersInput {
  symbol?: string;
  mode?: 'call' | 'reference';
  limit?: number;
}

export const getGraphCallersTool: IToolDefinition = {
  name: 'get_graph_callers',
  description:
    'Find who calls/references a symbol (use this instead of grep before changing a function/type). Returns each caller as path:line of the first call site. Mode "call" → calls-symbol edges; mode "reference" → both references-symbol and calls-symbol. `total` counts distinct caller FILES (multiple sites in one file collapse to one entry); `limit` caps the returned callers (default 200) while `total` stays the true count. Read-only; needs `shrk graph index`.',
  cliCommand: 'graph callers',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: { type: 'string' },
      mode: { type: 'string', enum: ['call', 'reference'] },
      limit: { type: 'integer', minimum: 1 },
      ...FORMAT_INPUT_PROPERTY,
    },
    required: ['symbol'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const args = input as ICallersInput;
    const target = (args.symbol ?? '').trim();
    if (!target) {
      return {
        isError: true,
        error: { code: 'invalid-input', message: 'symbol is required' },
      };
    }
    const mode = args.mode ?? 'call';
    // `limit` caps the returned call sites (default 200). `total` still reports
    // the true uncapped count, so a truncated result stays honest. Guard NaN/
    // non-positive — a bad value must not zero the callers list while `total`
    // keeps showing the real count.
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
    const api = loadGraphApiCached(ctx.inspection.projectRoot) ?? GraphQueryApi.fromStore(ctx.inspection.projectRoot);
    const resolved = resolveSymbol(api, target);
    if (!resolved) {
      return {
        isError: true,
        error: {
          code: 'not-found',
          message: `No symbol matched "${target}".`,
          details: { target },
        },
      };
    }
    const { sym, alsoNamed } = resolved;
    const cwd = ctx.inspection.projectRoot;
    const sites = mode === 'reference' ? api.referenceSitesOf(sym.id) : api.callerSitesOf(sym.id);
    // Targeted staleness over the result files: drop callers whose file was
    // deleted on disk, flag those whose content changed since indexing — so a
    // stale index never silently serves a wrong/dead caller. Read-only.
    const fresh = graphResultStaleness(api, cwd, [sym.path, ...sites.map((s) => s.node.path)]);
    const live = sites.filter((s) => !s.node.path || !fresh.deletedSet.has(s.node.path));
    const langNote = callGraphLanguageNote(api, sym);
    // When several symbols share the name, callers are reported for ONE of them
    // (the exported-preferred declaration `resolveSymbol` chose). Say so, and
    // name the chosen id, otherwise the agent reads a narrow result as the whole
    // picture for that name. Mirrors the CLI `graph callers` ambiguity note.
    const ambiguityNote =
      alsoNamed > 0
        ? `${alsoNamed + 1} symbols named "${sym.label}"; showing callers of the one at ${sym.path ?? sym.id}${sym.line ? ':' + sym.line : ''} (${sym.id}). Pass a symbol: id to disambiguate.`
        : undefined;
    // `total` is distinct caller FILES: at index time the graph collapses many
    // call/reference sites in one file to a single edge. Say so, otherwise
    // `total` reads as a raw invocation count and under-reports blast radius.
    const dedupNote =
      'total counts distinct caller files — multiple sites within one file collapse to a single entry.';
    // A class/type used only via `new`, a type annotation, or DI has ZERO call
    // sites but real references — in `call` mode that bare `0` reads as "unused".
    // Detect it and point at mode "reference" so the result is actionable. Filter
    // by the same deleted-file set as `live`, so the hint can't contradict the
    // call-mode result; referenceSitesOf dedups by file, so this is distinct files.
    let referenceHint: string | undefined;
    if (mode === 'call' && live.length === 0) {
      const refCount = api
        .referenceSitesOf(sym.id)
        .filter((s) => !s.node.path || !fresh.deletedSet.has(s.node.path)).length;
      if (refCount > 0) {
        referenceHint = `0 call sites, but ${refCount} file(s) reference it (new/type/DI usage) — call get_graph_callers with mode "reference" to see them.`;
      }
    }
    const note = [ambiguityNote, langNote, dedupNote, referenceHint].filter(Boolean).join(' ');
    const data = {
      schema: 'sharkcraft.graph-callers/v1',
      symbol: summarise(sym),
      mode,
      limit,
      total: live.length,
      callers: live.slice(0, limit).map((s) => ({
        ...summarise(s.node),
        ...(s.line ? { line: s.line } : {}),
      })),
      ...(note ? { note } : {}),
      ...(fresh.field ?? {}),
    };
    return { data: formatObjectArrays(data, input) };
  },
};

/**
 * Resolve a callers target to a single symbol, reporting how many OTHER symbols
 * share the name (`alsoNamed`) so the handler can disclose the ambiguity instead
 * of silently picking one. Mirrors the CLI `resolveSymbolTarget`.
 */
function resolveSymbol(
  api: GraphQueryApi,
  target: string,
): { sym: INode; alsoNamed: number } | undefined {
  if (target.startsWith('symbol:')) {
    const node = api.neighbours(target)?.node;
    return node ? { sym: node, alsoNamed: 0 } : undefined;
  }
  const syms = api.findSymbol(target, { exact: true, limit: 5 });
  if (syms.length === 0) return undefined;
  if (syms.length === 1) return { sym: syms[0]!, alsoNamed: 0 };
  // Multiple symbols share the name — prefer an exported declaration if any.
  const exported = syms.find((s) => (s.data?.['isExported'] ?? false) === true);
  return { sym: exported ?? syms[0]!, alsoNamed: syms.length - 1 };
}

function summarise(n: INode): {
  id: string;
  kind: string;
  label: string;
  path?: string;
  line?: number;
} {
  return {
    id: n.id,
    kind: n.kind,
    label: n.label,
    ...(n.path ? { path: n.path } : {}),
    ...(n.line ? { line: n.line } : {}),
  };
}
