/**
 * Rule enforcement classification.
 *
 * Answers the question maintainers can't otherwise answer: "which rules
 * are actually enforced, and which are aspirational documentation?"
 *
 * The classification is deterministic — derived from each rule's
 * `actionHints.verificationCommands`, the project's
 * `sharkcraft.config.ts verificationCommands[]`, and existing drift
 * (stale references) signals. No AI; no probabilistic scoring.
 */
import { KnowledgeType, type IKnowledgeEntry } from '@shrkcrft/knowledge';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const RULE_DRIFT_SCHEMA = 'sharkcraft.rule-drift/v1';

export enum RuleEnforcementState {
  Enforced = 'enforced',
  PartiallyEnforced = 'partially-enforced',
  ManualOnly = 'manual-only',
  Aspirational = 'aspirational',
  Stale = 'stale',
  Unknown = 'unknown',
}

export interface IRuleDriftEntry {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly priority: string;
  readonly state: RuleEnforcementState;
  /** Short, deterministic reason for the classification. */
  readonly reason: string;
  /** Verification commands declared on the rule. */
  readonly declaredVerificationCommands: readonly string[];
  /** Verification commands that are wired in `sharkcraft.config.ts`. */
  readonly enforcedVerificationCommands: readonly string[];
  /** True if the rule declares CLI/MCP action hints (used for ManualOnly). */
  readonly hasActionHints: boolean;
  /** True if the rule is `advisory:true` in its action hints / definition. */
  readonly advisory: boolean;
  /** Source: local file vs. pack name. */
  readonly source: { readonly type: 'local' | 'pack'; readonly packageName?: string };
}

export interface IRuleDriftReport {
  readonly schema: typeof RULE_DRIFT_SCHEMA;
  readonly generatedAt: string;
  readonly entries: readonly IRuleDriftEntry[];
  readonly summary: Readonly<Record<RuleEnforcementState, number>>;
  /** Rule ids the caller can copy-paste into focus filters. */
  readonly nextCommands: readonly string[];
}

/**
 * The set of verification references a rule can match against to count as
 * "wired" in `sharkcraft.config.ts`. A rule declares its verification commands
 * as runnable command strings (e.g. `bun test`), while the config declares
 * them as `{ id, command }` records (e.g. `{ id: 'unit-tests', command: 'bun
 * test' }`). A rule is enforced when its declared command matches the config
 * BY id OR BY command string, so we collect both — otherwise a rule that ships
 * a genuinely-runnable, genuinely-wired command (matching by `command`) is
 * mis-classified as unenforced just because it doesn't reference the config's
 * short id.
 */
function configuredVerificationRefs(
  inspection: ISharkcraftInspection,
): ReadonlySet<string> {
  const cfg = inspection.config as
    | { verificationCommands?: ReadonlyArray<{ id?: string; command?: string }> }
    | null;
  const refs = new Set<string>();
  for (const entry of cfg?.verificationCommands ?? []) {
    if (entry?.id) refs.add(entry.id.trim());
    if (entry?.command) refs.add(entry.command.trim());
  }
  return refs;
}

function isRule(entry: IKnowledgeEntry): boolean {
  return entry.type === KnowledgeType.Rule;
}

function hasMeaningfulActionHints(entry: IKnowledgeEntry): boolean {
  const a = entry.actionHints;
  if (!a) return false;
  return Boolean(
    (a.commands && a.commands.length) ||
      (a.mcpTools && a.mcpTools.length) ||
      (a.forbiddenActions && a.forbiddenActions.length) ||
      (a.preferredFlow && a.preferredFlow.length),
  );
}

function isAdvisory(entry: IKnowledgeEntry): boolean {
  const flagged = (entry as unknown as { advisory?: boolean }).advisory === true;
  if (flagged) return true;
  // Some packs encode advisory state through priority='low' + no verification.
  return entry.priority === 'low' && !hasMeaningfulActionHints(entry);
}

function staleReason(entry: IKnowledgeEntry, inspection: ISharkcraftInspection): string | null {
  // Re-use the validation issues attached to the inspection — anything
  // matching this entry id (broken anchor / missing reference / etc.) makes
  // the rule stale.
  for (const issue of inspection.validationIssues) {
    if (issue.entryId === entry.id && issue.severity === 'error') {
      return issue.message;
    }
  }
  return null;
}

export function classifyRuleDrift(
  inspection: ISharkcraftInspection,
): IRuleDriftReport {
  const wiredRefs = configuredVerificationRefs(inspection);
  const entries: IRuleDriftEntry[] = [];

  for (const entry of inspection.knowledgeEntries) {
    if (!isRule(entry)) continue;
    const declared = entry.actionHints?.verificationCommands ?? [];
    // A declared command counts as enforced when it is wired in the config
    // BY id OR BY command string (the config carries both).
    const enforced = declared.filter((ref) => wiredRefs.has(ref.trim()));

    const advisory = isAdvisory(entry);
    const stale = staleReason(entry, inspection);
    const hasHints = hasMeaningfulActionHints(entry);

    let state: RuleEnforcementState;
    let reason: string;
    if (stale) {
      state = RuleEnforcementState.Stale;
      reason = `stale reference: ${stale}`;
    } else if (advisory) {
      state = RuleEnforcementState.Aspirational;
      reason = 'advisory rule — no enforcement expected';
    } else if (declared.length > 0 && enforced.length === declared.length) {
      state = RuleEnforcementState.Enforced;
      reason = `all ${declared.length} verification command(s) wired (by id or command) in sharkcraft.config.ts`;
    } else if (declared.length > 0 && enforced.length > 0) {
      state = RuleEnforcementState.PartiallyEnforced;
      reason = `${enforced.length}/${declared.length} verification command(s) wired (by id or command) in sharkcraft.config.ts`;
    } else if (declared.length > 0) {
      state = RuleEnforcementState.PartiallyEnforced;
      reason = `${declared.length} verification command(s) declared but none wired (by id or command) in sharkcraft.config.ts`;
    } else if (hasHints) {
      state = RuleEnforcementState.ManualOnly;
      reason = 'has action hints (commands/mcpTools/forbiddenActions) but no verificationCommands';
    } else {
      state = RuleEnforcementState.Aspirational;
      reason = 'no verificationCommands and no action hints — documentation-only rule';
    }

    const sourceInfo = inspection.entrySources.get(entry.id);
    entries.push({
      id: entry.id,
      title: entry.title,
      type: entry.type,
      priority: entry.priority,
      state,
      reason,
      declaredVerificationCommands: declared,
      enforcedVerificationCommands: enforced,
      hasActionHints: hasHints,
      advisory,
      source: {
        type: sourceInfo?.type ?? 'local',
        ...(sourceInfo?.packageName ? { packageName: sourceInfo.packageName } : {}),
      },
    });
  }

  const summary: Record<RuleEnforcementState, number> = {
    [RuleEnforcementState.Enforced]: 0,
    [RuleEnforcementState.PartiallyEnforced]: 0,
    [RuleEnforcementState.ManualOnly]: 0,
    [RuleEnforcementState.Aspirational]: 0,
    [RuleEnforcementState.Stale]: 0,
    [RuleEnforcementState.Unknown]: 0,
  };
  for (const e of entries) summary[e.state] += 1;

  const nextCommands: string[] = [];
  if (summary[RuleEnforcementState.PartiallyEnforced] > 0) {
    nextCommands.push(
      `# Wire the missing verification commands in sharkcraft/sharkcraft.config.ts (verificationCommands[]).`,
    );
  }
  if (summary[RuleEnforcementState.Stale] > 0) {
    nextCommands.push(`shrk knowledge stale-check --ci`);
  }
  if (summary[RuleEnforcementState.Aspirational] > 0) {
    nextCommands.push(`shrk rules doctor --strict`);
  }

  return {
    schema: RULE_DRIFT_SCHEMA,
    generatedAt: new Date().toISOString(),
    entries,
    summary,
    nextCommands,
  };
}
