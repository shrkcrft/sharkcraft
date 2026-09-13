/**
 * One construct on a workspace package's PUBLIC export surface — reachable
 * from the package's root entry (the file a bare `import … from '<package>'`
 * resolves to), directly or through a chain of barrel re-exports.
 *
 * Plain data. Produced by `@shrkcrft/graph` (`enumeratePublicSurface` /
 * `GraphQueryApi.publicExportSurface()`); consumed by the inspector's reuse
 * engine, which never imports the graph — the surface is injected.
 */
export interface IPublicExport {
  /**
   * The name a consumer imports — the EXPOSED name (`export { A as B }`
   * exposes `B`). For the package's default export, the declaration's own name
   * (see {@link IPublicExport.isDefault}).
   */
  readonly name: string;
  /** Workspace package whose root entry exposes it. */
  readonly package: string;
  /** The package's root entry file (project-relative, POSIX). */
  readonly entryFile: string;
  /** Project-relative file that declares the construct. */
  readonly declaredIn: string;
  /** 1-based declaration line, when known. */
  readonly line?: number;
  /** Declaration kind as the symbol index records it (`class`, `function`, `interface`, `type-alias`, `const`, …). */
  readonly declKind: string;
  /** Code-graph symbol id of the declaration. */
  readonly symbolId: string;
  /** Barrel files traversed from the entry to the declaring file — entry first, the declaring file excluded. */
  readonly via: readonly string[];
  /** True when this is the package's DEFAULT export (`import X from '<package>'`). */
  readonly isDefault?: boolean;
  /**
   * True for a namespace re-export (`export * as ns from './x'`): the name
   * binds a whole MODULE, not one declaration. `declaredIn` is that module's
   * file, `declKind` is `namespace`, and `symbolId` is the module's FILE node id
   * (there is no declaration symbol to point at).
   */
  readonly namespace?: boolean;
}
