import type { CommandResolutionStatus } from './command-resolution-status.ts';

/**
 * The answer to "does this command string resolve?" — produced by the CLI's
 * command-string resolver and read by every inspector consumer through
 * `resolveCommandReference`.
 */
export interface ICommandResolution {
  readonly status: CommandResolutionStatus;
  /**
   * Nearest real alternatives (full command strings, e.g. `shrk check wiring`
   * or `bun run test`), best first. Present on the unknown-* statuses when
   * something is close enough to suggest.
   */
  readonly closest?: readonly string[];
  /** The proven shrk command path (`check wiring`), when a verb chain matched. */
  readonly matched?: string;
  /** The `&&` / `;` / `|` segment that decided the status, for multi-command strings. */
  readonly segment?: string;
  /** One-line human explanation of the status. */
  readonly reason?: string;
}
