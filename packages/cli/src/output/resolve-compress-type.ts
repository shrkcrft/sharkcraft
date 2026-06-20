import { EContentType } from '@shrkcrft/compress';

/** The valid `--compress-type` values: the EContentType wire strings. */
const VALID_TYPES: ReadonlySet<string> = new Set<string>(Object.values(EContentType));

/** Outcome of resolving a raw `--compress-type` string. */
export interface IResolvedCompressType {
  /** The forced content type — set only when the raw value named a valid one. */
  type?: EContentType;
  /**
   * A user-facing warning, set when the raw value was non-empty but
   * unrecognized. The caller surfaces it (on stderr) so an explicit-but-typo'd
   * `--compress-type` is reported rather than silently dropped.
   */
  warning?: string;
}

/**
 * Resolve a raw `--compress-type` flag value into a forced {@link EContentType}.
 *
 * An unrecognized, non-empty value is NOT silently ignored (the old behavior):
 * it yields a `warning` listing the valid types, so the caller can tell the
 * user their explicit choice was dropped before falling back to auto-detection.
 * A missing or empty value is a no-op (auto-detect, no warning).
 */
export function resolveCompressType(raw: string | undefined): IResolvedCompressType {
  if (raw === undefined || raw === '') return {};
  if (VALID_TYPES.has(raw)) return { type: raw as EContentType };
  const valid = [...VALID_TYPES].sort().join(', ');
  return {
    warning: `--compress: unknown --compress-type "${raw}"; auto-detecting instead. Valid types: ${valid}.`,
  };
}
