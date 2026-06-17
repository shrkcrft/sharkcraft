/**
 * Matches a CCR retrieval marker: `<<ccr:KEY>>` or `<<ccr:KEY note text>>`.
 * The key is the hex content hash; the optional note is a short human hint
 * (e.g. `42 rows offloaded`). Global + multiline so a scan finds every marker
 * in a blob.
 */
export const CCR_MARKER_RE = /<<ccr:([0-9a-f]{8,})(?:\s+([^>]*?))?>>/g;

/** A parsed CCR marker found inside a compressed blob. */
export interface ICcrMarkerRef {
  /** Content key to retrieve. */
  key: string;
  /** Optional human hint that accompanied the marker. */
  note?: string;
}

/**
 * Render a retrieval marker. Callers embed this in compressed output wherever
 * detail was dropped; an agent that wants the original calls
 * `retrieve_original` / `shrk expand` with {@link key}.
 */
export function formatCcrMarker(key: string, note?: string): string {
  // Strip `>` from the note so an embedded `>>` can't prematurely close the
  // marker (format → parse must round-trip for any note the formatter accepts).
  const trimmed = note?.trim().replace(/>/g, '');
  return trimmed ? `<<ccr:${key} ${trimmed}>>` : `<<ccr:${key}>>`;
}

/** Extract every CCR marker from a blob, in order of appearance. */
export function parseCcrMarkers(text: string): ICcrMarkerRef[] {
  const out: ICcrMarkerRef[] = [];
  for (const match of text.matchAll(CCR_MARKER_RE)) {
    const key = match[1];
    if (!key) continue;
    const note = match[2]?.trim();
    out.push(note ? { key, note } : { key });
  }
  return out;
}
