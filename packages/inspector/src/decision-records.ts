/**
 * Decision / ADR support.
 *
 * Decisions are markdown records with YAML-ish frontmatter living under
 * `sharkcraft/decisions/` or `docs/adr/`. SharkCraft does NOT auto-write
 * these — `decisions new` produces a dry-run preview unless
 * `--write-draft` is passed.
 *
 * The frontmatter is read by THE parser (`splitFrontmatter` +
 * `parseFrontmatter`, @shrkcrft/core — round 15 follow-up, F6) in its `Text`
 * scalar mode: a decision's `id` / `title` / `status` / `date` are strings by
 * contract, read verbatim as the old line splitter read them (`id: 0001`
 * stays `0001`, `title: Fix #12` keeps its `#12`). A record whose frontmatter
 * cannot be read as declared is REJECTED through the round-12 channel
 * ({@link loadTsDecisionsWithIssues} `rejected`) — never listed from a partial
 * reading, never dropped silently.
 *
 * Read-only operations: list, get, link (preview).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import {
  formatFrontmatterScalar,
  FrontmatterScalarMode,
  importModuleViaLoader,
  parseFrontmatter,
  RejectionCause,
  splitFrontmatter,
  type FrontmatterValue,
  type IParseFrontmatterOptions,
  type IRejectedEntry,
} from '@shrkcrft/core';
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

/**
 * A decision's frontmatter values are strings by contract — read verbatim
 * (`Text` scalars), exactly as {@link previewDecisionDraft} writes them. Only
 * the four keys a record reads are parsed (`keys`): any other key — MADR's
 * `decision makers:`, a `summary:` wrapped onto an indented line, a map nested
 * two levels — is skipped unparsed. The old splitter never read those lines
 * either, and YAML the parser does not speak under a key nobody reads must not
 * cost the record (the Markdown knowledge loader skips a key it drops the same
 * way). No key is read as a list (`listKeys: []`, round 15 closing A1): an
 * inline `title: [WIP]` is the title `[WIP]`, verbatim, as the old splitter
 * read it — it used to REJECT the record as "a list".
 */
const DECISION_FRONTMATTER: IParseFrontmatterOptions = Object.freeze({
  scalars: FrontmatterScalarMode.Text,
  keys: Object.freeze(['id', 'title', 'status', 'date']),
  listKeys: Object.freeze([]),
});

/** One Markdown decision file, read: its record, or why it was refused. */
type MarkdownDecisionRead = { readonly record: IDecisionRecord } | { readonly rejected: IRejectedEntry };

function shapeOf(value: FrontmatterValue): string {
  if (!Array.isArray(value)) return 'a map';
  return (value as readonly unknown[]).some((v) => v !== null && typeof v === 'object') ? 'a list of maps' : 'a list';
}

/**
 * Read one Markdown decision record through THE frontmatter parser. Frontmatter
 * the parser refuses in its top-level structure (a stray line naming no key)
 * or under a key the record reads (`title:` wrapped onto an indented line), or
 * an `id` / `title` / `status` / `date` that is not a single value (a block
 * list under `title:`; an inline `title: [WIP]` is text) REJECTS the record, every reason named: the
 * old line splitter skipped such a line silently and let an indented `  id:`
 * under any block overwrite the record's own id. A key the record does not
 * read is never parsed ({@link DECISION_FRONTMATTER}).
 */
function readMarkdownDecision(full: string, fileName: string): MarkdownDecisionRead {
  const split = splitFrontmatter(readFileSync(full, 'utf8'));
  const problems: string[] = [];
  // A decision record opening with `---` and never closing it is broken
  // frontmatter, not a thematic break: its `id:` would silently become the
  // file name (the old splitter did exactly that).
  if (split.unterminated) problems.push('frontmatter: an opening --- line has no closing --- line');
  let fields: Readonly<Record<string, FrontmatterValue>> = {};
  if (split.frontmatter !== undefined) {
    const parsed = parseFrontmatter(split.frontmatter, { ...DECISION_FRONTMATTER, lineOffset: split.lineOffset });
    if (parsed.ok) fields = parsed.value;
    else problems.push(`frontmatter: ${parsed.error.message}`);
  }
  const text = (key: string): string | undefined => {
    const v = fields[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    problems.push(`${key}: must be a single value (got ${shapeOf(v)}) — quote it if it is text`);
    return undefined;
  };
  const declaredId = text('id')?.trim();
  const title = text('title');
  const status = text('status');
  const date = text('date');
  if (problems.length > 0) {
    return {
      rejected: {
        file: full,
        index: -1,
        ...(declaredId ? { entryId: declaredId } : {}),
        reasons: problems,
        cause: RejectionCause.Invalid,
      },
    };
  }
  // A key with no value (`id:`, `title:`, `status:`) is absent and falls back to
  // its default — the old splitter read `id:` as the id "" and `title:` as the
  // title "". An id that is empty after trimming falls back too: "" can never
  // be referenced.
  const id = declaredId || nodePath.basename(fileName, nodePath.extname(fileName)).trim();
  const body = split.body;
  return {
    record: {
      schema: DECISION_RECORD_SCHEMA,
      id,
      title: title ?? id,
      status: (status as DecisionStatus | undefined) ?? DecisionStatus.Proposed,
      context: sectionFromBody(body, 'Context'),
      decision: sectionFromBody(body, 'Decision'),
      consequences: sectionFromBody(body, 'Consequences'),
      relatedRules: listLinesUnder(body, 'Related rules'),
      relatedPolicies: listLinesUnder(body, 'Related policies'),
      relatedConstructs: listLinesUnder(body, 'Related constructs'),
      relatedFiles: listLinesUnder(body, 'Related files'),
      date: date ?? '',
      sourceFile: full,
    },
  };
}

/**
 * Every Markdown decision record under {@link DECISION_DIRS}, in a
 * deterministic order: the records read, and every file refused. THE one pass
 * both {@link listDecisions} (records) and {@link loadTsDecisionsWithIssues}
 * (rejected) read, so what is listed and what is reported cannot disagree.
 */
function scanMarkdownDecisions(projectRoot: string): {
  readonly records: readonly IDecisionRecord[];
  readonly rejected: readonly IRejectedEntry[];
} {
  const records: IDecisionRecord[] = [];
  const rejected: IRejectedEntry[] = [];
  for (const rel of DECISION_DIRS) {
    const dir = nodePath.join(projectRoot, rel);
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
      const read = readMarkdownDecision(full, f);
      if ('record' in read) records.push(read.record);
      else rejected.push(read.rejected);
    }
  }
  return { records, rejected };
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
  // A Markdown record whose frontmatter cannot be read as declared is not
  // listed — `loadTsDecisionsWithIssues` reports it rejected (same scan).
  for (const rec of scanMarkdownDecisions(inspection.projectRoot).records) addMd(rec);
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
 * `rejected` also carries every Markdown record (`sharkcraft/decisions/*.md`,
 * `docs/adr/*.md`) whose frontmatter THE parser cannot read as declared (round
 * 15 follow-up, F6) — the same scan {@link listDecisions} reads, so a record is
 * either listed or reported here, never neither.
 */
export async function loadTsDecisionsWithIssues(inspection: ISharkcraftInspection): Promise<{
  readonly decisions: readonly IDecisionRecord[];
  readonly issues: readonly IContributionFileIssue[];
  readonly rejected: readonly IRejectedEntry[];
}> {
  const out: IDecisionRecord[] = [];
  const issues: IContributionFileIssue[] = [];
  const rejected: IRejectedEntry[] = [...scanMarkdownDecisions(inspection.projectRoot).rejected];
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
  // Each value is written so THE parser reads it back as written (round 15
  // follow-up, F6): a raw `title: [WIP]` reads as a list, `title: "Quoted"` as
  // `Quoted`. A value that already reads back stays bare.
  const value = (v: string): string => formatFrontmatterScalar(v, DECISION_FRONTMATTER);
  const lines: string[] = [];
  lines.push('---');
  lines.push(`id: ${value(id)}`);
  lines.push(`title: ${value(input.title)}`);
  lines.push(`status: ${value(input.status ?? DecisionStatus.Proposed)}`);
  lines.push(`date: ${value(input.date ?? new Date().toISOString().slice(0, 10))}`);
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
