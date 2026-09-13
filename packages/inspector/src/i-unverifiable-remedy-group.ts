/** Unverifiable entries that share a declaring file AND a remedy — one line on every surface. */
export interface IUnverifiableRemedyGroup {
  /** The declaring file, project-relative. */
  readonly source: string;
  /** The entries, in report order. */
  readonly ids: readonly string[];
  /** Their fix; absent for a local TypeScript entry that declares nothing (the heading names `references[]`). */
  readonly remedy?: string;
}
