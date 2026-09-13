/**
 * A boundary rule (or a whole rule file) that was configured but could not be
 * evaluated — round 11, 1.3#boundary-invalid-rule.
 *
 * The loader used to turn each of these into a warning string that no boundary
 * surface rendered, so `check boundaries` reported green over a fence that had
 * just vanished. As structured records they become ERRORED rules on every
 * surface (`check boundaries`, finish, both MCP tools): never evaluated, never
 * silent, exit 1.
 */
export interface IBoundaryLoadIssue {
  /** The rule file — project-relative when inside the project, else absolute. */
  readonly file: string;
  /**
   *   - `invalid-rule` — one rule failed validation and was dropped;
   *   - `load-error`   — the file threw on import, timed out, or exported no rule array;
   *   - `missing-file` — `boundaryFiles` lists a file that does not exist.
   */
  readonly kind: 'invalid-rule' | 'load-error' | 'missing-file';
  readonly origin: 'local' | 'pack' | 'rule-file';
  /** The contributing pack, for `origin: 'pack'`. */
  readonly packageName?: string;
  /** The rule's id, when an invalid rule had a string one. */
  readonly ruleId?: string;
  /** Position in the file's rule array, for `invalid-rule`. */
  readonly index?: number;
  /** One line per problem (`title: title required`, or the loader's message). */
  readonly issues: readonly string[];
}
