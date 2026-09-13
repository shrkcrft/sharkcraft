/**
 * Task routing hint registry. Pack- and local-contributed task
 * routing hints bias the recommender output toward project-specific
 * playbooks / templates / helpers / profiles / conventions / knowledge.
 *
 * Engine ships zero hints; everything comes from contributions.
 */
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  TermMatchMode,
  validateTaskRoutingHint,
  type ITaskRoutingHint,
} from '@shrkcrft/plugin-api';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import {
  importModuleViaLoader,
  readContributionExport,
  RejectionCause,
  type IContributionExport,
  type IRejectedEntry,
} from '@shrkcrft/core';
import { matchTerm, prepareTermQuery } from './match-terms.ts';
import { nearestIds } from './nearest-id.ts';
import {
  isRoutingRecommendsChannel,
  ROUTING_RECOMMENDS_CHANNEL_KEYS,
} from './routing-recommends-channels.ts';

/** Criteria the matcher reads — keywords (+2), phrases (+3), regexes (+2). */
const UNSCORED_MATCH_FIELDS = ['languages', 'fileGlobs', 'constructKinds'] as const;

/**
 * In substring mode a needle shorter than this fires inside unrelated words
 * (`ci` in "pricing", `gate` in "investigate") — the load lint warns.
 */
const SHORT_SUBSTRING_LIMIT = 4;

/** The hint's keyword/phrase match mode — `tokens` unless it opts into `substring`. */
export function routingMatchMode(hint: ITaskRoutingHint): TermMatchMode {
  return (hint.match?.mode as string) === TermMatchMode.Substring ? TermMatchMode.Substring : TermMatchMode.Tokens;
}

function regexCompiles(source: string): boolean {
  try {
    new RegExp(source, 'i');
    return true;
  } catch {
    return false;
  }
}

/**
 * Can this hint EVER match a task? True when it declares a keyword or phrase
 * (an empty one matches everything — the load lint errors on it) or a regex
 * that compiles. A hint declaring only unscored criteria (`fileGlobs`,
 * `languages`, `constructKinds`) or only a broken regex is dead on arrival.
 */
export function routingHintCanMatch(hint: ITaskRoutingHint): boolean {
  const m = hint.match ?? {};
  if ((m.keywords ?? []).length > 0 || (m.phrases ?? []).length > 0) return true;
  return (m.regexes ?? []).some((r) => typeof r === 'string' && regexCompiles(r));
}

/**
 * Load-time lints over one VALID hint: what the matcher will silently get
 * wrong. The matcher swallowed an invalid regex at match time and scored a
 * hint of only `fileGlobs` at zero, with no diagnostic anywhere.
 */
function lintRoutingHint(
  hint: ITaskRoutingHint,
  sourceFile: string,
  issues: ITaskRoutingHintDoctorIssue[],
): void {
  const push = (severity: ITaskRoutingHintDoctorIssue['severity'], code: string, message: string): void => {
    issues.push({ severity, code, message, hintId: hint.id, source: sourceFile });
  };
  const m = hint.match ?? {};
  for (const r of m.regexes ?? []) {
    try {
      new RegExp(r, 'i');
    } catch (e) {
      push('error', 'invalid-regex', `Routing hint "${hint.id}" regex /${r}/ does not compile (${(e as Error).message}), so it never matches.`);
    }
  }
  const empties = [...(m.keywords ?? []), ...(m.phrases ?? [])].filter(
    (t) => typeof t !== 'string' || t.trim().length === 0,
  );
  if (empties.length > 0) {
    push(
      'error',
      'empty-trigger',
      routingMatchMode(hint) === TermMatchMode.Substring
        ? `Routing hint "${hint.id}" declares an empty keyword/phrase — every task contains it, so the hint matches everything.`
        : `Routing hint "${hint.id}" declares an empty keyword/phrase — it can never match (and in substring mode it would match every task).`,
    );
  }
  if (routingMatchMode(hint) === TermMatchMode.Substring) {
    for (const t of [...(m.keywords ?? []), ...(m.phrases ?? [])]) {
      if (typeof t !== 'string') continue;
      const needle = t.trim();
      if (needle.length === 0 || needle.length >= SHORT_SUBSTRING_LIMIT) continue;
      push(
        'warning',
        'short-substring-keyword',
        `Routing hint "${hint.id}": "${needle}" (${needle.length} chars) matches inside unrelated words in substring mode — use mode: 'tokens' or a regex with \\b.`,
      );
    }
  }
  const unscored = UNSCORED_MATCH_FIELDS.filter((f) => (m[f] ?? []).length > 0);
  if (!routingHintCanMatch(hint)) {
    push(
      'warning',
      unscored.length > 0 ? 'unscored-match-criteria' : 'no-match-criteria',
      unscored.length > 0
        ? `Routing hint "${hint.id}" declares only ${unscored.join(' / ')}, which the matcher does not score (it reads keywords, phrases and regexes), so it can never match.`
        : `Routing hint "${hint.id}" declares no keyword, phrase or compiling regex, so it can never match.`,
    );
  } else if (unscored.length > 0) {
    push(
      'info',
      'ignored-match-criteria',
      `Routing hint "${hint.id}" declares ${unscored.join(' / ')}, which the matcher does not score today; only its keywords / phrases / regexes decide a match.`,
    );
  }
  for (const key of Object.keys(hint.recommends ?? {})) {
    if (isRoutingRecommendsChannel(key)) continue;
    const near = nearestIds(key, ROUTING_RECOMMENDS_CHANNEL_KEYS, 1)[0];
    push(
      'warning',
      'unknown-recommends-key',
      `Routing hint "${hint.id}" recommends.${key} is not a channel (${ROUTING_RECOMMENDS_CHANNEL_KEYS.join(', ')}), so nothing reads it.${near ? ` Did you mean "${near.id}"?` : ''}`,
    );
  }
}

/** The normalized trigger set: two hints with the same one always match together. */
function triggerSignature(hint: ITaskRoutingHint): string {
  const m = hint.match ?? {};
  const parts = new Set<string>();
  for (const k of m.keywords ?? []) if (typeof k === 'string' && k.trim()) parts.add(`k:${k.trim().toLowerCase()}`);
  for (const p of m.phrases ?? []) if (typeof p === 'string' && p.trim()) parts.add(`p:${p.trim().toLowerCase()}`);
  for (const r of m.regexes ?? []) if (typeof r === 'string' && r) parts.add(`r:${r}`);
  if (parts.size > 0 && routingMatchMode(hint) === TermMatchMode.Substring) parts.add('m:substring');
  return [...parts].sort().join('\n');
}

export const TASK_ROUTING_HINT_REGISTRY_SCHEMA = 'sharkcraft.task-routing-hint-registry/v1';

export enum TaskRoutingHintSource {
  Local = 'local',
  Pack = 'pack',
  Fixture = 'fixture',
}

export interface ITaskRoutingHintEntry {
  readonly hint: ITaskRoutingHint;
  readonly source: TaskRoutingHintSource;
  readonly packageName?: string;
  readonly sourceFile: string;
}

export interface ITaskRoutingHintDoctorIssue {
  readonly severity: 'info' | 'warning' | 'error';
  readonly code: string;
  readonly message: string;
  readonly hintId?: string;
  readonly source?: string;
}

async function importHints(file: string): Promise<IContributionExport> {
  return readContributionExport(await importModuleViaLoader(file), { namedKeys: ['taskRoutingHints'] });
}

/**
 * THE routing-hint acceptance predicate (round 12, 12.1): every issue of
 * `validateTaskRoutingHint`, `<field>: <message>` — `[]` means accepted.
 */
export function routingHintRejectionReasons(raw: unknown): readonly string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['(entry): must be an object'];
  const v = validateTaskRoutingHint(raw as ITaskRoutingHint);
  if (v.valid) return [];
  return v.issues.length > 0 ? v.issues.map((i) => `${i.field}: ${i.message}`) : ['(entry): failed validation'];
}

function localFiles(inspection: ISharkcraftInspection): string[] {
  const out: string[] = [];
  const dir = inspection.sharkcraftDir;
  if (!dir) return [];
  for (const name of ['task-routing-hints.ts', 'task-routing-hints/index.ts']) {
    const abs = nodePath.join(dir, name);
    if (existsSync(abs)) out.push(abs);
  }
  for (const rel of inspection.config?.taskRoutingHintFiles ?? []) {
    out.push(nodePath.isAbsolute(rel) ? rel : nodePath.join(dir, rel));
  }
  return out;
}

export async function loadTaskRoutingHints(
  inspection: ISharkcraftInspection,
): Promise<{
  entries: readonly ITaskRoutingHintEntry[];
  issues: readonly ITaskRoutingHintDoctorIssue[];
  /** Hint files the loader tried (local + pack-declared) — the doctor's file coverage. */
  files: number;
  /** Every declared hint the loader refused — invalid or a duplicate id (round 12, 12.1). */
  rejected: readonly IRejectedEntry[];
}> {
  const entries: ITaskRoutingHintEntry[] = [];
  const issues: ITaskRoutingHintDoctorIssue[] = [];
  const rejected: IRejectedEntry[] = [];
  const seen = new Map<string, string>();
  let files = 0;

  const ingest = (
    raw: unknown,
    source: TaskRoutingHintSource,
    packageName: string | undefined,
    sourceFile: string,
    at: Pick<IRejectedEntry, 'file' | 'index' | 'exportName'>,
  ): void => {
    const rawId = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined;
    const hintId = typeof rawId === 'string' ? rawId : undefined;
    const reasons = routingHintRejectionReasons(raw);
    if (reasons.length > 0) {
      for (const r of reasons) {
        issues.push({ severity: 'error', code: 'invalid-hint', message: r, hintId, source: sourceFile });
      }
      rejected.push({ ...at, ...(hintId !== undefined ? { entryId: hintId } : {}), reasons, cause: RejectionCause.Invalid });
      return;
    }
    const hint = raw as ITaskRoutingHint;
    const prev = seen.get(hint.id);
    if (prev !== undefined) {
      issues.push({
        severity: 'error',
        code: 'duplicate-id',
        message: `Task routing hint "${hint.id}" already loaded; skipping ${sourceFile}.`,
        hintId: hint.id,
        source: sourceFile,
      });
      rejected.push({
        ...at,
        entryId: hint.id,
        reasons: [`id: "${hint.id}" is already declared in ${prev}`],
        cause: RejectionCause.DuplicateId,
      });
      return;
    }
    seen.set(hint.id, sourceFile);
    lintRoutingHint(hint, sourceFile, issues);
    entries.push({
      hint,
      source,
      ...(packageName ? { packageName } : {}),
      sourceFile,
    });
  };
  const ingestAll = (
    exp: IContributionExport,
    file: string,
    source: TaskRoutingHintSource,
    packageName: string | undefined,
    sourceFile: string,
  ): void => {
    exp.items.forEach((h, i) =>
      ingest(h, source, packageName, sourceFile, {
        file,
        index: exp.single ? -1 : i,
        ...(exp.exportName ? { exportName: exp.exportName } : {}),
      }),
    );
  };

  for (const file of localFiles(inspection)) {
    files += 1;
    try {
      const exp = await importHints(file);
      const rel = nodePath.relative(inspection.projectRoot, file) || file;
      ingestAll(exp, file, TaskRoutingHintSource.Local, undefined, rel);
    } catch (e) {
      issues.push({
        severity: 'warning',
        code: 'load-failed',
        message: `Failed to load ${file}: ${(e as Error).message}`,
        source: file,
      });
    }
  }
  for (const pack of inspection.packs.validPacks ?? []) {
    const contributions = (pack.manifest?.contributions ?? {}) as { taskRoutingHintFiles?: readonly string[] };
    for (const rel of contributions.taskRoutingHintFiles ?? []) {
      const file = nodePath.resolve(pack.packageRoot, rel);
      files += 1;
      if (!existsSync(file)) {
        issues.push({
          severity: 'warning',
          code: 'missing-file',
          message: `Pack ${pack.packageName} declares ${rel} but file is missing.`,
          source: file,
        });
        continue;
      }
      try {
        ingestAll(await importHints(file), file, TaskRoutingHintSource.Pack, pack.packageName, rel);
      } catch (e) {
        issues.push({
          severity: 'warning',
          code: 'load-failed',
          message: `Pack ${pack.packageName} (${rel}): ${(e as Error).message}`,
          source: file,
        });
      }
    }
  }
  // Identical trigger sets: both hints match the same tasks with the same score,
  // so neither can outrank the other — almost always a copy-paste.
  const firstWith = new Map<string, ITaskRoutingHintEntry>();
  for (const e of entries) {
    const signature = triggerSignature(e.hint);
    if (!signature) continue;
    const first = firstWith.get(signature);
    if (!first) {
      firstWith.set(signature, e);
      continue;
    }
    issues.push({
      severity: 'warning',
      code: 'duplicate-trigger',
      message: `Routing hints "${first.hint.id}" and "${e.hint.id}" declare the same match criteria, so they always match the same tasks with the same score.`,
      hintId: e.hint.id,
      source: e.sourceFile,
    });
  }
  return { entries, issues, files, rejected };
}

export async function listTaskRoutingHints(
  inspection: ISharkcraftInspection,
): Promise<readonly ITaskRoutingHintEntry[]> {
  const { entries } = await loadTaskRoutingHints(inspection);
  return entries;
}

export async function listTaskRoutingHintIssues(
  inspection: ISharkcraftInspection,
): Promise<readonly ITaskRoutingHintDoctorIssue[]> {
  const { issues } = await loadTaskRoutingHints(inspection);
  return issues;
}

export interface ITaskRoutingMatchResult {
  readonly hint: ITaskRoutingHint;
  readonly source: TaskRoutingHintSource;
  readonly packageName?: string;
  readonly score: number;
  readonly reasons: readonly string[];
}

export async function explainTaskRouting(
  inspection: ISharkcraftInspection,
  task: string,
): Promise<readonly ITaskRoutingMatchResult[]> {
  const entries = await listTaskRoutingHints(inspection);
  // THE term matcher: tokens mode by default, so `ci` no longer fires inside
  // "pricing" and `capability-pack` matches "capability pack".
  const query = prepareTermQuery(task);
  const out: ITaskRoutingMatchResult[] = [];
  for (const e of entries) {
    let score = 0;
    const reasons: string[] = [];
    const mode = routingMatchMode(e.hint);
    const tag = mode === TermMatchMode.Substring ? ' (substring)' : '';
    for (const kw of e.hint.match.keywords ?? []) {
      if (matchTerm(query, kw, mode)) {
        score += 2;
        reasons.push(`keyword: ${kw}${tag}`);
      }
    }
    for (const p of e.hint.match.phrases ?? []) {
      if (matchTerm(query, p, mode)) {
        score += 3;
        reasons.push(`phrase: ${p}${tag}`);
      }
    }
    for (const r of e.hint.match.regexes ?? []) {
      try {
        if (new RegExp(r, 'i').test(task)) {
          score += 2;
          reasons.push(`regex: ${r}`);
        }
      } catch {
        // ignore
      }
    }
    if (score > 0) {
      const result: ITaskRoutingMatchResult = {
        hint: e.hint,
        source: e.source,
        ...(e.packageName ? { packageName: e.packageName } : {}),
        score: score + (e.hint.confidenceBoost ?? 0),
        reasons,
      };
      out.push(result);
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
