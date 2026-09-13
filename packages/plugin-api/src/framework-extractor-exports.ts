/**
 * THE reading of a pack `frameworkExtractorFiles` module: every candidate
 * extractor it exports, with where it came from — a `default` array (each
 * member at its index), a single `default` object, a named `extractor`, and a
 * named `extractors` array, in that order.
 *
 * Shared by the runtime loader (`loadPackExtractors`, @shrkcrft/framework-
 * scanners) and the inspector's rejection channel, which cannot import that
 * loader (framework-scanners sits above it via @shrkcrft/graph). One reading,
 * so both refuse the same candidates at the same positions (round 12, 12.1).
 */
export function frameworkExtractorExports(
  mod: unknown,
): readonly { readonly exportName: string; readonly index: number; readonly value: unknown }[] {
  const m = (mod && typeof mod === 'object' ? mod : {}) as Record<string, unknown>;
  const out: { exportName: string; index: number; value: unknown }[] = [];
  const def = m.default;
  if (Array.isArray(def)) def.forEach((value, index) => out.push({ exportName: 'default', index, value }));
  else if (def && typeof def === 'object') out.push({ exportName: 'default', index: -1, value: def });
  if (m.extractor) out.push({ exportName: 'extractor', index: -1, value: m.extractor });
  if (Array.isArray(m.extractors)) {
    m.extractors.forEach((value, index) => out.push({ exportName: 'extractors', index, value }));
  }
  return out;
}
