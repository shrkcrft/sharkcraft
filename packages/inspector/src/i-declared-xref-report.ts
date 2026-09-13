import type { IDeclaredXrefIssue } from './i-declared-xref-issue.ts';
import type { IDeclaredXrefRow } from './i-declared-xref-row.ts';
import type { ReferenceKind } from './reference-registry.ts';

/**
 * Every declared cross-reference id in the workspace, resolved — the answer
 * the self-config doctor, `self-config broken-links`, `packs doctor`, `templates
 * drift`, `knowledge remove` and `shrk quality` all read.
 */
export interface IDeclaredXrefReport {
  readonly schema: 'sharkcraft.declared-xrefs/v1';
  /** One row per (source, field, id) — ok ones included, so `examined` is visible. */
  readonly rows: readonly IDeclaredXrefRow[];
  readonly issues: readonly IDeclaredXrefIssue[];
  readonly counts: Readonly<{
    ids: number;
    ok: number;
    dangling: number;
    wrongKind: number;
    unverified: number;
    /** Error-severity dangling / wrong-kind rows plus error issues. */
    errors: number;
    /** Warning-severity dangling / wrong-kind rows plus warning issues. */
    warnings: number;
  }>;
  /** What the collector looked at — zero coverage must be visible, never a silent pass. */
  readonly examined: Readonly<{
    /** Assets walked (every knowledge entry, construct, boundary rule and template). */
    sources: number;
    sourcesByKind: Readonly<Record<string, number>>;
    /** Declared ids resolved (= rows.length). */
    ids: number;
    /** Distinct `<sourceKind>.<field>` that declared at least one id. */
    fields: number;
    byField: Readonly<Record<string, Readonly<{ ids: number; dangling: number; wrongKind: number; unverified: number }>>>;
    /** Facet values with no `resolvesAs` — free-form, counted but not validated. */
    facetValuesUndeclared: number;
    /** True when the async registries were warmed before collecting. */
    cacheWarm: boolean;
    /** Source kinds that could not be enumerated (constructs, on a cold cache). */
    unreadSources: readonly ReferenceKind[];
  }>;
}
