/**
 * The pack that contributed an asset — the provenance a `root: pack`
 * reference resolves against (round 15 follow-up, F7).
 */
export interface IReferencePackOrigin {
  /** The pack's published package name. */
  readonly packageName: string;
  /** Absolute path of the pack's package directory, as pack discovery resolved it. */
  readonly packageRoot: string;
  /** {@link packageRoot} relative to the project root (`node_modules/@x/y`) — what rows print. */
  readonly displayRoot: string;
}
