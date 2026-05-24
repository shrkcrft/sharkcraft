import {
  API_SURFACE_DIFF_SCHEMA,
  type DiffChangeKind,
  type DiffSeverity,
  type IApiSurface,
  type IApiSurfaceDiff,
  type IApiSymbolDiff,
  type IPublicSymbol,
} from '../schema/api-surface.ts';

/**
 * Compare two API surface snapshots and return a structured diff.
 *
 * Matching strategy: symbols are paired by `(package, name, isDefault)`
 * tuple. This means a symbol that moved files (within the same
 * package) is reported as `moved-file` (additive); a symbol that moved
 * packages is `moved-package` (breaking — consumers' imports must
 * change). Pure rename or kind change with the same matching tuple is
 * reported as `kind-changed`.
 *
 * `removed` entries are always **breaking**. `added` entries are
 * **additive**. Returned `entries` are sorted breaking → additive →
 * info, then alphabetically by symbol name.
 */
export function diffApiSurfaces(baseline: IApiSurface, current: IApiSurface): IApiSurfaceDiff {
  const baselineByKey = new Map<string, IPublicSymbol>();
  const currentByKey = new Map<string, IPublicSymbol>();
  for (const s of baseline.symbols) baselineByKey.set(keyOf(s), s);
  for (const s of current.symbols) currentByKey.set(keyOf(s), s);

  const entries: IApiSymbolDiff[] = [];

  // Removed: present in baseline, absent in current.
  for (const [key, b] of baselineByKey) {
    if (currentByKey.has(key)) continue;
    entries.push({
      kind: 'removed',
      severity: 'breaking',
      message: `removed: ${describe(b)}`,
      symbol: b,
    });
  }
  // Added or modified.
  for (const [key, c] of currentByKey) {
    const b = baselineByKey.get(key);
    if (!b) {
      entries.push({
        kind: 'added',
        severity: 'additive',
        message: `added: ${describe(c)}`,
        symbol: c,
      });
      continue;
    }
    // Kind change.
    if (b.kind !== c.kind) {
      entries.push({
        kind: 'kind-changed',
        severity: kindChangeSeverity(b.kind, c.kind),
        message: `kind change: ${describe(c)} was ${b.kind}, now ${c.kind}`,
        symbol: c,
        previous: b,
      });
    }
    // Signature change (only when both surfaces carry signatures —
    // typically when extracted via ts.Program with --with-signatures).
    if (b.signature && c.signature && b.signature !== c.signature) {
      entries.push({
        kind: 'signature-changed',
        severity: 'breaking',
        message: `signature change: ${describe(c)}\n  was: ${b.signature}\n  now: ${c.signature}`,
        symbol: c,
        previous: b,
      });
    }
    // File move within the same package (additive).
    if (b.file !== c.file) {
      entries.push({
        kind: 'moved-file',
        severity: 'additive',
        message: `moved: ${describe(c)} from ${b.file} → ${c.file}`,
        symbol: c,
        previous: b,
      });
    }
  }

  // Cross-package moves (breaking): same name, different package.
  // These appear as `removed` + `added` from the key-based match above.
  // Reclassify them.
  const byNameRemoved = new Map<string, IPublicSymbol>();
  const byNameAdded = new Map<string, IPublicSymbol>();
  for (const e of entries) {
    if (e.kind === 'removed') byNameRemoved.set(e.symbol.name, e.symbol);
    if (e.kind === 'added') byNameAdded.set(e.symbol.name, e.symbol);
  }
  const reclassified: IApiSymbolDiff[] = [];
  for (const e of entries) {
    if (e.kind === 'removed') {
      const counterpart = byNameAdded.get(e.symbol.name);
      if (counterpart && counterpart.package !== e.symbol.package) {
        reclassified.push({
          kind: 'moved-package',
          severity: 'breaking',
          message: `moved package: ${e.symbol.name} from ${e.symbol.package ?? '?'} → ${counterpart.package ?? '?'}`,
          symbol: counterpart,
          previous: e.symbol,
        });
        continue;
      }
    } else if (e.kind === 'added') {
      const counterpart = byNameRemoved.get(e.symbol.name);
      if (counterpart && counterpart.package !== e.symbol.package) {
        // Skip — already represented as moved-package via the removed side.
        continue;
      }
    }
    reclassified.push(e);
  }

  // Sort: breaking first, then additive, then info; tiebreak by name.
  const severityRank: Record<DiffSeverity, number> = { breaking: 0, additive: 1, info: 2 };
  reclassified.sort(
    (a, b) =>
      severityRank[a.severity] - severityRank[b.severity] ||
      a.symbol.name.localeCompare(b.symbol.name),
  );

  const added = reclassified.filter((e) => e.kind === 'added').length;
  const removed = reclassified.filter((e) => e.kind === 'removed').length;
  const changed = reclassified.length - added - removed;
  const breakingCount = reclassified.filter((e) => e.severity === 'breaking').length;

  return {
    schema: API_SURFACE_DIFF_SCHEMA,
    baselineTotal: baseline.total,
    currentTotal: current.total,
    added,
    removed,
    changed,
    breakingCount,
    entries: reclassified,
  };
}

function keyOf(s: IPublicSymbol): string {
  return `${s.package ?? ''}|${s.name}|${s.isDefault ? '1' : '0'}`;
}

function describe(s: IPublicSymbol): string {
  return s.package ? `${s.package}#${s.name} (${s.kind})` : `${s.name} (${s.kind})`;
}

function kindChangeSeverity(from: string, to: string): DiffSeverity {
  // class ↔ function ↔ const are likely breaking; interface ↔ type-alias
  // is usually additive (TS treats them interchangeably for most uses).
  if (from === 'interface' && to === 'type-alias') return 'additive';
  if (from === 'type-alias' && to === 'interface') return 'additive';
  // Re-export wrappers can change kind details for cosmetic reasons.
  if (from === 'unknown' || to === 'unknown') return 'info';
  return 'breaking';
}

// Re-export for callers that only want the kind list.
export type { DiffChangeKind };
