/**
 * Rule quality doctor.
 *
 * Per-rule quality findings. Reuses `diagnoseActionHints` for the
 * "missing-hints / missing-verification / missing-write-policy" axis,
 * adds findings for:
 *   - vague rules (very short content + no forbiddenActions + no examples)
 *   - missing examples on style/architecture rules
 *   - verificationCommands referencing scripts we cannot resolve
 *   - rules tagged advisory but still missing the `metadata.advisory: true` marker
 *
 * Advisory rules (`metadata.advisory: true`) skip the
 * "missing-verification" warning by design — that is the whole point.
 */
import { hasActionHints, type IKnowledgeEntry } from '@shrkcrft/knowledge';
import { diagnoseActionHints, type IActionHintQualityIssue } from './action-hint-diagnostics.ts';

export const RULE_QUALITY_SCHEMA = 'sharkcraft.rule-quality/v1';

export enum RuleQualityCode {
  MissingHints = 'missing-hints',
  MissingCommandsOrMcp = 'missing-commands-or-mcp',
  MissingForbiddenActions = 'missing-forbidden-actions',
  MissingVerification = 'missing-verification',
  MissingWritePolicy = 'missing-write-policy',
  MissingExamples = 'missing-examples',
  MissingOwner = 'missing-owner',
  Vague = 'vague-rule',
  AdvisoryNotMarked = 'advisory-not-marked',
  AdvisoryHasUnusedVerification = 'advisory-has-unused-verification',
  VerificationReferencesUnknown = 'verification-references-unknown-script',
}

export type RuleQualitySeverity = 'error' | 'warning' | 'info';

export interface IRuleQualityFinding {
  ruleId: string;
  code: RuleQualityCode;
  severity: RuleQualitySeverity;
  message: string;
  /** Suggested next action — either a CLI command or a free-form fix. */
  recommendedFix?: string;
  /** Why this matters — surfaces in the doctor output to fight noise. */
  whyThisMatters: string;
  /** Stable category so suppressions can target the family. */
  category: 'rule-quality';
  advisory: boolean;
}

export interface IRuleQualityReport {
  schema: typeof RULE_QUALITY_SCHEMA;
  generatedAt: string;
  ruleCount: number;
  evaluated: number;
  findings: readonly IRuleQualityFinding[];
  /**
   * ids of rules with no findings — useful for "look at this concise list
   * to see what's healthy" output.
   */
  cleanRules: readonly string[];
  summary: { errors: number; warnings: number; info: number };
}

export interface IRuleQualityOptions {
  /** Limit the report to a single rule id. */
  ruleId?: string;
  /** Treat these rule ids as advisory (overrides metadata). */
  advisoryRuleIds?: readonly string[];
}

const VAGUE_CONTENT_THRESHOLD = 80;

function isAdvisory(rule: IKnowledgeEntry, opts: IRuleQualityOptions): boolean {
  if (opts.advisoryRuleIds?.includes(rule.id)) return true;
  const md = rule.metadata as Record<string, unknown> | undefined;
  return md?.['advisory'] === true;
}

function looksAdvisoryByTag(rule: IKnowledgeEntry): boolean {
  return rule.tags.map((t) => t.toLowerCase()).includes('advisory');
}

function isShapeOrStyleRule(rule: IKnowledgeEntry): boolean {
  const tags = new Set(rule.tags.map((t) => t.toLowerCase()));
  return (
    tags.has('style') ||
    tags.has('shape') ||
    tags.has('architecture') ||
    tags.has('boundaries') ||
    tags.has('imports')
  );
}

function isWriteRelated(rule: IKnowledgeEntry): boolean {
  const tags = new Set(rule.tags.map((t) => t.toLowerCase()));
  return (
    tags.has('safety') ||
    tags.has('generator') ||
    rule.appliesWhen.some((a) => /write|apply|generate/i.test(a))
  );
}

function isCriticalOrHigh(rule: IKnowledgeEntry): boolean {
  const p = String(rule.priority);
  return p === 'critical' || p === 'high';
}

function fromActionHintCode(code: IActionHintQualityIssue['code']): RuleQualityCode {
  switch (code) {
    case 'missing-hints':
      return RuleQualityCode.MissingHints;
    case 'missing-commands-or-mcp':
      return RuleQualityCode.MissingCommandsOrMcp;
    case 'missing-forbidden-actions':
      return RuleQualityCode.MissingForbiddenActions;
    case 'missing-verification':
      return RuleQualityCode.MissingVerification;
    case 'missing-write-policy':
      return RuleQualityCode.MissingWritePolicy;
    case 'missing-related-templates':
      return RuleQualityCode.MissingExamples;
    case 'missing-related-path-conventions':
      return RuleQualityCode.MissingExamples;
  }
}

function whyThisMatters(code: RuleQualityCode): string {
  switch (code) {
    case RuleQualityCode.MissingHints:
      return 'Without actionHints the agent has to guess what to run; the rule cannot drive a deterministic flow.';
    case RuleQualityCode.MissingCommandsOrMcp:
      return 'A high-priority rule with no commands/mcpTools cannot be acted on automatically.';
    case RuleQualityCode.MissingForbiddenActions:
      return 'Rules that ban behaviour need an explicit forbiddenActions list so reviewers know what to look for.';
    case RuleQualityCode.MissingVerification:
      return 'Enforceable rules need a verificationCommands string so `shrk apply --validate` and the agent can check the result.';
    case RuleQualityCode.MissingWritePolicy:
      return 'Write-related rules must declare writePolicy so agents know whether mutation is allowed via MCP/CLI.';
    case RuleQualityCode.MissingExamples:
      return 'Style/shape rules need at least one good or bad example so reviewers and agents understand the pattern.';
    case RuleQualityCode.MissingOwner:
      return 'Long-lived rules without an owner go stale; ownership unblocks future review.';
    case RuleQualityCode.Vague:
      return 'A rule with very short content and no forbiddenActions cannot be enforced or reviewed consistently.';
    case RuleQualityCode.AdvisoryNotMarked:
      return 'Rules tagged "advisory" should set `metadata.advisory: true` so the rule doctor stops asking for verificationCommands.';
    case RuleQualityCode.AdvisoryHasUnusedVerification:
      return 'Advisory rules ship verificationCommands they intend to be aspirational. Mark the rule advisory or move the commands into a real check.';
    case RuleQualityCode.VerificationReferencesUnknown:
      return 'verificationCommands strings should be either standard project scripts (`bun test`, `shrk …`) or live in `sharkcraft.config.ts` — otherwise they bit-rot.';
  }
}

function recommendedFix(code: RuleQualityCode, ruleId: string): string {
  switch (code) {
    case RuleQualityCode.MissingHints:
    case RuleQualityCode.MissingCommandsOrMcp:
    case RuleQualityCode.MissingForbiddenActions:
    case RuleQualityCode.MissingVerification:
    case RuleQualityCode.MissingWritePolicy:
      return `shrk fix preview --action-hints --target ${ruleId}`;
    case RuleQualityCode.MissingExamples:
      return `Add at least one IKnowledgeExample (good and/or bad) to "${ruleId}".`;
    case RuleQualityCode.MissingOwner:
      return `Set source.origin on rule "${ruleId}" so it has a clear owner.`;
    case RuleQualityCode.Vague:
      return `Expand the content of "${ruleId}" with rationale + at least one forbiddenActions entry.`;
    case RuleQualityCode.AdvisoryNotMarked:
      return `Add metadata.advisory = true to "${ruleId}" or remove the "advisory" tag.`;
    case RuleQualityCode.AdvisoryHasUnusedVerification:
      return `Either drop the verificationCommands on "${ruleId}" or move the rule out of advisory.`;
    case RuleQualityCode.VerificationReferencesUnknown:
      return `Reference a project script declared in sharkcraft.config.ts verificationCommands[] from "${ruleId}".`;
  }
}

function commandLooksKnown(cmd: string, knownVerificationIds: ReadonlySet<string>, knownPrefixes: ReadonlyArray<string>): boolean {
  const trimmed = cmd.trim();
  if (trimmed.length === 0) return true; // ignore empty
  if (knownVerificationIds.has(trimmed)) return true;
  for (const p of knownPrefixes) if (trimmed.startsWith(p)) return true;
  return false;
}

export interface IRuleQualityContext {
  /** ids registered in `sharkcraft.config.ts verificationCommands[]`. */
  knownVerificationIds: ReadonlySet<string>;
}

const BUILTIN_KNOWN_PREFIXES: readonly string[] = [
  'shrk ',
  'bun ',
  'npm ',
  'pnpm ',
  'yarn ',
  'node ',
  'tsc ',
  'tsc',
];

export function diagnoseRuleQuality(
  rules: readonly IKnowledgeEntry[],
  options: IRuleQualityOptions = {},
  context: IRuleQualityContext = { knownVerificationIds: new Set() },
): IRuleQualityReport {
  const findings: IRuleQualityFinding[] = [];
  let evaluated = 0;
  const targetRules = options.ruleId ? rules.filter((r) => r.id === options.ruleId) : rules;
  const ruleIdsWithFindings = new Set<string>();

  for (const rule of targetRules) {
    evaluated += 1;
    const advisory = isAdvisory(rule, options);

    // Vague rule: very short content + no examples + no forbidden actions.
    const hasExamples = (rule.examples?.length ?? 0) > 0;
    const hasForbidden = (rule.actionHints?.forbiddenActions?.length ?? 0) > 0;
    if (rule.content.trim().length < VAGUE_CONTENT_THRESHOLD && !hasExamples && !hasForbidden) {
      const code = RuleQualityCode.Vague;
      findings.push({
        ruleId: rule.id,
        code,
        severity: 'warning',
        message: `"${rule.id}" content is short (${rule.content.trim().length} chars) and has no examples or forbiddenActions.`,
        recommendedFix: recommendedFix(code, rule.id),
        whyThisMatters: whyThisMatters(code),
        category: 'rule-quality',
        advisory,
      });
      ruleIdsWithFindings.add(rule.id);
    }

    // Style/shape/architecture rules need at least one example.
    if (isShapeOrStyleRule(rule) && !hasExamples) {
      const code = RuleQualityCode.MissingExamples;
      findings.push({
        ruleId: rule.id,
        code,
        severity: advisory ? 'info' : 'warning',
        message: `"${rule.id}" describes a code shape/style but has no examples.`,
        recommendedFix: recommendedFix(code, rule.id),
        whyThisMatters: whyThisMatters(code),
        category: 'rule-quality',
        advisory,
      });
      ruleIdsWithFindings.add(rule.id);
    }

    // Owner.
    if (isCriticalOrHigh(rule) && !rule.source?.origin) {
      const code = RuleQualityCode.MissingOwner;
      findings.push({
        ruleId: rule.id,
        code,
        severity: 'info',
        message: `"${rule.id}" is high/critical and has no source.origin (owner).`,
        recommendedFix: recommendedFix(code, rule.id),
        whyThisMatters: whyThisMatters(code),
        category: 'rule-quality',
        advisory,
      });
      ruleIdsWithFindings.add(rule.id);
    }

    // Advisory marker mismatch.
    const md = rule.metadata as Record<string, unknown> | undefined;
    const explicitAdvisory = md?.['advisory'] === true;
    if (looksAdvisoryByTag(rule) && !explicitAdvisory) {
      const code = RuleQualityCode.AdvisoryNotMarked;
      findings.push({
        ruleId: rule.id,
        code,
        severity: 'warning',
        message: `"${rule.id}" is tagged "advisory" but does not set metadata.advisory = true.`,
        recommendedFix: recommendedFix(code, rule.id),
        whyThisMatters: whyThisMatters(code),
        category: 'rule-quality',
        advisory: false,
      });
      ruleIdsWithFindings.add(rule.id);
    }
    if (advisory && (rule.actionHints?.verificationCommands?.length ?? 0) > 0) {
      const code = RuleQualityCode.AdvisoryHasUnusedVerification;
      findings.push({
        ruleId: rule.id,
        code,
        severity: 'info',
        message: `"${rule.id}" is advisory but ships verificationCommands; agents will not auto-run them.`,
        recommendedFix: recommendedFix(code, rule.id),
        whyThisMatters: whyThisMatters(code),
        category: 'rule-quality',
        advisory: true,
      });
      ruleIdsWithFindings.add(rule.id);
    }

    // verificationCommands references unknown scripts.
    const verificationCmds = rule.actionHints?.verificationCommands ?? [];
    for (const cmd of verificationCmds) {
      if (!commandLooksKnown(cmd, context.knownVerificationIds, BUILTIN_KNOWN_PREFIXES)) {
        const code = RuleQualityCode.VerificationReferencesUnknown;
        findings.push({
          ruleId: rule.id,
          code,
          severity: 'info',
          message: `"${rule.id}" references unknown verification command "${cmd}".`,
          recommendedFix: recommendedFix(code, rule.id),
          whyThisMatters: whyThisMatters(code),
          category: 'rule-quality',
          advisory,
        });
        ruleIdsWithFindings.add(rule.id);
      }
    }

    // Defer the actionHints axis to the existing diagnostic engine for the
    // overlapping codes. We don't double-report: only emit if not vague AND
    // not advisory (advisory rules opt out of verificationCommands by
    // design). For non-write-related rules we skip missing-write-policy.
    const hintReport = diagnoseActionHints([rule]);
    const writeRelated = isWriteRelated(rule);
    for (const issue of hintReport.issues) {
      // Skip write-policy when the rule isn't actually write-related — the
      // upstream diagnostic is permissive about tag matching, but we want
      // the rule doctor to be precise.
      if (issue.code === 'missing-write-policy' && !writeRelated) continue;
      // Advisory rules opt out of verification / commands / forbidden axes.
      if (advisory && (issue.code === 'missing-verification' || issue.code === 'missing-commands-or-mcp' || issue.code === 'missing-forbidden-actions' || issue.code === 'missing-hints')) {
        continue;
      }
      const code = fromActionHintCode(issue.code);
      // Avoid duplicating "missing-examples" coming from action-hints
      // (related-templates / related-path-conventions); only keep the
      // explicit one we already emitted above.
      if (code === RuleQualityCode.MissingExamples) continue;
      findings.push({
        ruleId: rule.id,
        code,
        severity: 'warning',
        message: issue.message,
        recommendedFix: recommendedFix(code, rule.id),
        whyThisMatters: whyThisMatters(code),
        category: 'rule-quality',
        advisory,
      });
      ruleIdsWithFindings.add(rule.id);
    }

    // Hint that high-priority rules without any actionHints are still
    // a problem even when they don't match the writeRelated heuristic.
    if (!advisory && isCriticalOrHigh(rule) && !hasActionHints(rule)) {
      // already covered by diagnoseActionHints, but defensive:
      const alreadyHas = findings.some(
        (f) => f.ruleId === rule.id && f.code === RuleQualityCode.MissingHints,
      );
      if (!alreadyHas) {
        const code = RuleQualityCode.MissingHints;
        findings.push({
          ruleId: rule.id,
          code,
          severity: 'warning',
          message: `"${rule.id}" is high/critical but has no actionHints at all.`,
          recommendedFix: recommendedFix(code, rule.id),
          whyThisMatters: whyThisMatters(code),
          category: 'rule-quality',
          advisory,
        });
        ruleIdsWithFindings.add(rule.id);
      }
    }
  }

  const summary = {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };

  const cleanRules = targetRules.filter((r) => !ruleIdsWithFindings.has(r.id)).map((r) => r.id);

  return {
    schema: RULE_QUALITY_SCHEMA,
    generatedAt: new Date().toISOString(),
    ruleCount: rules.length,
    evaluated,
    findings,
    cleanRules,
    summary,
  };
}

export function renderRuleQualityText(report: IRuleQualityReport): string {
  const lines: string[] = [];
  lines.push('=== Rule quality doctor ===');
  lines.push(`  rules     ${report.ruleCount}`);
  lines.push(`  evaluated ${report.evaluated}`);
  lines.push(`  errors    ${report.summary.errors}`);
  lines.push(`  warnings  ${report.summary.warnings}`);
  lines.push(`  info      ${report.summary.info}`);
  lines.push('');
  if (report.findings.length === 0) {
    lines.push('No rule-quality issues. ✓');
    return lines.join('\n') + '\n';
  }
  const byRule = new Map<string, IRuleQualityFinding[]>();
  for (const f of report.findings) {
    const list = byRule.get(f.ruleId) ?? [];
    list.push(f);
    byRule.set(f.ruleId, list);
  }
  for (const [ruleId, list] of byRule) {
    const advisoryTag = list[0]?.advisory ? ' [advisory]' : '';
    lines.push(`• ${ruleId}${advisoryTag}`);
    for (const f of list) {
      lines.push(`    ${f.severity.padEnd(7)} ${f.code} — ${f.message}`);
      lines.push(`            why: ${f.whyThisMatters}`);
      if (f.recommendedFix) lines.push(`            fix: ${f.recommendedFix}`);
    }
    lines.push('');
  }
  if (report.cleanRules.length > 0) {
    lines.push(`Clean rules (${report.cleanRules.length}): ${report.cleanRules.slice(0, 8).join(', ')}${report.cleanRules.length > 8 ? ' …' : ''}`);
  }
  return lines.join('\n') + '\n';
}
