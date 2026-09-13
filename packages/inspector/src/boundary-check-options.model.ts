import type { IBoundaryRule, IImportScanResult } from '@shrkcrft/boundaries';
import type { ChangedScopeMode, IChangedScopeOptions } from './boundaries-changed-only.ts';
import type { IBoundaryLoadIssue } from './boundary-load-issue.model.ts';

/** Inputs to `runBoundaryCheck` — every boundary surface passes the same ones. */
export interface IRunBoundaryCheckOptions {
  /** `--rule <id>`: evaluate only this rule. An unknown id is a usage error (exit 3). */
  readonly onlyRuleId?: string;
  /**
   * `--rule-file <path>`: evaluate ONLY these rules (loaded by the CLI through
   * the same loader `boundaryFiles` use). Never reachable from MCP — loading a
   * rule file executes it.
   */
  readonly ruleFile?: {
    readonly path: string;
    readonly rules: readonly IBoundaryRule[];
    readonly loadIssues?: readonly IBoundaryLoadIssue[];
  };
  /** Changed-scope mode: report violations the changeset introduced (plus escalated rules). */
  readonly changedScope?: IChangedScopeOptions;
  /** A changed-file set the caller already resolved (finish). Takes precedence over `changedScope` resolution. */
  readonly changed?: { readonly mode: ChangedScopeMode; readonly files: readonly string[] };
  /** Read imports from raw text, comments included (`--include-comments`). */
  readonly includeComments?: boolean;
  /**
   * Escalate rules whose definition the changeset touched (default `true`).
   * `false` (`--no-rule-escalation`) keeps them out — and the run then reports
   * those rules UNEXAMINED, so it can never read as a pass.
   */
  readonly escalate?: boolean;
  /** `--fail-on-dead-units`: a dead selector unit fails the run (1). */
  readonly failOnDeadUnits?: boolean;
  /** `--strict`: warning-severity violations fail too. */
  readonly strict?: boolean;
  /** Reuse an existing scan (the rule-set diff scans once for both sides). */
  readonly scan?: IImportScanResult;
}
