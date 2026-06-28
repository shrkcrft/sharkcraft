/**
 * Heuristic file matchers for knowledge-model rules.
 *
 * The implementation moved DOWN to `@shrkcrft/rules` (`rule-applicability.ts`)
 * so the inspector's `shrk why <file>` can share the exact same per-file rule
 * applicability the bridge uses here — otherwise the two surfaces drift on which
 * rules apply to a file. This module re-exports it for backward compatibility
 * (the bridge builder + the package barrel still import from here).
 */
export { deriveApplicability, type IRuleApplicability } from '@shrkcrft/rules';
