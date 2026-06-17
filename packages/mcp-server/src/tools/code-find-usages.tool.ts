import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { EdgeKind, GraphQueryApi, GraphStore, NodeKind, type INode } from '@shrkcrft/graph';
import type { IToolDefinition } from '../server/tool-definition.ts';
import { FORMAT_INPUT_PROPERTY, formatObjectArrays } from '../server/columnar-format.ts';

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
    'Find structured usages of a symbol via the SharkCraft graph (file + symbol nodes). Read-only. Distinguishes definition, import-of-declaring-file, and neighbouring symbols. Pass `format:"table"` for a token-efficient columnar encoding of the definitions/importers/neighbours arrays.',
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
          message: 'The SharkCraft graph index has not been built yet. Build it with `shrk graph build`.',
          nextCommand: 'shrk graph build',
        },
      };
    }
    const api = GraphQueryApi.fromStore(ctx.cwd);
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

    for (const sym of matches) {
      const declaringFile = declaringFileOf(api, sym.id);
      definitions.push({
        symbolId: sym.id,
        file: declaringFile?.path ?? null,
        kind: String(sym.label && sym.label.length > 0 ? sym.label : sym.kind),
      });
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

    const data = {
      symbol: { name: symbolName, kind: matches[0]?.kind ?? 'unknown' },
      definitions,
      importersOfDeclaringFile: [...importerSet.values()],
      neighbouringSymbols: neighbours.slice(0, 12),
      totalSymbolMatches: matches.length,
      note: 'importersOfDeclaringFile = files that import the declaring file. This is a structural signal — it may include type-only imports and unused references. Pair with `shrk impact` for a tighter blast radius.',
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
