import type { IPackHelperOperationInput } from '@shrkcrft/plugin-api';

/**
 * One helper as every helper surface shows it — built-in (`HELPERS`) and
 * pack/local-contributed (`helperFiles[]`) alike. `helper list|get|plan|doctor`
 * and the MCP helper tools all read this one shape from `listAllHelpers`, so
 * "which helpers exist" has one answer.
 */
export interface IHelperView {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Where the helper came from. */
  readonly source: 'builtin' | 'local' | 'pack' | 'fixture';
  readonly packageName?: string;
  /** Pack-relative (pack) or project-relative (local) file the helper was loaded from. */
  readonly sourceFile?: string;
  /** From `safety.destructivePotential` (pack) / `destructive` (builtin). */
  readonly destructive: boolean;
  readonly requiresHumanReview: boolean;
  readonly requiresProfile: boolean;
  readonly outputKind: 'preview' | 'plan' | 'checklist';
  readonly variables: readonly {
    readonly name: string;
    readonly required: boolean;
    readonly description: string;
    readonly defaultValue?: string;
  }[];
  /** Declarative operations (pack helpers); empty for builtins. */
  readonly operations: readonly IPackHelperOperationInput[];
  readonly manualChecklist: readonly string[];
  readonly tags: readonly string[];
}
