/**
 * A cached original in the Compress-Cache-Retrieve store. Keyed by a
 * deterministic content hash so the same bytes always map to the same entry.
 */
export interface ICcrEntry {
  /** Deterministic content key (see {@link ccrKey}). */
  key: string;
  /** The original, uncompressed text. */
  content: string;
  /** Byte length of {@link content}. */
  bytes: number;
}
