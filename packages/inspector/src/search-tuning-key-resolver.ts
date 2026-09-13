/**
 * THE resolver for search-tuning boost keys.
 *
 * A boost key is a search-document id, `<kind>:<id>` — the matcher
 * (`tuningBoostFor`) compares `boostIds[doc.id]` against the WHOLE document id.
 * The self-config doctor used to look that whole prefixed key up in BARE-id
 * registries, so every correctly prefixed key (which fires) was reported
 * "unknown", and a bare key (which can never fire) passed. On a healthy pack
 * that was 200 false warnings inviting the deletion of correct config, and on
 * shrk itself it certified 33 dead entries.
 *
 * The key is split on its FIRST `:` by THE codec (`search-document-id.ts`), and
 * the right-hand id is resolved WITHIN the named kind through THE id resolver
 * (`reference-registry.ts`). Callers must `warmReferenceRegistries` first.
 */
import { nearestIds } from './nearest-id.ts';
import {
  emptyReferenceKinds,
  referenceIdExists,
  referenceIdsFor,
  referenceKindOf,
  type ReferenceKind,
} from './reference-registry.ts';
import {
  isSearchDocumentPrefix,
  parseSearchDocumentId,
  SEARCH_DOCUMENT_ID_KINDS,
  SEARCH_DOCUMENT_PREFIXES,
  searchDocumentId,
} from './search-document-id.ts';
import type { ISearchTuningKeyResolution } from './search-tuning-key-resolution.ts';
import { SearchTuningKeyStatus } from './search-tuning-key-status.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

/** Every prefixed key a BARE id resolves as, with the kind it resolved in, in prefix order. */
function prefixedFormsOf(
  inspection: ISharkcraftInspection,
  bareId: string,
): { readonly key: string; readonly kind: ReferenceKind }[] {
  const out: { readonly key: string; readonly kind: ReferenceKind }[] = [];
  for (const prefix of SEARCH_DOCUMENT_PREFIXES) {
    const kind = SEARCH_DOCUMENT_ID_KINDS[prefix];
    if (kind !== null && referenceIdExists(inspection, kind, bareId)) {
      out.push({ key: searchDocumentId(prefix, bareId), kind });
    }
  }
  return out;
}

export function resolveSearchTuningKey(
  inspection: ISharkcraftInspection,
  key: string,
): ISearchTuningKeyResolution {
  const parsed = parseSearchDocumentId(key);
  if (parsed && isSearchDocumentPrefix(parsed.prefix)) {
    const { prefix, id } = parsed;
    const kind = SEARCH_DOCUMENT_ID_KINDS[prefix];
    if (kind === null) {
      return {
        key,
        status: SearchTuningKeyStatus.Unverified,
        prefix,
        id,
        reason: `\`${prefix}:\` documents have no id registry, so "${id}" cannot be checked`,
      };
    }
    if (emptyReferenceKinds(inspection, [kind]).length > 0) {
      return {
        key,
        status: SearchTuningKeyStatus.Unverified,
        prefix,
        id,
        referenceKind: kind,
        reason: `no ${kind} is registered in this workspace (or its registry did not load), so "${id}" cannot be checked`,
      };
    }
    if (referenceIdExists(inspection, kind, id)) {
      return { key, status: SearchTuningKeyStatus.Resolved, prefix, id, referenceKind: kind };
    }
    const near = nearestIds(id, referenceIdsFor(inspection, kind), 1)[0];
    return {
      key,
      status: SearchTuningKeyStatus.Missing,
      prefix,
      id,
      referenceKind: kind,
      ...(near ? { suggestion: searchDocumentId(prefix, near.id) } : {}),
    };
  }
  // Not `<known prefix>:<id>`. A WHOLE key that resolves as a bare id is the
  // common mistake: it reads right and never fires.
  const forms = prefixedFormsOf(inspection, key);
  if (forms.length > 0) {
    return {
      key,
      status: SearchTuningKeyStatus.Unprefixed,
      id: key,
      // The kind the bare id DID resolve in (the field's contract: "the
      // registry the id was resolved in"). Without it a consumer labelling the
      // target had nothing but `unknown` for an id that exists (round 12, 12.4).
      referenceKind: forms[0]!.kind,
      suggestion: forms[0]!.key,
      ...(forms.length > 1 ? { suggestions: forms.map((f) => f.key) } : {}),
    };
  }
  if (parsed) {
    const near = nearestIds(parsed.prefix, SEARCH_DOCUMENT_PREFIXES, 1)[0];
    return {
      key,
      status: SearchTuningKeyStatus.UnknownKind,
      prefix: parsed.prefix,
      id: parsed.id,
      ...(near ? { suggestion: `${near.id}:${parsed.id}` } : {}),
      reason: `"${parsed.prefix}" is not a search-document kind (${SEARCH_DOCUMENT_PREFIXES.join(', ')})`,
    };
  }
  // Registered — but as a kind the search index never emits (a decision, a
  // policy, a scaffold pattern): no boost key can target it at all.
  const registeredAs = referenceKindOf(inspection, key);
  return {
    key,
    status: SearchTuningKeyStatus.Unprefixed,
    id: key,
    ...(registeredAs ? { referenceKind: registeredAs } : {}),
    reason: registeredAs
      ? `"${key}" is a registered ${registeredAs}, but ${registeredAs} entries are not search documents, so no boost key can target it`
      : 'it has no `<kind>:` prefix, and no registry lists it as a bare id either',
  };
}
