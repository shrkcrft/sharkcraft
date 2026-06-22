import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { EdgeKind, GraphQueryApi, GraphStore, NodeKind, loadGraphApiCached, type INode } from '@shrkcrft/graph';
import type { IToolDefinition } from '../server/tool-definition.ts';
import { FORMAT_INPUT_PROPERTY, formatObjectArrays } from '../server/columnar-format.ts';
import { callGraphLanguageNote } from './graph-staleness.ts';

/**
 * `code_find_usages` — structured usage finder backed by the
 * SharkCraft graph (file + symbol nodes + import/declare edges).
 *
 * Unlike grep, this distinguishes:
 *   - the symbol's definition site
 *   - which files import the declaring file (runtime + type-only
 *     can't be split without TS-level checks, so we mark them all as
 *     `import-of-declaring-file` for honesty)
 *   - which other symbols neighbour the target in the graph
 *
 * Read-only. Skips when the graph is missing (returns a hint).
 */
export const codeFindUsagesTool: IToolDefinition = {
  name: 'code_find_usages',
  description:
    'Find where a symbol is used (use this instead of grep). Returns the definition site and exact use sites as path:line via the SharkCraft graph, plus files that import the declaring file and neighbouring symbols. Read-only; needs `shrk graph index`. Pass `format:"table"` for a token-efficient columnar encoding.',
  inputSchema: {
    type: 'object',
    properties: {
      symbolName: { type: 'string' },
      kindHint: { type: 'string' },
      maxResults: { type: 'number' },
      ...FORMAT_INPUT_PROPERTY,
    },
    required: ['symbolName'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const symbolName = typeof input['symbolName'] === 'string' ? (input['symbolName'] as string).trim() : '';
    if (symbolName.length === 0) {
      return { data: { error: 'symbolName is required' } };
    }
    const maxResults = clamp(typeof input['maxResults'] === 'number' ? (input['maxResults'] as number) : 25, 1, 200);

    const store = new GraphStore(ctx.cwd);
    if (!store.exists()) {
      return {
        data: {
          error: 'no-graph',
          message: 'The SharkCraft graph index has not been built yet. Build it with `shrk graph index`.',
          nextCommand: 'shrk graph index',
        },
      };
    }
    const api = loadGraphApiCached(ctx.cwd) ?? GraphQueryApi.fromStore(ctx.cwd);
    const matches = api.findSymbol(symbolName, { exact: true, limit: maxResults });
    if (matches.length === 0) {
      return {
        data: {
          symbol: { name: symbolName, kind: 'unknown' },
          definitions: [],
          importersOfDeclaringFile: [],
          neighbouringSymbols: [],
          totalSymbolMatches: 0,
          note: 'No exact symbol match in the graph. Try `shrk knowledge search` for fuzzy lookup.',
        },
      };
    }

    const definitions: Array<{ symbolId: string; file: string | null; line?: number; kind: string }> = [];
    const importerSet = new Map<string, { file: string; via: string }>();
    const neighbours: Array<{ name: string; kind: string; file: string | null }> = [];
    const useSites: Array<{ file: string; line?: number }> = [];

    for (const sym of matches) {
      const declaringFile = declaringFileOf(api, sym.id);
      definitions.push({
        symbolId: sym.id,
        file: declaringFile?.path ?? null,
        ...(sym.line ? { line: sym.line } : {}),
        kind: String(sym.label && sym.label.length > 0 ? sym.label : sym.kind),
      });
      // Exact use sites (path:line) from the symbol's own call/reference
      // edges, so the agent jumps straight to where it's used rather than
      // grepping inside each importing file.
      for (const site of api.referenceSitesOf(sym.id)) {
        if (!site.node.path) continue;
        // Prune use sites whose file no longer exists — uniformly with
        // importersOfDeclaringFile below, so the payload never lists a deleted
        // file in one field while dropping it in another (a self-contradicting,
        // authoritative-looking result is worse than a uniformly-stale one).
        if (!pathExists(ctx.cwd, site.node.path)) continue;
        useSites.push({ file: site.node.path, ...(site.line ? { line: site.line } : {}) });
      }
      if (declaringFile) {
        for (const importer of api.importersOf(declaringFile.id)) {
          if (!importer.path) continue;
          const exists = pathExists(ctx.cwd, importer.path);
          if (!exists) continue;
          const key = `${importer.path}::${declaringFile.path}`;
          if (!importerSet.has(key)) {
            importerSet.set(key, {
              file: importer.path,
              via: declaringFile.path ?? '',
            });
          }
        }
      }
      // Sibling symbols declared by the same file.
      if (declaringFile) {
        for (const sib of api.symbolsIn(declaringFile.id).slice(0, 6)) {
          if (sib.id === sym.id) continue;
          neighbours.push({
            name: sib.label,
            kind: String(sib.kind),
            file: declaringFile.path ?? null,
          });
        }
      }
    }

    // Result-file staleness: which surviving result files changed content
    // since indexing (deleted ones are already pruned above). Flags a payload
    // whose line numbers / membership may be out of date for files the agent
    // just edited. Read-only.
    const resultPaths = [
      ...definitions.map((d) => d.file),
      ...useSites.map((u) => u.file),
      ...[...importerSet.values()].map((i) => i.file),
    ].filter((p): p is string => !!p);
    const stale = api.staleFilesAmong(ctx.cwd, resultPaths);
    // Non-TS languages have no call/reference extraction, so empty useSites must
    // not be read as "no usages".
    const langNote = matches[0] ? callGraphLanguageNote(api, matches[0]) : undefined;
    const data = {
      symbol: { name: symbolName, kind: matches[0]?.kind ?? 'unknown' },
      definitions,
      useSites,
      importersOfDeclaringFile: [...importerSet.values()],
      neighbouringSymbols: neighbours.slice(0, 12),
      totalSymbolMatches: matches.length,
      note:
        (langNote ? langNote + ' ' : '') +
        'useSites = exact file:line of each call/reference to the symbol (first use per file). importersOfDeclaringFile = files that import the declaring file (coarser; may include type-only/unused imports). Pair with `shrk impact` for a tighter blast radius.',
      ...(stale.modified.length > 0
        ? {
            stale: { modified: stale.modified },
            staleHint: 'Some result files changed since indexing — run `shrk graph index --changed` for fresh line numbers.',
          }
        : {}),
    };
    // `format:"table"` columnar-encodes the homogeneous object-array fields
    // (definitions, importersOfDeclaringFile, neighbouringSymbols); the scalar
    // `symbol` object, totalSymbolMatches, and the note string pass through
    // untouched. Default/`format:"json"` returns the bare object unchanged.
    return { data: formatObjectArrays(data, input) };
  },
};

function declaringFileOf(api: GraphQueryApi, symbolId: string): INode | undefined {
  const n = api.neighbours(symbolId);
  if (!n) return undefined;
  for (const incoming of n.in) {
    if (incoming.edge.kind !== EdgeKind.DeclaresSymbol) continue;
    if ('resolved' in incoming.source) continue;
    if (incoming.source.kind === NodeKind.File) return incoming.source;
  }
  return undefined;
}

function pathExists(cwd: string, path: string): boolean {
  try {
    return existsSync(nodePath.isAbsolute(path) ? path : nodePath.join(cwd, path));
  } catch {
    return false;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
