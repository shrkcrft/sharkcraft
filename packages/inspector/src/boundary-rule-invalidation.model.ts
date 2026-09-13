/**
 * Which boundary rules a changeset INVALIDATED — round 11, 6.3 / closing#d.
 *
 * A `--changed-only` run filters violations to the changed files, which by
 * construction cannot see a change to the rules themselves: tightening a rule
 * creates violations only in files nobody touched. When the changeset touches
 * a rule's definition (or the config, or the alias map every rule is evaluated
 * under), those rules are ESCALATED — every violation they produce is reported,
 * whatever its file. Stateless on purpose: the diff itself is the signal, so it
 * works on a fresh CI checkout where a persisted rule-set hash has no previous
 * value.
 */
export interface IBoundaryRuleInvalidation {
  /** Rules whose violations are all new to this changeset. */
  readonly escalatedRuleIds: readonly string[];
  /** Why, one entry per changed file that triggered escalation. */
  readonly reasons: readonly {
    /** Project-relative path of the changed file. */
    readonly file: string;
    /**
     *   - `rule-source` — a file that defines boundary rules (escalates those rules);
     *   - `config`      — sharkcraft.config.ts (escalates every rule);
     *   - `tsconfig`    — tsconfig.json / tsconfig.base.json, the alias map (every rule);
     *   - `manifest`    — a root package.json / lockfile, or a file inside a pack (that pack's rules);
     *   - `rule-file`   — a `--rule-file` candidate (every candidate rule is new by definition).
     */
    readonly kind: 'rule-source' | 'config' | 'tsconfig' | 'manifest' | 'rule-file';
    readonly ruleIds: readonly string[];
  }[];
}
