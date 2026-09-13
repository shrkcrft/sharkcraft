import type { IPublicExport } from '@shrkcrft/core';

/**
 * The code-graph questions the reuse engine asks, INJECTED by the caller (the
 * CLI answers them from `GraphQueryApi`) — the inspector never imports the
 * graph, so the engine stays pure and MCP-callable.
 */
export interface IReuseSymbolLookup {
  /** Every indexed declaration of exactly `name`. */
  declarationsOf(name: string): readonly {
    readonly path: string;
    readonly symbolId: string;
    readonly isExported: boolean;
    readonly line?: number;
    readonly declKind?: string;
  }[];
  /** Real consumer files of a declaration. Optional. */
  consumerCount?(symbolId: string): number;
  /**
   * What `import … from '<specifier>'` binds under the name `symbol`: the
   * specifier resolved the way consumers' imports of it resolved, then walked
   * with the SAME ESM export walk as the public surface — so a default export
   * reads as one (`isDefault`), and a name `export *` does not forward reads as
   * absent. `null` = the module does not export it. `undefined` = no indexed
   * import resolves the specifier, so it could not be checked.
   */
  specifierExport?(
    specifier: string,
    symbol: string,
  ): Pick<IPublicExport, 'symbolId' | 'declaredIn' | 'line' | 'declKind' | 'isDefault'> | null | undefined;
}
