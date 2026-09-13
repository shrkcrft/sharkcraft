/**
 * A read-only view over a snapshot's barrel re-export structure — the one
 * transitive barrel-chain follower. Built by `buildReExportIndex`.
 *
 * Consumers: the reference-edge rewriter (`resolveReExportedReferenceEdges`)
 * and the public-surface walk (`enumeratePublicSurface`). Both read THIS, so
 * "where does name N exported by file F really live?" has one answer.
 */
export interface IReExportIndex {
  /** Is there a symbol node with this id? */
  hasSymbol(symbolId: string): boolean;
  /** The re-exports `file` declares, in snapshot edge order. */
  reExportsOf(file: string): readonly {
    /** The EXPOSED name (`export { A as B }` → `B`); `*` for a star. */
    readonly name: string;
    /** The original name in the target module, for a renamed re-export. */
    readonly localName?: string;
    readonly star: boolean;
    /**
     * `export * as ns from` — `name` binds the whole target MODULE. Never
     * followed as a declaration name by {@link resolveName}.
     */
    readonly namespace?: boolean;
    readonly specifier: string;
  }[];
  /** The file a re-export/import specifier in `file` resolved to, when it did. */
  targetOf(file: string, specifier: string): string | undefined;
  /**
   * The import of `specifier` in `file` resolved OUTSIDE the workspace (an npm
   * package or an asset) — as opposed to a local module the index has no file
   * for. False when it resolved to a file, or did not resolve at all.
   */
  isExternalTarget(file: string, specifier: string): boolean;
  /** `file`'s declared default-export name, when identifiable. */
  defaultExportNameOf(file: string): string | undefined;
  /**
   * Follow barrel chains from `file` to the symbol that DECLARES `name`
   * (`default` maps to the file's default-export name). Cycle-safe.
   */
  resolveName(file: string, name: string): string | undefined;
  /** {@link resolveName}, plus the barrel files traversed (the start first; the declaring file excluded). */
  resolveTrace(file: string, name: string): { readonly symbolId: string; readonly via: readonly string[] } | undefined;
  /**
   * Why {@link resolveName} found nothing: the re-export hops, met while
   * following `name` from `file`, whose specifier resolved to no indexed file
   * (classify each with {@link isExternalTarget}). Empty when the name resolves
   * — or when it fails without meeting such a hop (a name no file declares).
   * Same walk as `resolveName`; it never changes what resolves.
   */
  deadEndsOf(file: string, name: string): readonly { readonly file: string; readonly specifier: string }[];
}
