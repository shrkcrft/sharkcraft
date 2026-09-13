import type { IUnitMark } from '@shrkcrft/core';
import type { ISearchTuningKeyProbe } from './i-search-tuning-key-probe.ts';
import { isSearchDocumentPrefix, searchKindForPrefix } from './search-document-id.ts';
import type { ISearchTuningKeyResolution } from './search-tuning-key-resolution.ts';
import { resolveSearchTuningKey } from './search-tuning-key-resolver.ts';
import {
  SEARCH_TUNING_BOOST_IDS,
  searchTuningTaskHintBoostIdsPath,
  type ISearchTuningEntry,
} from './search-tuning-registry.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

/**
 * THE boost-key probes (round 13): every (entry, key) declared in an id boost
 * map, with the maps it sits in, the entry's expectEmpty markers on it, and
 * THE key resolver's answer (resolved once per distinct key). `lintSearchTuning`
 * settles and words them (`search tuning doctor`, the self-config doctor), and
 * `collectUnresolvableReferences` reads them for `packs contributions` — one
 * answer to "could this boost key be checked?".
 *
 * Callers load the entries (`loadSearchTuning`) and warm the reference
 * registries (`warmReferenceRegistries`) first.
 */
export function searchTuningKeyProbes(
  inspection: ISharkcraftInspection,
  entries: readonly ISearchTuningEntry[],
): readonly ISearchTuningKeyProbe[] {
  const resolutions = new Map<string, ISearchTuningKeyResolution>();
  const resolve = (key: string): ISearchTuningKeyResolution => {
    let r = resolutions.get(key);
    if (!r) {
      r = resolveSearchTuningKey(inspection, key);
      resolutions.set(key, r);
    }
    return r;
  };
  const probes: ISearchTuningKeyProbe[] = [];
  for (const e of entries) {
    const ledger = new Map<string, IUnitMark>((e.expectEmptyUnits ?? []).map((m) => [`${m.list} ${m.unit}`, m]));
    const maps: (readonly [string, Readonly<Record<string, number>> | undefined])[] = [
      [SEARCH_TUNING_BOOST_IDS, e.boostIds],
      ...(e.taskHints ?? []).map((h, i) => [searchTuningTaskHintBoostIdsPath(i), h.boostIds] as const),
    ];
    // One probe per (entry, key): the same key in three maps is one declaration
    // (one finding, `declared 3 times`), carrying every map and every marker.
    const byKey = new Map<string, { lists: string[]; marks: IUnitMark[] }>();
    for (const [list, map] of maps) {
      for (const key of Object.keys(map ?? {})) {
        const d = byKey.get(key) ?? { lists: [], marks: [] };
        d.lists.push(list);
        const mark = ledger.get(`${list} ${key}`);
        if (mark) d.marks.push(mark);
        byKey.set(key, d);
      }
    }
    for (const [key, d] of byKey) {
      const resolution = resolve(key);
      const kind =
        resolution.prefix !== undefined && isSearchDocumentPrefix(resolution.prefix)
          ? (searchKindForPrefix(resolution.prefix) ?? resolution.prefix)
          : undefined;
      const excludedKind = kind !== undefined && e.appliesToKinds && !e.appliesToKinds.includes(kind) ? kind : undefined;
      probes.push({
        tuningId: e.id,
        key,
        lists: d.lists,
        marks: d.marks,
        resolution,
        ...(e.appliesToKinds ? { appliesToKinds: e.appliesToKinds } : {}),
        ...(excludedKind !== undefined ? { excludedKind } : {}),
        ...(e.sourceFile ? { sourceFile: e.sourceFile } : {}),
        ...(e.packageName ? { packageName: e.packageName } : {}),
      });
    }
  }
  return probes;
}
