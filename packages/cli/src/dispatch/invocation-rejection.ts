import type { InvocationRejectionKind } from './invocation-rejection-kind.ts';

/**
 * Why the dispatcher refused an invocation BEFORE any command body ran — an
 * unknown subcommand, a verb-shaped token that is neither a subverb nor an
 * existing file, a flag outside a handler's declared set, or a flag no
 * documentation of the command names.
 */
export interface IInvocationRejection {
  /** The complete stderr text, newline-terminated. */
  readonly message: string;
  /** `usageExitFor(path)`: 3 on a verdict verb, 2 elsewhere. Never 0. */
  readonly exitCode: number;
  /** What was refused — the resolver maps it to a resolution status. */
  readonly kind: InvocationRejectionKind;
  /** The closest real invocations (`shrk templates list`, `shrk gates check --changed-only`), nearest first. */
  readonly closest?: readonly string[];
}
