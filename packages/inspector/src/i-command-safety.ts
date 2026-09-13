import type { commandSafetyLevel } from './command-safety-level.ts';

/**
 * A command's DECLARED safety: its catalog row's `safetyLevel`, and whether it
 * writes source by the catalog's own audit predicate (`writesSource ||
 * safetyLevel === writes-source`). The CLI builds it from COMMAND_CATALOG and
 * injects it into the ranker; the regex `commandSafetyLevel` is only the
 * fallback where no catalog is available.
 */
export interface ICommandSafety {
  readonly safetyLevel: ReturnType<typeof commandSafetyLevel>;
  readonly writesSource: boolean;
}
