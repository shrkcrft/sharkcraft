/** Options for `rankReuseCandidates`. */
export interface IRankReuseOptions {
  /** Cap on confident results. Default 3. */
  readonly limit?: number;
  /** Cap on did-you-mean suggestions. Default 5. */
  readonly suggestLimit?: number;
  /** Consider type-level exports (interfaces, type aliases). Default false. */
  readonly includeTypes?: boolean;
  /** Ignore the export surface: curated `reusePrimitives[]` only (the pre-round-11 ranking). */
  readonly curatedOnly?: boolean;
  /**
   * Curated symbol → the file its RESOLVED declaration lives in (build it with
   * `curatedDeclarationMap` over `resolveCuratedReuse` — the same map `shrk
   * reuse coverage` excludes by). An export with a curated name declared
   * ELSEWHERE is a different construct and stays a candidate. A name absent
   * from the map is excluded by name alone.
   */
  readonly curatedDeclaredIn?: ReadonlyMap<string, readonly string[]>;
}
