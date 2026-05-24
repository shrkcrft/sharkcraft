/**
 * Project-specific architecture contract.
 *
 * Declarative DSL — no executable predicates. Authors call
 * `defineArchContract(...)` (or hand-write the same shape) and pass
 * the result to `runArchCheck({ contract })` or save it as
 * `sharkcraft/arch.ts` for auto-discovery.
 *
 * Schema: sharkcraft.arch-contract/v1.
 */
export const ARCH_CONTRACT_SCHEMA = 'sharkcraft.arch-contract/v1' as const;

export interface IArchLayer {
  name: string;
  /** Glob patterns (matched against project-relative file paths). */
  includes: readonly string[];
}

export type ContractSeverity = 'error' | 'warning' | 'info';

export interface IArchRule {
  /** Source layer name (from `layers`). */
  from: string;
  /** Layers the source MAY import from. */
  mayImport?: readonly string[];
  /** Layers the source MAY NOT import from. */
  mayNotImport?: readonly string[];
  /** Severity when a violation is detected. Default 'error'. */
  severity?: ContractSeverity;
  /** Optional explanation shown in the violation. */
  reason?: string;
}

export interface IArchContract {
  schema: typeof ARCH_CONTRACT_SCHEMA;
  /** Optional contract id. */
  id?: string;
  /** Optional human title. */
  title?: string;
  /** Layer declarations. Order is irrelevant. */
  layers: readonly IArchLayer[];
  /** Rules among layers. */
  rules: readonly IArchRule[];
}
