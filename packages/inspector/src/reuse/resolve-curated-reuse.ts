import {
  ReuseImportStyle,
  type IPublicExport,
  type IPublicExportSurface,
  type IReusePrimitive,
} from '@shrkcrft/core';
import type { IReuseCuratedResolution } from './reuse-curated-resolution.ts';
import type { IReuseSymbolLookup } from './reuse-symbol-lookup.ts';

type IImportTarget = Pick<IPublicExport, 'symbolId' | 'declaredIn' | 'line' | 'declKind' | 'isDefault'>;

/**
 * Resolve ONE curated entry against the code: which declaration it names,
 * whether its `importPath` exposes it, and how the copy-paste import binds it.
 *
 * The one authority for all three: `shrk reuse` prints a curated row from it,
 * and `shrk reuse coverage` judges the entry by it — so the printed import line
 * and "would that import compile?" cannot disagree (a DEFAULT export gets
 * `import X from '…'`, never a named import that does not exist), and the
 * curated construct excluded from the uncurated pool is the same in both.
 *
 * The `importPath` is checked against the module's real export surface: a
 * workspace package root through the public surface, any other specifier
 * through `lookup.specifierExport` (the same ESM walk, from the file consumers'
 * imports of it resolved to).
 *
 * Pure: surface and lookup are injected (the inspector never imports the
 * graph). Without them nothing is checked — the import is printed as
 * configured, named, and `importPathAgrees` is absent.
 */
export function resolveCuratedReuse(
  p: IReusePrimitive,
  surface: IPublicExportSurface | undefined,
  lookup: IReuseSymbolLookup | undefined,
): IReuseCuratedResolution {
  const decls = lookup?.declarationsOf(p.symbol) ?? [];
  let target: IImportTarget | undefined;
  let importPathAgrees: boolean | undefined;
  let importPathNote: string | undefined;
  if (p.importPath !== undefined && surface !== undefined) {
    const spec = p.importPath;
    if (surface.roots.some((r) => r.package === spec)) {
      target = surface.exports.find((e) => e.package === spec && e.name === p.symbol);
      importPathAgrees = target !== undefined;
    } else if (surface.packagesWithoutEntry.some((w) => w.package === spec)) {
      importPathNote = `package ${spec} has no resolved entry, so the import line was not checked`;
    } else {
      const hit = lookup?.specifierExport?.(spec, p.symbol);
      if (hit === undefined) {
        importPathNote = `'${spec}' is not a workspace package root and no indexed import resolves it, so the import line was not checked`;
      } else {
        importPathAgrees = hit !== null;
        if (hit !== null) target = hit;
      }
    }
  }

  // The declaration: pinned by the importPath when it resolved; otherwise the
  // same deterministic pick `shrk reuse` always made (exported first, by path),
  // with a public one ahead of both.
  const onSurface = new Set(
    (surface?.exports ?? []).filter((e) => e.name === p.symbol).map((e) => e.symbolId),
  );
  const rank = (d: { symbolId: string; isExported: boolean }): number =>
    onSurface.has(d.symbolId) ? 0 : d.isExported ? 1 : 2;
  const ordered = [...decls].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
  const declaration: IReuseCuratedResolution['declaration'] =
    target !== undefined
      ? {
          path: target.declaredIn,
          symbolId: target.symbolId,
          isExported: true,
          ...(target.line !== undefined ? { line: target.line } : {}),
          ...(target.declKind !== undefined ? { declKind: target.declKind } : {}),
        }
      : ordered[0];
  const exported = decls.filter((d) => d.isExported);
  const pool = exported.length > 0 ? exported : decls;
  const alternates = [...new Set(pool.map((d) => d.path))]
    .filter((path) => path !== declaration?.path)
    .sort((a, b) => a.localeCompare(b));

  const importStyle = target?.isDefault === true ? ReuseImportStyle.Default : ReuseImportStyle.Named;
  return {
    ...(declaration !== undefined ? { declaration } : {}),
    alternates,
    ...(p.importPath !== undefined
      ? { importStyle, importLine: reuseImportLine(p.symbol, p.importPath, importStyle) }
      : {}),
    ...(importPathAgrees !== undefined ? { importPathAgrees } : {}),
    ...(importPathNote !== undefined ? { importPathNote } : {}),
  };
}

/** The copy-paste import line for `symbol` from `specifier`, bound the way the module exports it. */
export function reuseImportLine(symbol: string, specifier: string, style: ReuseImportStyle): string {
  return style === ReuseImportStyle.Default
    ? `import ${symbol} from '${specifier}';`
    : `import { ${symbol} } from '${specifier}';`;
}

/**
 * Curated symbol → the file(s) its resolved declaration lives in — the exact
 * `curatedDeclaredIn` the ranker excludes by, and the one coverage excludes by.
 * A curated name whose declaration did not resolve is absent (so it is excluded
 * by name alone).
 */
export function curatedDeclarationMap(
  primitives: readonly IReusePrimitive[],
  resolutions: readonly IReuseCuratedResolution[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  primitives.forEach((p, i) => {
    const path = resolutions[i]?.declaration?.path;
    if (path === undefined) return;
    const list = out.get(p.symbol);
    if (list === undefined) out.set(p.symbol, [path]);
    else if (!list.includes(path)) list.push(path);
  });
  return out;
}

/**
 * Is export `e` a construct a curated entry already names? Name AND declaring
 * file: an export sharing a curated name but declared ELSEWHERE is a different
 * construct and stays a candidate. A curated name absent from the map (its
 * declaration did not resolve) is matched by name alone.
 */
export function isCuratedExport(
  e: { readonly name: string; readonly declaredIn: string },
  curatedNames: ReadonlySet<string>,
  curatedDeclaredIn: ReadonlyMap<string, readonly string[]> | undefined,
): boolean {
  if (!curatedNames.has(e.name)) return false;
  const known = curatedDeclaredIn?.get(e.name);
  return known === undefined || known.length === 0 || known.includes(e.declaredIn);
}
