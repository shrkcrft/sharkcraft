/**
 * Decision / ADR support.
 *
 * Decisions are markdown records with YAML-ish frontmatter living under
 * `sharkcraft/decisions/` or `docs/adr/`. SharkCraft does NOT auto-write
 * these — `decisions new` produces a dry-run preview unless
 * `--write-draft` is passed.
 *
 * Read-only operations: list, get, link (preview).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { importModuleViaLoader, RejectionCause, type IRejectedEntry } from '@shrkcrft/core';
import type { IContributionFileIssue } from './i-contribution-file-issue.ts';

export const DECISION_RECORD_SCHEMA = 'sharkcraft.decision/v1';

export enum DecisionStatus {
  Proposed = 'proposed',
  Accepted = 'accepted',
  Rejected = 'rejected',
  Superseded = 'superseded',
}

export interface IDecisionRecord {
  schema: typeof DECISION_RECORD_SCHEMA;
  id: string;
  title: string;
  status: DecisionStatus;
  context: string;
  decision: string;
  consequences: string;
  relatedRules: readonly string[];
  relatedPolicies: readonly string[];
  relatedConstructs: readonly string[];
  relatedFiles: readonly string[];
  /** Commands the decision relates to (TS decisions only) — probed by the self-config doctor. */
  relatedCommands?: readonly string[];
  date: string;
  sourceFile?: string;
}

export interface IDecisionDraftInput {
  id: string;
  title: string;
  status?: DecisionStatus;
  context?: string;
  decision?: string;
  consequences?: string;
  relatedRules?: readonly string[];
  relatedPolicies?: readonly string[];
  relatedConstructs?: readonly string[];
  relatedFiles?: readonly string[];
  date?: string;
}

const DECISION_DIRS = ['sharkcraft/decisions', 'docs/adr'] as const;

function frontmatterAndBody(text: string): { fm: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return { fm: {}, body: text };
  const fm: Record<string, string> = {};
  for (const line of (m[1] ?? '').split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim().replace(/^"(.*)"$/, '$1');
    fm[k] = v;
  }
  return { fm, body: m[2] ?? '' };
}

function sectionFromBody(body: string, header: string): string {
  const lines = body.split('\n');
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const isHeading = /^#{1,3}\s+/.test(line);
    if (isHeading) {
      if (inSection) break;
      if (new RegExp(`^#{1,3}\\s+${header}\\b`, 'i').test(line)) {
        inSection = true;
        continue;
      }
    } else if (inSection) {
      out.push(line);
    }
  }
  return out.join('\n').trim();
}

function listLinesUnder(body: string, header: string): string[] {
  const section = sectionFromBody(body, header);
  if (!section) return [];
  return section
    .split('\n')
    .map((l) => l.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean);
}

export function listDecisions(inspection: ISharkcraftInspection): readonly IDecisionRecord[] {
  const out: IDecisionRecord[] = [];
  const seenIds = new Set<string>();
  const addMd = (rec: IDecisionRecord): void => {
    if (seenIds.has(rec.id)) return;
    seenIds.add(rec.id);
    out.push(rec);
  };
  for (const rel of DECISION_DIRS) {
    const dir = nodePath.join(inspection.projectRoot, rel);
    if (!existsSync(dir)) continue;
    let entries: string[] = [];
    try {
      // Sort so the decision-record list (and the doctor findings derived from
      // it) is deterministic, not filesystem-order-dependent.
      entries = readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!/\.(md|markdown)$/i.test(f)) continue;
      const full = nodePath.join(dir, f);
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
      } catch {
        continue;
      }
      const text = readFileSync(full, 'utf8');
      const { fm, body } = frontmatterAndBody(text);
      const id = (fm['id'] ?? nodePath.basename(f, nodePath.extname(f))).trim();
      const title = fm['title'] ?? id;
      const status = (fm['status'] as DecisionStatus) ?? DecisionStatus.Proposed;
      const date = fm['date'] ?? '';
      addMd({
        schema: DECISION_RECORD_SCHEMA,
        id,
        title,
        status,
        context: sectionFromBody(body, 'Context'),
        decision: sectionFromBody(body, 'Decision'),
        consequences: sectionFromBody(body, 'Consequences'),
        relatedRules: listLinesUnder(body, 'Related rules'),
        relatedPolicies: listLinesUnder(body, 'Related policies'),
        relatedConstructs: listLinesUnder(body, 'Related constructs'),
        relatedFiles: listLinesUnder(body, 'Related files'),
        date,
        sourceFile: full,
      });
    }
  }
  // Also include sync-cached TS decisions if present (loaded by
  // listDecisionsTsCached on prior async warm-up). Best-effort sync read.
  for (const r of getTsDecisionsCached(inspection.projectRoot)) {
    if (seenIds.has(r.id)) continue;
    seenIds.add(r.id);
    out.push(r);
  }
  return out;
}

interface ITsDecisionInput {
  id: string;
  title: string;
  status?: DecisionStatus | string;
  date?: string;
  context?: string;
  decision?: string;
  consequences?: string;
  relatedRules?: readonly string[];
  relatedPolicies?: readonly string[];
  relatedConstructs?: readonly string[];
  relatedFiles?: readonly string[];
  relatedKnowledge?: readonly string[];
  relatedTemplates?: readonly string[];
  relatedPlaybooks?: readonly string[];
  relatedCommands?: readonly string[];
}

const TS_DECISION_CACHE = new Map<string, readonly IDecisionRecord[]>();

function getTsDecisionsCached(projectRoot: string): readonly IDecisionRecord[] {
  return TS_DECISION_CACHE.get(projectRoot) ?? [];
}

/**
 * THE TS-decision acceptance predicate (round 12, 12.1): a non-empty string
 * `id` — `[]` means accepted. An id-less decision used to be dropped with no
 * signal (`if (!rec?.id) return`).
 */
export function decisionRejectionReasons(raw: unknown): readonly string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['(entry): must be an object'];
  const id = (raw as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? [] : ['id: must be a non-empty string'];
}

/**
 * Async warm-up for `sharkcraft/decisions.ts` and pack-contributed
 * decisions. Call this before `listDecisions` if you want TS decisions
 * folded in.
 */
export async function loadTsDecisions(
  inspection: ISharkcraftInspection,
): Promise<readonly IDecisionRecord[]> {
  return (await loadTsDecisionsWithIssues(inspection)).decisions;
}

/**
 * {@link loadTsDecisions} with what did not take effect (round 12, 12.1): a
 * decision file that failed to import (it used to be swallowed to `[]`), and
 * every declared decision the loader refused — invalid, or a duplicate id.
 */
export async function loadTsDecisionsWithIssues(inspection: ISharkcraftInspection): Promise<{
  readonly decisions: readonly IDecisionRecord[];
  readonly issues: readonly IContributionFileIssue[];
  readonly rejected: readonly IRejectedEntry[];
}> {
  const out: IDecisionRecord[] = [];
  const issues: IContributionFileIssue[] = [];
  const rejected: IRejectedEntry[] = [];
  const seen = new Map<string, string>();
  const addInput = (raw: unknown, source: string, index: number): void => {
    const reasons = decisionRejectionReasons(raw);
    if (reasons.length > 0) {
      rejected.push({ file: source, index, exportName: 'default', reasons, cause: RejectionCause.Invalid });
      return;
    }
    const rec = raw as ITsDecisionInput;
    const prev = seen.get(rec.id);
    if (prev !== undefined) {
      rejected.push({
        file: source,
        index,
        exportName: 'default',
        entryId: rec.id,
        reasons: [`id: "${rec.id}" is already declared in ${prev}`],
        cause: RejectionCause.DuplicateId,
      });
      return;
    }
    seen.set(rec.id, source);
    out.push({
      schema: DECISION_RECORD_SCHEMA,
      id: rec.id,
      title: rec.title ?? rec.id,
      status: ((rec.status as DecisionStatus) ?? DecisionStatus.Proposed) as DecisionStatus,
      context: rec.context ?? '',
      decision: rec.decision ?? '',
      consequences: rec.consequences ?? '',
      relatedRules: rec.relatedRules ?? [],
      relatedPolicies: rec.relatedPolicies ?? [],
      relatedConstructs: rec.relatedConstructs ?? [],
      relatedFiles: rec.relatedFiles ?? [],
      ...(rec.relatedCommands && rec.relatedCommands.length > 0
        ? { relatedCommands: rec.relatedCommands }
        : {}),
      date: rec.date ?? '',
      sourceFile: source,
    });
  };
  const readInto = async (file: string, packageName?: string): Promise<void> => {
    const r = await importDefaultArray(file);
    if (r.error !== undefined) {
      issues.push({
        severity: 'warning',
        code: 'load-failed',
        message: `${packageName ? `Pack ${packageName} (${nodePath.relative(inspection.projectRoot, file) || file})` : `Failed to load ${nodePath.relative(inspection.projectRoot, file) || file}`}: ${r.error}`,
        source: file,
        ...(packageName ? { packageName } : {}),
      });
      return;
    }
    r.items.forEach((item, i) => addInput(item, file, i));
  };
  // Local file.
  if (inspection.sharkcraftDir) {
    await readInto(nodePath.join(inspection.sharkcraftDir, 'decisions.ts'));
  }
  // Pack contributions.
  for (const pack of inspection.packs.validPacks) {
    const c = (pack.manifest?.contributions ?? {}) as { decisionFiles?: readonly string[] };
    for (const rel of c.decisionFiles ?? []) {
      await readInto(nodePath.resolve(pack.packageRoot, rel), pack.packageName);
    }
  }
  TS_DECISION_CACHE.set(inspection.projectRoot, out);
  return { decisions: out, issues, rejected };
}

/** A decision file's default array; `error` (first line) when the import threw. A missing file is `[]`. */
async function importDefaultArray(absPath: string): Promise<{ items: readonly unknown[]; error?: string }> {
  if (!existsSync(absPath)) return { items: [] };
  try {
    const mod = (await importModuleViaLoader(absPath)) as { default?: unknown };
    return { items: Array.isArray(mod.default) ? (mod.default as unknown[]) : [] };
  } catch (e) {
    return { items: [], error: ((e as Error).message ?? String(e)).split('\n')[0]!.trim() };
  }
}

export function getDecision(inspection: ISharkcraftInspection, id: string): IDecisionRecord | undefined {
  return listDecisions(inspection).find((d) => d.id === id);
}

export function previewDecisionDraft(input: IDecisionDraftInput): string {
  const id = input.id.trim();
  const lines: string[] = [];
  lines.push('---');
  lines.push(`id: ${id}`);
  lines.push(`title: ${input.title}`);
  lines.push(`status: ${input.status ?? DecisionStatus.Proposed}`);
  lines.push(`date: ${input.date ?? new Date().toISOString().slice(0, 10)}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${input.title}`);
  lines.push('');
  lines.push('## Context');
  lines.push(input.context ?? '_TBD — describe the forces, constraints, and why a decision is needed._');
  lines.push('');
  lines.push('## Decision');
  lines.push(input.decision ?? '_TBD — describe the chosen direction._');
  lines.push('');
  lines.push('## Consequences');
  lines.push(input.consequences ?? '_TBD — describe positive + negative implications._');
  lines.push('');
  if (input.relatedRules?.length) {
    lines.push('## Related rules');
    for (const r of input.relatedRules) lines.push(`- ${r}`);
    lines.push('');
  }
  if (input.relatedPolicies?.length) {
    lines.push('## Related policies');
    for (const p of input.relatedPolicies) lines.push(`- ${p}`);
    lines.push('');
  }
  if (input.relatedConstructs?.length) {
    lines.push('## Related constructs');
    for (const c of input.relatedConstructs) lines.push(`- ${c}`);
    lines.push('');
  }
  if (input.relatedFiles?.length) {
    lines.push('## Related files');
    for (const f of input.relatedFiles) lines.push(`- ${f}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function decisionDraftTargetPath(projectRoot: string, id: string): string {
  return nodePath.join(projectRoot, 'sharkcraft/decisions', `${id}.md`);
}
