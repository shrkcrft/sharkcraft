/**
 * Feedback ingestion.
 *
 * Parses freeform markdown/text feedback into structured findings the
 * agent (or a human) can convert into a backlog. Deterministic, no AI.
 *
 * Heuristics:
 *  - Section headings (`# Good`, `## Bad`, `### Missing`, etc.) seed
 *    initial bucket.
 *  - Bullet markers (`-`, `*`, `+`, numbered) become findings.
 *  - Keyword scan over each bullet adds tags and likely-target-area.
 *
 * Schema: sharkcraft.feedback-ingestion/v1
 */
import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { importModuleViaLoader, RejectionCause, type IRejectedEntry } from '@shrkcrft/core';
import type { IContributionFileIssue } from './i-contribution-file-issue.ts';

export const FEEDBACK_INGESTION_SCHEMA = 'sharkcraft.feedback-ingestion/v1';

export enum FeedbackBucket {
  Good = 'good',
  Bad = 'bad',
  Missing = 'missing',
  PainPoint = 'pain-point',
  Other = 'other',
}

export enum FeedbackSeverity {
  Info = 'info',
  Minor = 'minor',
  Major = 'major',
  Blocker = 'blocker',
}

export interface IFeedbackFinding {
  bucket: FeedbackBucket;
  text: string;
  tags: ReadonlyArray<string>;
  /** Best-guess target area (knowledge|templates|boundaries|trace|impact|doctor|...). */
  targetArea?: string;
  severity: FeedbackSeverity;
  /** Suggested follow-up commands. */
  suggestedCommands: ReadonlyArray<string>;
}

export interface IFeedbackReport {
  schema: typeof FEEDBACK_INGESTION_SCHEMA;
  sourceFile?: string;
  generatedAt: string;
  totalFindings: number;
  counts: Record<FeedbackBucket, number>;
  findings: ReadonlyArray<IFeedbackFinding>;
  suggestedNextRound: ReadonlyArray<string>;
}

interface IKeywordRule {
  pattern: RegExp;
  tags: string[];
  targetArea: string;
  suggestedCommands?: string[];
  severity?: FeedbackSeverity;
}

/**
 * Public pack-extensible feedback rule. Schema:
 * sharkcraft.feedback-rule/v1.
 *
 * Packs ship rules via `feedbackRuleFiles[]` in their manifest; the local
 * project can also place `sharkcraft/feedback-rules.ts` with a default
 * export of `IFeedbackRule[]`.
 */
export const FEEDBACK_RULE_SCHEMA = 'sharkcraft.feedback-rule/v1';

export interface IFeedbackRule {
  id: string;
  title: string;
  description?: string;
  /** Plain strings — matched case-insensitively as word fragments. */
  keywords?: readonly string[];
  /** Multi-word phrases. */
  phrases?: readonly string[];
  /** Raw regex strings (compiled with `i` flag). */
  regexes?: readonly string[];
  /** Bucket nudge — kept separate from bucket-derived severity. */
  category?: 'good' | 'bad' | 'missing' | 'pain-point' | 'other';
  /** Tag added to matching findings (besides rule.tags). */
  tag?: string;
  tags?: readonly string[];
  /** Suggested target-area override. */
  targetArea?: string;
  severity?: FeedbackSeverity;
  /** Concrete CLI commands to attach to matching findings. */
  suggestedActions?: readonly string[];
  /** Related ids (for downstream tooling). */
  relatedCommands?: readonly string[];
  relatedTemplates?: readonly string[];
  relatedPlaybooks?: readonly string[];
  relatedKnowledge?: readonly string[];
  /** When this rule should apply — informational; not enforced today. */
  appliesWhen?: readonly string[];
}

export function defineFeedbackRule<T extends IFeedbackRule>(r: T): T {
  return r;
}

function compileExternalRule(r: IFeedbackRule): IKeywordRule | null {
  const fragments: string[] = [];
  for (const kw of r.keywords ?? []) {
    if (kw.trim().length === 0) continue;
    fragments.push(`\\b${escapeRegex(kw)}\\b`);
  }
  for (const ph of r.phrases ?? []) {
    if (ph.trim().length === 0) continue;
    fragments.push(escapeRegex(ph));
  }
  for (const raw of r.regexes ?? []) {
    if (raw.trim().length === 0) continue;
    fragments.push(`(?:${raw})`);
  }
  if (fragments.length === 0) return null;
  let pattern: RegExp;
  try {
    pattern = new RegExp(fragments.join('|'), 'i');
  } catch {
    return null;
  }
  const tags = new Set<string>();
  if (r.tag) tags.add(r.tag);
  for (const t of r.tags ?? []) tags.add(t);
  const out: IKeywordRule = {
    pattern,
    tags: [...tags],
    targetArea: r.targetArea ?? r.id,
    suggestedCommands: [...(r.suggestedActions ?? []), ...(r.relatedCommands ?? [])],
  };
  if (r.severity) out.severity = r.severity;
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const KEYWORD_RULES: IKeywordRule[] = [
  {
    pattern: /\b(changed-only|changed only)\b/i,
    tags: ['changed-only'],
    targetArea: 'boundaries-changed-only',
    suggestedCommands: ['shrk check boundaries --changed-only', 'shrk policy run --changed-only'],
  },
  {
    pattern: /\b(boundary|boundaries)\b/i,
    tags: ['boundary'],
    targetArea: 'boundaries',
    suggestedCommands: ['shrk check boundaries'],
  },
  {
    pattern: /\b(stale|rot|outdated|drift)\b/i,
    tags: ['stale'],
    targetArea: 'knowledge-integrity',
    suggestedCommands: ['shrk knowledge stale-check', 'shrk templates drift'],
  },
  {
    pattern: /\b(template[s]?)\b/i,
    tags: ['templates'],
    targetArea: 'templates',
    suggestedCommands: ['shrk templates list', 'shrk templates drift'],
  },
  {
    pattern: /\b(playbook[s]?)\b/i,
    tags: ['playbooks'],
    targetArea: 'playbooks',
    suggestedCommands: ['shrk playbooks list'],
  },
  {
    pattern: /\b(warning|noisy|noise)\b/i,
    tags: ['noise'],
    targetArea: 'doctor-suppressions',
    suggestedCommands: ['shrk doctor --quiet-known', 'shrk doctor suppressions list'],
    severity: FeedbackSeverity.Minor,
  },
  {
    pattern: /\b(rename|move|moved|renamed)\b/i,
    tags: ['rename'],
    targetArea: 'knowledge-rename',
    suggestedCommands: ['shrk knowledge rename-symbol <old> <new> --dry-run'],
  },
  {
    pattern: /\b(trace|impact)\b/i,
    tags: ['trace-impact'],
    targetArea: 'trace-impact',
    suggestedCommands: ['shrk trace <query>', 'shrk impact <file>'],
  },
  {
    pattern: /\b(mcp|tool[s]?)\b/i,
    tags: ['mcp'],
    targetArea: 'mcp',
    suggestedCommands: ['shrk commands search mcp'],
  },
  {
    pattern: /\b(helper[s]?)\b/i,
    tags: ['helpers'],
    targetArea: 'helpers',
    suggestedCommands: ['shrk helper list'],
  },
  {
    pattern: /\b(registry|register|remove)\b/i,
    tags: ['registry-lifecycle'],
    targetArea: 'registry-lifecycle',
    suggestedCommands: ['shrk check registry-lifecycle'],
  },
  {
    pattern: /\b(slow|hang|crash|broken|fail|stuck)\b/i,
    tags: ['bug'],
    targetArea: 'bug',
    severity: FeedbackSeverity.Major,
  },
  {
    pattern: /\b(documentation|docs)\b/i,
    tags: ['docs'],
    targetArea: 'docs',
    suggestedCommands: ['shrk docs check'],
  },
];

function findHeadingBucket(line: string): FeedbackBucket | null {
  const m = /^#{1,6}\s+(.*?)\s*$/.exec(line);
  if (!m) return null;
  const text = m[1]!.toLowerCase();
  if (/\b(good|win|works|liked|positive)\b/.test(text)) return FeedbackBucket.Good;
  if (/\b(bad|missing|gaps?|broken|negative|pain|issue|problem|frustration)\b/.test(text)) {
    if (/\bmissing\b/.test(text)) return FeedbackBucket.Missing;
    if (/\bpain\b/.test(text)) return FeedbackBucket.PainPoint;
    return FeedbackBucket.Bad;
  }
  if (/\b(neutral|info|note)\b/.test(text)) return FeedbackBucket.Other;
  return null;
}

function isBulletLine(line: string): boolean {
  return /^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line);
}

function stripBullet(line: string): string {
  return line.replace(/^\s*[-*+]\s+/, '').replace(/^\s*\d+\.\s+/, '').trim();
}

function applyKeywordRules(
  text: string,
  customRules: readonly IKeywordRule[] = [],
): {
  tags: string[];
  targetArea: string | undefined;
  suggested: string[];
  severityHint: FeedbackSeverity;
} {
  const tags = new Set<string>();
  const suggested = new Set<string>();
  let target: string | undefined;
  let severityHint: FeedbackSeverity = FeedbackSeverity.Info;
  const allRules = [...KEYWORD_RULES, ...customRules];
  for (const rule of allRules) {
    if (rule.pattern.test(text)) {
      for (const t of rule.tags) tags.add(t);
      if (!target) target = rule.targetArea;
      for (const c of rule.suggestedCommands ?? []) suggested.add(c);
      if (rule.severity && severityRank(rule.severity) > severityRank(severityHint)) {
        severityHint = rule.severity;
      }
    }
  }
  return {
    tags: [...tags],
    targetArea: target,
    suggested: [...suggested],
    severityHint,
  };
}

function severityRank(s: FeedbackSeverity): number {
  switch (s) {
    case FeedbackSeverity.Info:
      return 1;
    case FeedbackSeverity.Minor:
      return 2;
    case FeedbackSeverity.Major:
      return 3;
    case FeedbackSeverity.Blocker:
      return 4;
  }
}

function refineSeverity(bucket: FeedbackBucket, hint: FeedbackSeverity): FeedbackSeverity {
  if (bucket === FeedbackBucket.Good) return FeedbackSeverity.Info;
  if (bucket === FeedbackBucket.PainPoint || bucket === FeedbackBucket.Bad) {
    return severityRank(hint) < severityRank(FeedbackSeverity.Minor) ? FeedbackSeverity.Minor : hint;
  }
  return hint;
}

export interface IIngestFeedbackOptions {
  /** Additional pack/local feedback rules to apply on top of built-ins. */
  rules?: readonly IFeedbackRule[];
}

export function ingestFeedbackText(
  text: string,
  sourceFile?: string,
  options: IIngestFeedbackOptions = {},
): IFeedbackReport {
  const customRules: IKeywordRule[] = [];
  for (const r of options.rules ?? []) {
    const compiled = compileExternalRule(r);
    if (compiled) customRules.push(compiled);
  }
  let bucket: FeedbackBucket = FeedbackBucket.Other;
  const findings: IFeedbackFinding[] = [];
  for (const rawLine of text.split('\n')) {
    const headingBucket = findHeadingBucket(rawLine);
    if (headingBucket) {
      bucket = headingBucket;
      continue;
    }
    if (!isBulletLine(rawLine)) continue;
    const stripped = stripBullet(rawLine);
    if (!stripped) continue;
    const { tags, targetArea, suggested, severityHint } = applyKeywordRules(stripped, customRules);
    const severity = refineSeverity(bucket, severityHint);
    const finding: IFeedbackFinding = {
      bucket,
      text: stripped,
      tags,
      severity,
      suggestedCommands: suggested,
      ...(targetArea ? { targetArea } : {}),
    };
    findings.push(finding);
  }
  const counts: Record<FeedbackBucket, number> = {
    [FeedbackBucket.Good]: 0,
    [FeedbackBucket.Bad]: 0,
    [FeedbackBucket.Missing]: 0,
    [FeedbackBucket.PainPoint]: 0,
    [FeedbackBucket.Other]: 0,
  };
  for (const f of findings) counts[f.bucket] += 1;
  const targets = new Set<string>();
  for (const f of findings) if (f.targetArea) targets.add(f.targetArea);
  const suggestedNextRound = [...targets].slice(0, 8).map((t) => `Improve ${t}`);
  return {
    schema: FEEDBACK_INGESTION_SCHEMA,
    ...(sourceFile ? { sourceFile } : {}),
    generatedAt: new Date().toISOString(),
    totalFindings: findings.length,
    counts,
    findings,
    suggestedNextRound,
  };
}

export function ingestFeedbackFile(
  projectRoot: string,
  file: string,
  options: IIngestFeedbackOptions = {},
): IFeedbackReport {
  const abs = nodePath.isAbsolute(file) ? file : nodePath.join(projectRoot, file);
  const text = readFileSync(abs, 'utf8');
  return ingestFeedbackText(text, file, options);
}

/**
 * Load pack + local feedback rules. Local file:
 * `sharkcraft/feedback-rules.ts` exporting an `IFeedbackRule[]` default.
 * Packs contribute via `feedbackRuleFiles[]` in their manifest.
 */
export async function loadFeedbackRules(inspection: IFeedbackRuleLoadScope): Promise<readonly IFeedbackRule[]> {
  return (await loadFeedbackRulesWithIssues(inspection)).rules;
}

/** What {@link loadFeedbackRules} reads off an inspection (a structural subset, so a caller need not build one). */
type IFeedbackRuleLoadScope = {
  projectRoot: string;
  sharkcraftDir: string | null;
  packs?: {
    validPacks?: readonly {
      packageRoot: string;
      packageName?: string;
      manifest?: { contributions?: unknown } | null;
    }[];
  };
};

/**
 * THE feedback-rule acceptance predicate (round 12, 12.1): a non-empty string
 * `id` — `[]` means accepted. An id-less rule used to be dropped with no signal.
 */
export function feedbackRuleRejectionReasons(raw: unknown): readonly string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['(entry): must be an object'];
  const id = (raw as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? [] : ['id: must be a non-empty string'];
}

/**
 * {@link loadFeedbackRules} WITH what did not take effect (round 12, 12.1): a
 * rules file that failed to import (it was swallowed to `[]`), and every
 * declared rule the loader refused — invalid, or a duplicate id.
 */
export async function loadFeedbackRulesWithIssues(inspection: IFeedbackRuleLoadScope): Promise<{
  readonly rules: readonly IFeedbackRule[];
  readonly entries: readonly { readonly id: string; readonly file: string; readonly packageName?: string }[];
  readonly issues: readonly IContributionFileIssue[];
  readonly rejected: readonly IRejectedEntry[];
}> {
  const out: IFeedbackRule[] = [];
  const entries: { readonly id: string; readonly file: string; readonly packageName?: string }[] = [];
  const issues: IContributionFileIssue[] = [];
  const rejected: IRejectedEntry[] = [];
  const seen = new Map<string, string>();
  const readInto = async (file: string, packageName?: string): Promise<void> => {
    const r = await importDefaultArray(file);
    if (r.error !== undefined) {
      const rel = nodePath.relative(inspection.projectRoot, file) || file;
      issues.push({
        severity: 'warning',
        code: 'load-failed',
        message: `${packageName ? `Pack ${packageName} (${rel})` : `Failed to load ${rel}`}: ${r.error}`,
        source: file,
        ...(packageName ? { packageName } : {}),
      });
      return;
    }
    r.items.forEach((item, index) => {
      const reasons = feedbackRuleRejectionReasons(item);
      if (reasons.length > 0) {
        rejected.push({ file, index, exportName: 'default', reasons, cause: RejectionCause.Invalid });
        return;
      }
      const rule = item as IFeedbackRule;
      const prev = seen.get(rule.id);
      if (prev !== undefined) {
        rejected.push({
          file,
          index,
          exportName: 'default',
          entryId: rule.id,
          reasons: [`id: "${rule.id}" is already declared in ${prev}`],
          cause: RejectionCause.DuplicateId,
        });
        return;
      }
      seen.set(rule.id, nodePath.relative(inspection.projectRoot, file) || file);
      out.push(rule);
      entries.push({ id: rule.id, file, ...(packageName ? { packageName } : {}) });
    });
  };
  // Local file.
  if (inspection.sharkcraftDir) {
    await readInto(nodePath.join(inspection.sharkcraftDir, 'feedback-rules.ts'));
  }
  // Pack contributions.
  const packs = inspection.packs?.validPacks ?? [];
  for (const pack of packs) {
    const c = (pack.manifest?.contributions ?? {}) as { feedbackRuleFiles?: readonly string[] };
    for (const rel of c.feedbackRuleFiles ?? []) {
      await readInto(nodePath.resolve(pack.packageRoot, rel), pack.packageName);
    }
  }
  return { rules: out, entries, issues, rejected };
}

/** A rules file's default array; `error` (first line) when the import threw. A missing file is `[]`. */
async function importDefaultArray(absPath: string): Promise<{ items: readonly unknown[]; error?: string }> {
  if (!existsSync(absPath)) return { items: [] };
  try {
    const mod = (await importModuleViaLoader(absPath)) as { default?: unknown };
    return { items: Array.isArray(mod.default) ? (mod.default as unknown[]) : [] };
  } catch (e) {
    return { items: [], error: ((e as Error).message ?? String(e)).split('\n')[0]!.trim() };
  }
}

export function renderFeedbackBacklog(report: IFeedbackReport): string {
  const lines: string[] = [];
  lines.push('# Feedback backlog');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  if (report.sourceFile) lines.push(`Source: ${report.sourceFile}`);
  lines.push('');
  const bucketOrder: FeedbackBucket[] = [
    FeedbackBucket.PainPoint,
    FeedbackBucket.Missing,
    FeedbackBucket.Bad,
    FeedbackBucket.Other,
    FeedbackBucket.Good,
  ];
  for (const b of bucketOrder) {
    const rows = report.findings.filter((f) => f.bucket === b);
    if (rows.length === 0) continue;
    lines.push(`## ${b}`);
    lines.push('');
    for (const r of rows) {
      lines.push(`- [${r.severity}] ${r.text}`);
      if (r.targetArea) lines.push(`  - target: ${r.targetArea}`);
      if (r.tags.length > 0) lines.push(`  - tags: ${r.tags.join(', ')}`);
      if (r.suggestedCommands.length > 0) {
        lines.push('  - commands:');
        for (const c of r.suggestedCommands) lines.push(`    - \`${c}\``);
      }
    }
    lines.push('');
  }
  if (report.suggestedNextRound.length > 0) {
    lines.push('## Suggested next round');
    for (const r of report.suggestedNextRound) lines.push(`- ${r}`);
  }
  return lines.join('\n') + '\n';
}
