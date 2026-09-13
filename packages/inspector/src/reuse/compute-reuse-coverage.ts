import type { IPublicExport, IPublicExportSurface, IReusePrimitive } from '@shrkcrft/core';
import { splitIdentifierTokens } from '../split-identifier.ts';
import {
  isReuseCurationGap,
  isReuseTestPath,
  isReuseTypeKind,
  rankReuseCandidates,
  reuseNameAnswers,
} from './rank-reuse-candidates.ts';
import { curatedDeclarationMap, isCuratedExport, resolveCuratedReuse } from './resolve-curated-reuse.ts';
import type { IReuseCoverageReport } from './reuse-coverage-report.ts';
import type { IReuseCuratedCoverage } from './reuse-curated-coverage.ts';
import { ReuseCuratedStatus } from './reuse-curated-status.ts';
import type { IReuseSymbolLookup } from './reuse-symbol-lookup.ts';
import { scoreReuseName } from './score-reuse-name.ts';

/** Default cap on the listed uncovered exports (`--all` lifts it). */
export const REUSE_UNCOVERED_CAP = 50;

/**
 * Measure the curated `reusePrimitives[]` against the public export surface.
 *
 * Pure: the surface and the graph lookups are INJECTED. Every question is
 * answered by an existing authority, the SAME one the lookup uses:
 *   - the surface by the graph's `enumeratePublicSurface`;
 *   - which construct a curated entry names, its import line, and whether that
 *     import compiles by `resolveCuratedReuse` — the record `shrk reuse`
 *     prints the entry's row from;
 *   - which exports a curated entry already covers by `isCuratedExport` over
 *     `curatedDeclarationMap` — the exclusion `rankReuseCandidates` applies;
 *   - a curation gap by `isReuseCurationGap` over the lookup's own ranker —
 *     exactly what `shrk reuse "<the export's words>"` reports as `curationGap`.
 *
 * `packageFilter` narrows deliberately: only those packages' exports count,
 * and a curated entry is in scope when its `importPath` is one of them or a
 * declaration lives in one of them.
 */
export function computeReuseCoverage(
  primitives: readonly IReusePrimitive[],
  surface: IPublicExportSurface,
  lookup: IReuseSymbolLookup,
  opts: { readonly includeTypes?: boolean; readonly packageFilter?: readonly string[]; readonly all?: boolean } = {},
): IReuseCoverageReport {
  const selected =
    opts.packageFilter !== undefined && opts.packageFilter.length > 0 ? new Set(opts.packageFilter) : undefined;
  const inScope = (pkg: string): boolean => selected === undefined || selected.has(pkg);
  const packageDirs = [...surface.roots, ...surface.packagesWithoutEntry]
    .map((p) => ({ package: p.package, dir: p.dir.replace(/\/+$/, '') }))
    .filter((p) => p.dir.length > 0)
    .sort((a, b) => b.dir.length - a.dir.length);
  const packageOf = (path: string): string | undefined =>
    packageDirs.find((p) => path === p.dir || path.startsWith(`${p.dir}/`))?.package;
  const withoutEntry = new Set(surface.packagesWithoutEntry.map((w) => w.package));
  const exports = surface.exports.filter((e) => inScope(e.package) && !isReuseTestPath(e.declaredIn));

  // ONE resolution per curated entry — every entry, in or out of scope, since
  // an out-of-scope entry still covers its own construct.
  const resolutions = primitives.map((p) => resolveCuratedReuse(p, surface, lookup));
  const curatedNames = new Set(primitives.map((p) => p.symbol));
  const curatedDeclaredIn = curatedDeclarationMap(primitives, resolutions);

  // ── curated entries ───────────────────────────────────────────────────
  const curated: IReuseCuratedCoverage[] = [];
  /** The construct each reported entry names (parallel to `curated`). */
  const curatedSymbolIds: (string | undefined)[] = [];
  let curatedOutOfScope = 0;
  primitives.forEach((p, i) => {
    const res = resolutions[i]!;
    const decls = lookup.declarationsOf(p.symbol);
    if (selected !== undefined) {
      const declaredInScope = decls.some((d) => {
        const pkg = packageOf(d.path);
        return pkg !== undefined && selected.has(pkg);
      });
      if (!declaredInScope && !(p.importPath !== undefined && selected.has(p.importPath))) {
        curatedOutOfScope += 1;
        return;
      }
    }
    // Only the construct the entry NAMES is "this entry on the surface": a
    // same-named export of a different construct in another package is not.
    const self = res.declaration?.symbolId;
    const publicHits = surface.exports.filter(
      (e) => e.name === p.symbol && (self === undefined || e.symbolId === self),
    );
    const publicIn = [...new Set(publicHits.map((e) => e.package))].sort(compare);
    const exported = decls.filter((d) => d.isExported);
    let status: ReuseCuratedStatus;
    let statusNote: string | undefined;
    if (publicIn.length > 0) status = ReuseCuratedStatus.Public;
    // Its importPath module exports it (checked), yet no package root does.
    else if (res.importPathAgrees === true) status = ReuseCuratedStatus.ExportedNotPublic;
    else if (decls.length === 0) status = ReuseCuratedStatus.NotFound;
    else if (exported.length === 0) status = ReuseCuratedStatus.NotExported;
    else status = exported.length > 1 ? ReuseCuratedStatus.Ambiguous : ReuseCuratedStatus.ExportedNotPublic;
    if (status === ReuseCuratedStatus.ExportedNotPublic || status === ReuseCuratedStatus.Ambiguous) {
      const unmeasured = [
        ...new Set(
          exported.map((d) => packageOf(d.path)).filter((pkg): pkg is string => pkg !== undefined && withoutEntry.has(pkg)),
        ),
      ].sort(compare);
      if (unmeasured.length > 0) {
        statusNote = `declared in ${unmeasured.join(', ')}, which has no resolved entry — whether it is public was not measured`;
      }
    }

    const declKind = res.declaration?.declKind ?? publicHits[0]?.declKind;
    const consumers =
      self !== undefined && lookup.consumerCount !== undefined ? lookup.consumerCount(self) : undefined;
    curated.push({
      symbol: p.symbol,
      status,
      statusMeasured: statusNote === undefined,
      ...(statusNote !== undefined ? { statusNote } : {}),
      publicIn,
      declaredIn: [...new Set(decls.map((d) => d.path))].sort(compare),
      ...(declKind !== undefined ? { declKind } : {}),
      ...(consumers !== undefined ? { consumers } : {}),
      ...(p.importPath !== undefined ? { importPath: p.importPath } : {}),
      ...(res.importPathAgrees !== undefined ? { importPathAgrees: res.importPathAgrees } : {}),
      ...(res.importPathNote !== undefined ? { importPathNote: res.importPathNote } : {}),
      ...(res.importStyle !== undefined ? { importStyle: res.importStyle } : {}),
      ...(res.importLine !== undefined ? { importLine: res.importLine } : {}),
    });
    curatedSymbolIds.push(self);
  });

  // ── the surface ───────────────────────────────────────────────────────
  const byKind: Record<string, number> = {};
  for (const e of exports) byKind[e.declKind] = (byKind[e.declKind] ?? 0) + 1;
  const valueExports = exports.filter((e) => !isReuseTypeKind(e.declKind));
  let curatedPublic = 0;
  let curatedPublicValue = 0;
  curated.forEach((c, i) => {
    if (c.status !== ReuseCuratedStatus.Public || !c.publicIn.some(inScope)) return;
    curatedPublic += 1;
    const self = curatedSymbolIds[i];
    if (valueExports.some((e) => e.name === c.symbol && (self === undefined || e.symbolId === self))) {
      curatedPublicValue += 1;
    }
  });

  // ── uncovered, superseded, shadowed ──────────────────────────────────
  const supersededBy = new Map<string, string[]>();
  for (const p of primitives) {
    for (const name of p.supersedes ?? []) {
      const by = supersededBy.get(name);
      if (by) by.push(p.symbol);
      else supersededBy.set(name, [p.symbol]);
    }
  }
  const uncovered: IPublicExport[] = [];
  const superseded: { export: string; package: string; supersededBy: string[] }[] = [];
  const shadowed: IReuseCoverageReport['shadowed'][number][] = [];
  for (const e of exports) {
    if (isCuratedExport(e, curatedNames, curatedDeclaredIn)) continue;
    if (opts.includeTypes !== true && isReuseTypeKind(e.declKind)) continue;
    const by = supersededBy.get(e.name);
    if (by) {
      superseded.push({ export: e.name, package: e.package, supersededBy: by });
      continue;
    }
    uncovered.push(e);
    // The lookup's own ranker (curated-only: its best curated candidate) and
    // its own gap predicate — what `shrk reuse "<e's words>"` reports as its
    // `curationGap`, with `e` the uncurated export that answers by name.
    const ranking = rankReuseCandidates(primitives, undefined, splitIdentifierTokens(e.name).join(' '), {
      curatedOnly: true,
      limit: 1,
    });
    const answer = ranking.results[0];
    const selfAnswers = reuseNameAnswers(scoreReuseName(e.name, ranking.tokens)) ? 1 : 0;
    if (answer !== undefined && isReuseCurationGap(answer.nameMatch, selfAnswers)) {
      shadowed.push({
        export: e.name,
        package: e.package,
        declaredIn: e.declaredIn,
        answeredBy: answer.symbol,
        matchedVia: answer.matchedVia,
        nameMatch: answer.nameMatch,
      });
    }
  }
  const cap = opts.all === true ? uncovered.length : REUSE_UNCOVERED_CAP;
  const unfollowedReExports = surface.unfollowedReExports.filter((u) => inScope(u.package));

  return {
    curated,
    curatedOutOfScope,
    surface: {
      roots: surface.roots.filter((r) => inScope(r.package)),
      packagesWithoutEntry: surface.packagesWithoutEntry.filter((w) => inScope(w.package)),
      all: exports.length,
      value: valueExports.length,
      byKind,
      unresolvedReExports: unfollowedReExports.length,
      unfollowedReExports,
    },
    curatedPublic,
    curatedPublicValue,
    ...(valueExports.length > 0 ? { ratioValue: curatedPublicValue / valueExports.length } : {}),
    ...(exports.length > 0 ? { ratioAll: curatedPublic / exports.length } : {}),
    uncovered: uncovered.slice(0, cap).map((e) => ({
      name: e.name,
      package: e.package,
      declaredIn: e.declaredIn,
      declKind: e.declKind,
    })),
    uncoveredTotal: uncovered.length,
    shadowed,
    superseded,
  };
}

/** Locale-independent ordering, so a report is byte-stable across machines. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
