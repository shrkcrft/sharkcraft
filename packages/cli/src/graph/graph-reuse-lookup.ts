import type { GraphQueryApi } from '@shrkcrft/graph';
import type { IReuseSymbolLookup } from '@shrkcrft/inspector';

/**
 * The reuse engine's graph questions, answered from one snapshot — shared by
 * `shrk reuse` and `shrk reuse coverage`, so both resolve every curated entry
 * (its declaration, import line and whether that import compiles) through the
 * same lookups, via the inspector's `resolveCuratedReuse`.
 */
export function graphReuseLookup(api: GraphQueryApi): IReuseSymbolLookup {
  return {
    declarationsOf: (name) =>
      api
        .findSymbol(name, { exact: true, limit: 1000 })
        .filter((n) => typeof n.path === 'string')
        .map((n) => {
          const declKind = n.data?.['declKind'];
          return {
            path: n.path as string,
            symbolId: n.id,
            isExported: n.data?.['isExported'] === true,
            ...(typeof n.line === 'number' ? { line: n.line } : {}),
            ...(typeof declKind === 'string' ? { declKind } : {}),
          };
        }),
    consumerCount: (symbolId) => api.referenceSitesOf(symbolId).length,
    specifierExport: (specifier, symbol) => {
      // The file consumers' imports of this specifier resolved to (aliases and
      // subpaths included) — then the SAME ESM export walk the surface runs.
      const file = api.fileForSpecifier(specifier);
      if (!file?.path) return undefined;
      const hit = api.moduleExports(file.path).exports.find((e) => e.name === symbol);
      if (hit === undefined) return null;
      return {
        symbolId: hit.symbolId,
        declaredIn: hit.declaredIn,
        declKind: hit.declKind,
        ...(hit.line !== undefined ? { line: hit.line } : {}),
        ...(hit.isDefault === true ? { isDefault: true } : {}),
      };
    },
  };
}
