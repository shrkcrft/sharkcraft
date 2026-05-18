import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import type {
  IInferredBoundaryRule,
  IInferredPathConvention,
  IInferredPipeline,
  IInferredRule,
  IInferredTemplateCandidate,
  IInferredVerificationCommand,
  IOnboardingPlan,
} from './onboarding.ts';
import { buildAdoptionState, readAdoptionState, writeAdoptionState } from './adoption-state.ts';

export enum AdoptionCategory {
  SafeToAdopt = 'safe-to-adopt',
  ManualReview = 'manual-review',
  LowConfidence = 'low-confidence',
  Conflict = 'conflict',
  AlreadyCovered = 'already-covered',
  Skipped = 'skipped',
}

export enum AdoptionKind {
  Rule = 'rule',
  Path = 'path',
  Verification = 'verification',
  Template = 'template',
  Boundary = 'boundary',
  Pipeline = 'pipeline',
}

export interface IAdoptionItem {
  kind: AdoptionKind;
  id: string;
  title: string;
  category: AdoptionCategory;
  /** Why this item was placed in the given category. */
  reason: string;
  /** Source draft file under sharkcraft/onboarding/. */
  draftFile: string;
  /** Short snippet to be included in the adoption-plan.md. */
  preview: string;
}

export interface IAdoptionPlan {
  /** Confidence threshold used to build the plan. */
  confidence: 'high' | 'medium' | 'low';
  /** Which kinds were included by the user (defaults to all except templates). */
  included: readonly AdoptionKind[];
  /** Which kinds were excluded. */
  excluded: readonly AdoptionKind[];
  items: readonly IAdoptionItem[];
  /** Summary counts keyed by category. */
  summary: Readonly<Record<AdoptionCategory, number>>;
  /** Items grouped per category for human consumption. */
  byCategory: Readonly<Record<AdoptionCategory, readonly IAdoptionItem[]>>;
}

export interface IBuildAdoptionPlanInput {
  inspection: ISharkcraftInspection;
  plan: IOnboardingPlan;
  /** Confidence threshold. Default: 'high'. */
  confidence?: 'high' | 'medium' | 'low';
  /** Kinds explicitly included. Empty = all except `template` and `boundary`. */
  include?: readonly AdoptionKind[];
  /** Kinds explicitly excluded. Always applied last. */
  exclude?: readonly AdoptionKind[];
  /** When true, imported agent rules are treated as manual-review (default). */
  treatImportedAgentRulesAsManualReview?: boolean;
}

const ALL_KINDS: readonly AdoptionKind[] = [
  AdoptionKind.Rule,
  AdoptionKind.Path,
  AdoptionKind.Verification,
  AdoptionKind.Template,
  AdoptionKind.Boundary,
  AdoptionKind.Pipeline,
];

const DEFAULT_KINDS: readonly AdoptionKind[] = [
  AdoptionKind.Rule,
  AdoptionKind.Path,
  AdoptionKind.Verification,
  AdoptionKind.Pipeline,
];

function emptySummary(): Record<AdoptionCategory, number> {
  return {
    [AdoptionCategory.SafeToAdopt]: 0,
    [AdoptionCategory.ManualReview]: 0,
    [AdoptionCategory.LowConfidence]: 0,
    [AdoptionCategory.Conflict]: 0,
    [AdoptionCategory.AlreadyCovered]: 0,
    [AdoptionCategory.Skipped]: 0,
  };
}

function emptyByCategory(): Record<AdoptionCategory, IAdoptionItem[]> {
  return {
    [AdoptionCategory.SafeToAdopt]: [],
    [AdoptionCategory.ManualReview]: [],
    [AdoptionCategory.LowConfidence]: [],
    [AdoptionCategory.Conflict]: [],
    [AdoptionCategory.AlreadyCovered]: [],
    [AdoptionCategory.Skipped]: [],
  };
}

function thresholdConfidence(input: 'high' | 'medium' | 'low'): {
  allow: ReadonlySet<'high' | 'medium' | 'low'>;
} {
  if (input === 'high') return { allow: new Set(['high']) };
  if (input === 'medium') return { allow: new Set(['high', 'medium']) };
  return { allow: new Set(['high', 'medium', 'low']) };
}

function classifyRule(
  r: IInferredRule,
  inspection: ISharkcraftInspection,
): { category: AdoptionCategory; reason: string } {
  const existing = inspection.ruleService.get(r.id);
  if (existing) {
    return { category: AdoptionCategory.AlreadyCovered, reason: 'rule id already registered' };
  }
  if (r.source === 'agents-md') {
    return {
      category: AdoptionCategory.ManualReview,
      reason: 'imported from AGENTS.md / CLAUDE.md — review wording before adoption',
    };
  }
  if (r.priority === 'critical' || r.priority === 'high') {
    return { category: AdoptionCategory.SafeToAdopt, reason: `inferred from ${r.source}` };
  }
  if (r.priority === 'medium') {
    return { category: AdoptionCategory.ManualReview, reason: 'medium-priority inference' };
  }
  return { category: AdoptionCategory.LowConfidence, reason: 'low-priority inference' };
}

function classifyPath(
  p: IInferredPathConvention,
  inspection: ISharkcraftInspection,
): { category: AdoptionCategory; reason: string } {
  if (inspection.pathService.get(p.id)) {
    return { category: AdoptionCategory.AlreadyCovered, reason: 'path id already registered' };
  }
  return { category: AdoptionCategory.SafeToAdopt, reason: 'path convention not yet defined' };
}

function classifyVerification(
  v: IInferredVerificationCommand,
  inspection: ISharkcraftInspection,
): { category: AdoptionCategory; reason: string } {
  const registered = inspection.config?.verificationCommands ?? [];
  if (registered.some((c) => c.id === v.id)) {
    return { category: AdoptionCategory.AlreadyCovered, reason: 'verification id already registered' };
  }
  if (!v.trusted) {
    return {
      category: AdoptionCategory.ManualReview,
      reason: 'verification command not marked trusted — review before opt-in',
    };
  }
  return { category: AdoptionCategory.SafeToAdopt, reason: 'trusted verification' };
}

function classifyTemplate(
  t: IInferredTemplateCandidate,
  inspection: ISharkcraftInspection,
): { category: AdoptionCategory; reason: string } {
  if (inspection.templateRegistry.get(t.id)) {
    return { category: AdoptionCategory.AlreadyCovered, reason: 'template id already registered' };
  }
  if (t.confidence === 'high' && t.scaffold) {
    return { category: AdoptionCategory.SafeToAdopt, reason: 'high-confidence runnable scaffold' };
  }
  if (t.confidence === 'high' || t.confidence === 'medium') {
    return {
      category: AdoptionCategory.ManualReview,
      reason: 'template body must be reviewed — generated drafts may need edits',
    };
  }
  return { category: AdoptionCategory.LowConfidence, reason: 'low-confidence template candidate' };
}

function classifyBoundary(
  b: IInferredBoundaryRule,
  inspection: ISharkcraftInspection,
): { category: AdoptionCategory; reason: string } {
  if (inspection.boundaryRegistry.list().some((r) => r.id === b.id)) {
    return { category: AdoptionCategory.AlreadyCovered, reason: 'boundary id already registered' };
  }
  if (b.severity === 'error') {
    return {
      category: AdoptionCategory.ManualReview,
      reason: 'error-severity boundary rules need explicit review before adoption',
    };
  }
  return { category: AdoptionCategory.SafeToAdopt, reason: 'warning-severity boundary' };
}

function classifyPipeline(
  p: IInferredPipeline,
  inspection: ISharkcraftInspection,
): { category: AdoptionCategory; reason: string } {
  if (inspection.pipelineRegistry.get(p.id)) {
    return { category: AdoptionCategory.AlreadyCovered, reason: 'pipeline id already registered' };
  }
  return { category: AdoptionCategory.SafeToAdopt, reason: 'pipeline not yet defined' };
}

/**
 * Build an adoption plan from an onboarding plan. Pure: no IO. The plan
 * classifies every inferred item into one of the AdoptionCategory buckets and
 * records the threshold/include/exclude inputs so it's reproducible.
 */
export function buildOnboardingAdoptionPlan(
  input: IBuildAdoptionPlanInput,
): IAdoptionPlan {
  const confidence = input.confidence ?? 'high';
  const threshold = thresholdConfidence(confidence);
  const include = input.include && input.include.length > 0 ? input.include : DEFAULT_KINDS;
  const exclude = input.exclude ?? [];
  const enabled = new Set<AdoptionKind>(include);
  for (const e of exclude) enabled.delete(e);
  const treatImportedAsManual = input.treatImportedAgentRulesAsManualReview ?? true;
  const items: IAdoptionItem[] = [];
  const onb = input.plan;

  const pushItem = (item: IAdoptionItem): void => {
    items.push(item);
  };

  if (enabled.has(AdoptionKind.Rule)) {
    for (const r of onb.inferredRules) {
      let { category, reason } = classifyRule(r, input.inspection);
      // Hard guard: imported agent rules → manual-review unless user lowered the bar.
      if (treatImportedAsManual && r.source === 'agents-md') {
        category = AdoptionCategory.ManualReview;
        reason = 'imported from AGENTS.md / CLAUDE.md — manual review';
      }
      // Confidence threshold downgrade — if the item's confidence is below the
      // user-selected threshold, demote to low-confidence.
      const fakeConf: 'high' | 'medium' | 'low' =
        r.priority === 'critical' || r.priority === 'high' ? 'high' : r.priority === 'medium' ? 'medium' : 'low';
      if (!threshold.allow.has(fakeConf) && category === AdoptionCategory.SafeToAdopt) {
        category = AdoptionCategory.LowConfidence;
        reason = `below confidence threshold (${fakeConf} < ${confidence})`;
      }
      pushItem({
        kind: AdoptionKind.Rule,
        id: r.id,
        title: r.title,
        category,
        reason,
        draftFile: 'inferred-rules.draft.ts',
        preview: r.title,
      });
    }
  }
  if (enabled.has(AdoptionKind.Path)) {
    for (const p of onb.inferredPathConventions) {
      const { category, reason } = classifyPath(p, input.inspection);
      pushItem({
        kind: AdoptionKind.Path,
        id: p.id,
        title: p.title,
        category,
        reason,
        draftFile: 'inferred-paths.draft.ts',
        preview: p.title,
      });
    }
  }
  if (enabled.has(AdoptionKind.Verification)) {
    for (const v of onb.inferredVerificationCommands) {
      const { category, reason } = classifyVerification(v, input.inspection);
      pushItem({
        kind: AdoptionKind.Verification,
        id: v.id,
        title: v.label,
        category,
        reason,
        draftFile: 'onboarding-report.md',
        preview: v.command,
      });
    }
  }
  if (enabled.has(AdoptionKind.Template)) {
    for (const t of onb.inferredTemplateCandidates) {
      let { category, reason } = classifyTemplate(t, input.inspection);
      if (!threshold.allow.has(t.confidence) && category === AdoptionCategory.SafeToAdopt) {
        category = AdoptionCategory.LowConfidence;
        reason = `below confidence threshold (${t.confidence} < ${confidence})`;
      }
      pushItem({
        kind: AdoptionKind.Template,
        id: t.id,
        title: t.name,
        category,
        reason,
        draftFile: 'inferred-templates.draft.ts',
        preview: t.description,
      });
    }
  }
  if (enabled.has(AdoptionKind.Boundary)) {
    for (const b of onb.inferredBoundaryRules) {
      const { category, reason } = classifyBoundary(b, input.inspection);
      pushItem({
        kind: AdoptionKind.Boundary,
        id: b.id,
        title: b.title,
        category,
        reason,
        draftFile: 'inferred-boundaries.draft.ts',
        preview: b.suggestedFix,
      });
    }
  }
  if (enabled.has(AdoptionKind.Pipeline)) {
    for (const p of onb.inferredPipelines) {
      const { category, reason } = classifyPipeline(p, input.inspection);
      pushItem({
        kind: AdoptionKind.Pipeline,
        id: p.id,
        title: p.title,
        category,
        reason,
        draftFile: 'inferred-pipelines.draft.ts',
        preview: p.description,
      });
    }
  }
  // Items the user explicitly excluded — only annotate when the inference
  // produced them so adoption review can show "skipped because excluded".
  for (const excluded of exclude) {
    for (const item of itemsForKind(onb, excluded)) {
      items.push({
        kind: excluded,
        id: item.id,
        title: item.title,
        category: AdoptionCategory.Skipped,
        reason: 'kind excluded via --exclude',
        draftFile: defaultDraftFile(excluded),
        preview: item.preview,
      });
    }
  }

  const summary = emptySummary();
  const byCategory = emptyByCategory();
  for (const it of items) {
    summary[it.category] += 1;
    byCategory[it.category].push(it);
  }
  return {
    confidence,
    included: [...enabled],
    excluded: exclude,
    items,
    summary,
    byCategory,
  };
}

function itemsForKind(
  plan: IOnboardingPlan,
  kind: AdoptionKind,
): Array<{ id: string; title: string; preview: string }> {
  switch (kind) {
    case AdoptionKind.Rule:
      return plan.inferredRules.map((r) => ({ id: r.id, title: r.title, preview: r.title }));
    case AdoptionKind.Path:
      return plan.inferredPathConventions.map((p) => ({ id: p.id, title: p.title, preview: p.title }));
    case AdoptionKind.Verification:
      return plan.inferredVerificationCommands.map((v) => ({
        id: v.id,
        title: v.label,
        preview: v.command,
      }));
    case AdoptionKind.Template:
      return plan.inferredTemplateCandidates.map((t) => ({
        id: t.id,
        title: t.name,
        preview: t.description,
      }));
    case AdoptionKind.Boundary:
      return plan.inferredBoundaryRules.map((b) => ({
        id: b.id,
        title: b.title,
        preview: b.suggestedFix,
      }));
    case AdoptionKind.Pipeline:
      return plan.inferredPipelines.map((p) => ({
        id: p.id,
        title: p.title,
        preview: p.description,
      }));
  }
}

function defaultDraftFile(kind: AdoptionKind): string {
  switch (kind) {
    case AdoptionKind.Rule:
      return 'inferred-rules.draft.ts';
    case AdoptionKind.Path:
      return 'inferred-paths.draft.ts';
    case AdoptionKind.Verification:
      return 'onboarding-report.md';
    case AdoptionKind.Template:
      return 'inferred-templates.draft.ts';
    case AdoptionKind.Boundary:
      return 'inferred-boundaries.draft.ts';
    case AdoptionKind.Pipeline:
      return 'inferred-pipelines.draft.ts';
  }
}

// ─── Patch / plan rendering ──────────────────────────────────────────────────

export function renderAdoptionPlanMarkdown(plan: IAdoptionPlan): string {
  const lines: string[] = [];
  lines.push('# SharkCraft onboarding — adoption plan');
  lines.push('');
  lines.push(`Confidence threshold: \`${plan.confidence}\``);
  lines.push(`Included kinds: ${plan.included.map((k) => '`' + k + '`').join(', ') || '_(none)_'}`);
  if (plan.excluded.length > 0) {
    lines.push(`Excluded kinds: ${plan.excluded.map((k) => '`' + k + '`').join(', ')}`);
  }
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  for (const cat of Object.values(AdoptionCategory)) {
    lines.push(`- **${cat}**: ${plan.summary[cat as AdoptionCategory]}`);
  }
  lines.push('');
  for (const cat of Object.values(AdoptionCategory)) {
    const items = plan.byCategory[cat as AdoptionCategory];
    if (items.length === 0) continue;
    lines.push(`## ${cat}`);
    lines.push('');
    for (const it of items) {
      lines.push(`- **${it.kind}** \`${it.id}\` — ${it.title}`);
      lines.push(`  - reason: ${it.reason}`);
      lines.push(`  - draft: \`sharkcraft/onboarding/${it.draftFile}\``);
    }
    lines.push('');
  }
  lines.push('## How to apply');
  lines.push('');
  lines.push('```');
  lines.push('# Apply only the safe-to-adopt blocks (review first):');
  lines.push('git apply sharkcraft/onboarding/adoption/adopt.patch');
  lines.push('');
  lines.push('# Or inspect items by category:');
  lines.push('shrk onboard adopt review');
  lines.push('```');
  return lines.join('\n') + '\n';
}

export type AdoptionPatchFormat = 'pseudo' | 'unified';

export interface IRenderAdoptionPatchOptions {
  /** 'pseudo' (default) preserves the `@@ append @@` sentinel for human review.
   *  'unified' produces a real git-apply-compatible patch. */
  format?: AdoptionPatchFormat;
  /** Project root — required when format='unified' so existing-file hunks read
   *  the current file content. */
  projectRoot?: string;
}

export interface IAdoptionPatchTarget {
  relativePath: string;
  /** sha256 of the existing file when format='unified' and the file exists. */
  beforeHash?: string;
  /** Whether the target existed at patch render time. */
  existed: boolean;
  /** Bytes added by this hunk. */
  bytesAdded: number;
}

export interface IRenderAdoptionPatchResult {
  body: string;
  targets: IAdoptionPatchTarget[];
  format: AdoptionPatchFormat;
}

/**
 * Render an adoption patch. Defaults to the conservative 'pseudo' format
 * (sentinel-marked append block). 'unified' produces real `git apply`
 * patches: full-file create for missing targets, append-at-EOF hunk for
 * existing targets with a small leading context window so git can find the
 * insertion point reliably.
 *
 * The patch is always append-only and intentionally never overwrites
 * existing content. Output lives under sharkcraft/onboarding/adoption/.
 */
export function renderAdoptionPatchDetailed(
  plan: IAdoptionPlan,
  options: IRenderAdoptionPatchOptions = {},
): IRenderAdoptionPatchResult {
  const format = options.format ?? 'pseudo';
  const adopt = plan.byCategory[AdoptionCategory.SafeToAdopt];
  if (adopt.length === 0) {
    return {
      body: '# No safe-to-adopt items in this plan — nothing to patch.\n',
      targets: [],
      format,
    };
  }
  const byKind = new Map<AdoptionKind, IAdoptionItem[]>();
  for (const it of adopt) {
    const arr = byKind.get(it.kind) ?? [];
    arr.push(it);
    byKind.set(it.kind, arr);
  }

  const targets: IAdoptionPatchTarget[] = [];
  const renderTarget = (relativePath: string, body: string): string[] => {
    if (format === 'pseudo') {
      targets.push({ relativePath, existed: false, bytesAdded: body.length });
      return renderPseudoBlock(relativePath, body);
    }
    return renderUnifiedHunk(relativePath, body, options.projectRoot, targets);
  };

  const lines: string[] = [];
  lines.push('# SharkCraft onboarding adoption patch');
  lines.push('# Generated by `shrk onboard adopt --write-patch`.');
  lines.push(`# Format: ${format}`);
  lines.push('#');
  lines.push(
    format === 'unified'
      ? '# This is a git-apply-compatible unified diff. Review before applying:'
      : '# This is a pseudo-patch. The `@@ append @@` markers are sentinels:',
  );
  lines.push(
    format === 'unified'
      ? '#   git apply sharkcraft/onboarding/adoption/adopt.patch'
      : '#   inspect adopt.patch, then copy each append block into the target file',
  );
  lines.push('#');
  lines.push('# This patch ONLY appends. It does not overwrite existing entries.');
  lines.push('# Review every block before applying.');
  lines.push('');
  if (byKind.has(AdoptionKind.Rule)) {
    lines.push(...renderTarget('sharkcraft/rules.ts', renderRuleBlock(byKind.get(AdoptionKind.Rule)!)));
  }
  if (byKind.has(AdoptionKind.Path)) {
    lines.push(...renderTarget('sharkcraft/paths.ts', renderPathBlock(byKind.get(AdoptionKind.Path)!)));
  }
  if (byKind.has(AdoptionKind.Verification)) {
    lines.push(
      ...renderTarget(
        'sharkcraft/sharkcraft.config.ts',
        renderVerificationBlock(byKind.get(AdoptionKind.Verification)!),
      ),
    );
  }
  if (byKind.has(AdoptionKind.Pipeline)) {
    lines.push(
      ...renderTarget('sharkcraft/pipelines.ts', renderPipelineBlock(byKind.get(AdoptionKind.Pipeline)!)),
    );
  }
  return {
    body: lines.join('\n') + '\n',
    targets,
    format,
  };
}

/** Back-compat wrapper that returns just the patch body. */
export function renderAdoptionPatch(plan: IAdoptionPlan): string {
  return renderAdoptionPatchDetailed(plan).body;
}

function renderPseudoBlock(targetRel: string, body: string): string[] {
  const lines: string[] = [];
  lines.push(`--- a/${targetRel}`);
  lines.push(`+++ b/${targetRel}`);
  lines.push('@@ append @@');
  for (const l of body.split('\n')) lines.push(`+${l}`);
  lines.push('');
  return lines;
}

function renderUnifiedHunk(
  targetRel: string,
  body: string,
  projectRoot: string | undefined,
  targets: IAdoptionPatchTarget[],
): string[] {
  const lines: string[] = [];
  const fullPath = projectRoot ? nodePath.resolve(projectRoot, targetRel) : null;
  const exists = fullPath !== null && existsSync(fullPath);
  const addedLines = body.split('\n');
  // Trim trailing newline lines (we add the LF separator ourselves).
  while (addedLines.length > 0 && addedLines[addedLines.length - 1] === '') {
    addedLines.pop();
  }
  const bytesAdded = addedLines.reduce((s, l) => s + l.length + 1, 0);

  if (!exists) {
    // New file: emit a 'new file' unified diff with the full body in a single hunk.
    lines.push(`diff --git a/${targetRel} b/${targetRel}`);
    lines.push('new file mode 100644');
    lines.push('--- /dev/null');
    lines.push(`+++ b/${targetRel}`);
    lines.push(`@@ -0,0 +1,${addedLines.length} @@`);
    for (const l of addedLines) lines.push(`+${l}`);
    lines.push('');
    targets.push({ relativePath: targetRel, existed: false, bytesAdded });
    return lines;
  }

  const existing = readFileSync(fullPath!, 'utf8');
  const beforeHash = createHash('sha256').update(existing).digest('hex');
  const existingLines = existing.split('\n');
  // Files conventionally end with a trailing newline → last entry is empty.
  const hasTrailingNewline = existingLines[existingLines.length - 1] === '';
  if (hasTrailingNewline) existingLines.pop();
  const beforeLineCount = existingLines.length;
  // Context window: last 3 lines (or all of them if file is short).
  const contextStart = Math.max(0, beforeLineCount - 3);
  const contextLines = existingLines.slice(contextStart);
  // The unified hunk spans from `contextStart+1` to the end of the new file.
  const afterLineCount = beforeLineCount + addedLines.length;
  const oldStart = contextStart + 1;
  const oldRange = contextLines.length;
  const newStart = contextStart + 1;
  const newRange = contextLines.length + addedLines.length;
  lines.push(`diff --git a/${targetRel} b/${targetRel}`);
  lines.push(`--- a/${targetRel}`);
  lines.push(`+++ b/${targetRel}`);
  lines.push(`@@ -${oldStart},${oldRange} +${newStart},${newRange} @@`);
  for (const c of contextLines) lines.push(` ${c}`);
  for (const a of addedLines) lines.push(`+${a}`);
  lines.push('');
  void afterLineCount;
  targets.push({ relativePath: targetRel, existed: true, beforeHash, bytesAdded });
  return lines;
}

function renderRuleBlock(items: readonly IAdoptionItem[]): string {
  const lines: string[] = [];
  lines.push('// ─── Adopted from `shrk onboard adopt` ─── start');
  for (const it of items) {
    lines.push(`// rule: ${it.id} — ${it.title}`);
  }
  lines.push('// ─── Adopted from `shrk onboard adopt` ─── end');
  return lines.join('\n');
}

function renderPathBlock(items: readonly IAdoptionItem[]): string {
  const lines: string[] = [];
  lines.push('// ─── Adopted from `shrk onboard adopt` ─── start');
  for (const it of items) {
    lines.push(`// path convention: ${it.id} — ${it.title}`);
  }
  lines.push('// ─── Adopted from `shrk onboard adopt` ─── end');
  return lines.join('\n');
}

function renderVerificationBlock(items: readonly IAdoptionItem[]): string {
  const lines: string[] = [];
  lines.push('// ─── Adopted verification commands — start');
  for (const it of items) {
    lines.push(`// { id: '${it.id}', label: '${it.title}', command: '<edit>', trusted: true },`);
  }
  lines.push('// ─── Adopted verification commands — end');
  return lines.join('\n');
}

function renderPipelineBlock(items: readonly IAdoptionItem[]): string {
  const lines: string[] = [];
  lines.push('// ─── Adopted pipelines — start');
  for (const it of items) {
    lines.push(`// pipeline: ${it.id} — ${it.title}`);
  }
  lines.push('// ─── Adopted pipelines — end');
  return lines.join('\n');
}

// ─── Writing the patch to disk ───────────────────────────────────────────────

export interface IWriteAdoptionPatchInput {
  projectRoot: string;
  plan: IAdoptionPlan;
  /** Patch format. Default 'pseudo'. */
  format?: AdoptionPatchFormat;
  /** When true (default), if previous adoption-state.json exists and the
   *  current target file hashes diverge from the previously-recorded hashes,
   *  archive the old state+patch under history/ before writing the new ones. */
  autoRegenerate?: boolean;
  /** Override: skip the auto-regenerate archival step. Pairs with
   *  `--no-auto-regenerate` on the CLI. */
  noAutoRegenerate?: boolean;
}

export interface IWriteAdoptionPatchResult {
  outDir: string;
  files: Array<{ path: string; bytes: number }>;
  format: AdoptionPatchFormat;
  /** Targets the patch touches, with `beforeHash` for unified-format hunks. */
  targets: IAdoptionPatchTarget[];
  /** Adoption state file path (always written). */
  statePath: string;
  /** Whether previous outputs were archived under history/ before the run. */
  archived: readonly string[];
  /** Whether the previous patch was detected as stale at write time. */
  wasStale: boolean;
}

export function writeAdoptionPatch(
  input: IWriteAdoptionPatchInput,
): IWriteAdoptionPatchResult {
  const outDir = nodePath.resolve(input.projectRoot, 'sharkcraft', 'onboarding', 'adoption');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  // Detect whether the prior patch is stale relative to current targets/drafts
  // BEFORE we overwrite the state file. We do the actual archival via a small
  // helper imported below to avoid a circular import.
  const wasStale = detectPreviousStale(input.projectRoot);
  const autoRegenerate =
    input.autoRegenerate !== false && input.noAutoRegenerate !== true;
  const archived: string[] = [];
  if (wasStale && autoRegenerate) {
    archived.push(...archiveAdoptionOutputs(input.projectRoot));
  }

  const files: Array<{ path: string; bytes: number }> = [];
  const write = (name: string, body: string): void => {
    const full = nodePath.join(outDir, name);
    if (!full.startsWith(outDir + nodePath.sep)) {
      throw new Error(`adoption path escapes outDir: ${name}`);
    }
    writeFileSync(full, body, 'utf8');
    files.push({ path: full, bytes: Buffer.byteLength(body, 'utf8') });
  };
  write('adoption-plan.md', renderAdoptionPlanMarkdown(input.plan));
  const patch = renderAdoptionPatchDetailed(input.plan, {
    format: input.format ?? 'pseudo',
    projectRoot: input.projectRoot,
  });
  write('adopt.patch', patch.body);
  write(
    'adopt-summary.json',
    JSON.stringify(
      {
        confidence: input.plan.confidence,
        summary: input.plan.summary,
        items: input.plan.items,
        format: patch.format,
        targets: patch.targets,
      },
      null,
      2,
    ) + '\n',
  );

  const statePath = persistAdoptionState({
    projectRoot: input.projectRoot,
    plan: input.plan,
    targets: patch.targets,
    diffFormat: patch.format,
    patchPath: nodePath.join(outDir, 'adopt.patch'),
    summaryPath: nodePath.join(outDir, 'adopt-summary.json'),
    generatedFiles: files.map((f) => f.path),
    command: input.format
      ? `shrk onboard adopt --write-patch --diff-format ${input.format}`
      : 'shrk onboard adopt --write-patch',
    warnings: wasStale && autoRegenerate ? ['previous patch was stale; archived to history/'] : [],
  });

  return {
    outDir,
    files,
    format: patch.format,
    targets: patch.targets,
    statePath,
    archived,
    wasStale,
  };
}

// ─── Helpers used by writeAdoptionPatch ──────────────────────────────────────
//
// These are intentionally small wrappers that defer the actual work to
// `adoption-state.ts`. The functions are imported lazily inside writeAdoptionPatch
// to avoid a top-level circular import cycle (adoption-state imports types
// from this module).

function detectPreviousStale(projectRoot: string): boolean {
  const statePath = nodePath.join(
    projectRoot,
    'sharkcraft',
    'onboarding',
    'adoption',
    'adoption-state.json',
  );
  if (!existsSync(statePath)) return false;
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      targetFiles?: Array<{ relativePath: string; hash: string }>;
    };
    if (!state.targetFiles) return false;
    for (const t of state.targetFiles) {
      const full = nodePath.resolve(projectRoot, t.relativePath);
      if (!existsSync(full)) {
        if (t.hash !== '(missing)') return true;
        continue;
      }
      const body = readFileSync(full, 'utf8');
      const cur = createHash('sha256').update(body).digest('hex');
      if (t.hash === '(missing)') return true;
      if (cur !== t.hash) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function archiveAdoptionOutputs(projectRoot: string): string[] {
  const dir = nodePath.join(projectRoot, 'sharkcraft', 'onboarding', 'adoption');
  if (!existsSync(dir)) return [];
  const history = nodePath.join(dir, 'history');
  if (!existsSync(history)) mkdirSync(history, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archived: string[] = [];
  for (const name of ['adoption-state.json', 'adopt.patch', 'adoption-plan.md', 'adopt-summary.json']) {
    const src = nodePath.join(dir, name);
    if (!existsSync(src)) continue;
    const dest = nodePath.join(history, `${timestamp}-${name}`);
    if (existsSync(dest)) continue;
    try {
      const body = readFileSync(src, 'utf8');
      writeFileSync(dest, body, 'utf8');
      archived.push(dest);
    } catch {
      // ignore
    }
  }
  return archived;
}

interface IPersistStateInput {
  projectRoot: string;
  plan: IAdoptionPlan;
  targets: readonly IAdoptionPatchTarget[];
  diffFormat: AdoptionPatchFormat;
  patchPath: string;
  summaryPath: string;
  generatedFiles: readonly string[];
  command: string;
  warnings: readonly string[];
}

function persistAdoptionState(input: IPersistStateInput): string {
  const previous = readAdoptionState(input.projectRoot);
  const state = buildAdoptionState({
    projectRoot: input.projectRoot,
    command: input.command,
    patchPath: input.patchPath,
    summaryPath: input.summaryPath,
    diffFormat: input.diffFormat,
    plan: input.plan,
    targets: input.targets,
    generatedFiles: input.generatedFiles as string[],
    warnings: input.warnings as string[],
    ...(previous ? { previousCreatedAt: previous.createdAt } : {}),
  });
  return writeAdoptionState(input.projectRoot, state);
}

/** Validate that the targets in a previously-written summary still match the
 *  current files on disk. Used by `shrk onboard adopt review` to warn when
 *  the target files changed between plan-time and review-time. */
export function validatePatchTargets(
  projectRoot: string,
  targets: readonly IAdoptionPatchTarget[],
): { changed: readonly IAdoptionPatchTarget[]; ok: readonly IAdoptionPatchTarget[] } {
  const changed: IAdoptionPatchTarget[] = [];
  const ok: IAdoptionPatchTarget[] = [];
  for (const t of targets) {
    if (!t.beforeHash) {
      ok.push(t);
      continue;
    }
    const full = nodePath.resolve(projectRoot, t.relativePath);
    if (!existsSync(full)) {
      // Target disappeared since plan-time.
      changed.push(t);
      continue;
    }
    const cur = createHash('sha256').update(readFileSync(full, 'utf8')).digest('hex');
    if (cur !== t.beforeHash) changed.push(t);
    else ok.push(t);
  }
  return { changed, ok };
}
