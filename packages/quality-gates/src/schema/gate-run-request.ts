import type { ISharkcraftInspection } from '@shrkcrft/inspector';
import type { IApiDiffGateOptions } from '../gates/api-diff-gate.ts';

/**
 * What a caller asks the quality-gate aggregator to run — `shrk gate`'s flags,
 * or MCP `get_quality_gate`'s input. `prepareQualityGateRun` turns it into the
 * one `IRunGatesOptions` both surfaces run.
 */
export interface IGateRunRequest {
  readonly cwd: string;
  /** `--since <ref>`: drives the impact gate AND scopes wiring / policy / knowledge-symbol to the diff. */
  readonly sinceRef?: string;
  /** `--changed-only` (tracked + untracked worktree). */
  readonly changedOnly?: boolean;
  /** `--staged`. */
  readonly staged?: boolean;
  /** `--files a,b`. */
  readonly files?: readonly string[];
  /** `--fail-on high,critical` for the impact gate; absent = advisory (`[]`). */
  readonly failOn?: readonly ('high' | 'critical')[];
  /** `--arch-all`: fail on TOTAL architecture errors, ignoring the frozen baseline. */
  readonly archAll?: boolean;
  /** Gate ids to skip. */
  readonly disable?: readonly string[];
  /** `--api-baseline` opts the api-diff gate in. */
  readonly apiDiff?: IApiDiffGateOptions;
  /**
   * An inspection already loaded (MCP's `ctx.inspection`) for the
   * knowledge-symbol gate. When omitted and the gate is enabled, one is built.
   */
  readonly inspection?: ISharkcraftInspection;
}
