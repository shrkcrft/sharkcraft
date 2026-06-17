/**
 * Knobs for the SmartCrusher row-sampler. All optional; defaults are
 * deterministic. The sampler keeps representative rows (anchors / outliers /
 * query matches / one-per-dedup-class) and drops the rest, recording why.
 */
export interface ISampleOptions {
  /** Hard cap on KEPT rows. Default 200. */
  maxItems?: number;
  /** Rows kept from each of the front and back. Default 8. */
  anchors?: number;
  /** Numeric column to rank outliers on; auto-picked (highest variance) if omitted. */
  outlierField?: string;
  /** Extreme rows kept per tail (min side + max side). Default 8. */
  outliers?: number;
  /** Query whose tokens force-keep matching rows (up to `matches`). */
  query?: string;
  /** Max query-matched rows to force-keep. Default 16. */
  matches?: number;
  /** Collapse byte-identical rows to one representative (earliest). Default true. */
  dedup?: boolean;
  /**
   * When no explicit `maxItems` is given, the cap is chosen adaptively from the
   * data's information curve (P3.1). `bias` shifts that knee: keep more
   * (`conservative`) or fewer (`aggressive`). Default `moderate`. Ignored when
   * `maxItems` is set.
   */
  bias?: 'conservative' | 'moderate' | 'aggressive';
}
