/**
 * THE framework-extractor shape predicate (round 12, 12.1): a string
 * `framework` and `fileMatches` / `extract` functions — one `<field>:
 * <message>` per failing field, `[]` when the shape is accepted. Shared by
 * the runtime loader and the inspector's rejection channel (see
 * `frameworkExtractorExports`), so "invalid extractor shape" has one answer.
 */
export function frameworkExtractorRejectionReasons(value: unknown): readonly string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['(entry): must be an object'];
  const ex = value as Record<string, unknown>;
  const out: string[] = [];
  if (typeof ex.framework !== 'string') out.push('framework: must be a string');
  if (typeof ex.fileMatches !== 'function') out.push('fileMatches: must be a function');
  if (typeof ex.extract !== 'function') out.push('extract: must be a function');
  return out;
}
