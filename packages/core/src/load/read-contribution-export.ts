import type { IContributionExport } from './i-contribution-export.ts';

/**
 * THE reading of a contribution module's entry list, shared by every registry
 * loader (conventions, helpers, hints, playbooks, constructs, …), so "which
 * list did the loader read, and at which position is each entry" has one
 * answer — the position a rejected entry is reported at.
 *
 * Order: a `default` array; else (unless `singleObject: false`) a single
 * `default` object read as a one-entry list; else the first `namedKeys` array.
 */
export function readContributionExport(
  mod: unknown,
  options: { readonly namedKeys?: readonly string[]; readonly singleObject?: boolean } = {},
): IContributionExport {
  const m = (mod && typeof mod === 'object' ? mod : {}) as Record<string, unknown>;
  const def = m.default;
  if (Array.isArray(def)) return { items: def, exportName: 'default', single: false };
  if (options.singleObject !== false && def && typeof def === 'object') {
    return { items: [def], exportName: 'default', single: true };
  }
  for (const key of options.namedKeys ?? []) {
    const value = m[key];
    if (Array.isArray(value)) return { items: value, exportName: key, single: false };
  }
  return { items: [], exportName: null, single: false };
}
