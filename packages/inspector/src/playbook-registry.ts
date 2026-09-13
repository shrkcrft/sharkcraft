import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { TermMatchMode, type IPlaybookInput, type IPlaybookStep } from '@shrkcrft/plugin-api';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import {
  importModuleViaLoader,
  readContributionExport,
  RejectionCause,
  type IContributionExport,
  type IRejectedEntry,
} from '@shrkcrft/core';
import { contentTerms, matchedQueryTerms, matchTerm, prepareTermQuery, termJaccard } from './match-terms.ts';
import type { IPlaybookLoadIssue } from './playbook-load-issue.ts';

export const PLAYBOOK_REGISTRY_SCHEMA = 'sharkcraft.playbook-registry/v1';

export interface IPlaybook extends IPlaybookInput {
  source: 'local' | 'pack';
  packageName?: string;
  sourceFile?: string;
}

interface ICacheEntry {
  cacheKey: string;
  list: IPlaybook[];
  issues: IPlaybookLoadIssue[];
  rejected: IRejectedEntry[];
  /** Files the loader tried (local + pack-declared), for the doctor's coverage. */
  files: number;
}

const CACHE = new Map<string, ICacheEntry>();

async function importPlaybooks(file: string): Promise<IContributionExport> {
  return readContributionExport(await importModuleViaLoader(file), { namedKeys: ['playbooks'] });
}

/**
 * THE playbook acceptance predicate (round 12, 12.1 / 12.1d): a string `id`
 * and an array `steps` — `[]` means accepted. An id-less playbook used to be
 * dropped silently (`if (!p?.id) continue`), and one with no `steps` was
 * ACCEPTED and then crashed the self-config doctor (`p.steps.forEach`).
 */
export function playbookRejectionReasons(raw: unknown): readonly string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['(entry): must be an object'];
  const p = raw as Record<string, unknown>;
  const out: string[] = [];
  if (typeof p.id !== 'string' || p.id.length === 0) out.push('id: must be a non-empty string');
  if (!Array.isArray(p.steps)) out.push('steps: must be an array');
  return out;
}

function localPlaybookFiles(inspection: ISharkcraftInspection): string[] {
  const out: string[] = [];
  const dir = inspection.sharkcraftDir;
  if (!dir) return [];
  for (const f of ['playbooks.ts', 'playbooks/index.ts']) {
    const full = nodePath.join(dir, f);
    if (existsSync(full)) out.push(full);
  }
  for (const rel of inspection.config?.playbookFiles ?? []) out.push(nodePath.join(dir, rel));
  return out;
}

function firstLine(s: string): string {
  return (s.split('\n')[0] ?? s).trim();
}

/**
 * Load every local and pack playbook, and report the files that did not take
 * effect. Import failures used to be swallowed (`catch { ignore }`), so a
 * broken `playbooks.ts` reported a healthy, merely smaller registry.
 */
export async function loadPlaybooksWithIssues(
  inspection: ISharkcraftInspection,
): Promise<{
  readonly playbooks: readonly IPlaybook[];
  readonly issues: readonly IPlaybookLoadIssue[];
  readonly files: number;
  /** Every declared playbook the loader refused (round 12, 12.1). */
  readonly rejected: readonly IRejectedEntry[];
}> {
  const cacheKey = `${inspection.projectRoot}:${inspection.packs.validPacks
    .map((p) => p.packageName + '@' + p.packageVersion)
    .join(',')}`;
  const cached = CACHE.get(inspection.projectRoot);
  if (cached && cached.cacheKey === cacheKey) {
    return { playbooks: cached.list, issues: cached.issues, files: cached.files, rejected: cached.rejected };
  }
  const out: IPlaybook[] = [];
  const issues: IPlaybookLoadIssue[] = [];
  const rejected: IRejectedEntry[] = [];
  let files = 0;
  const ingestAll = (
    exp: IContributionExport,
    file: string,
    origin: { readonly source: 'local' | 'pack'; readonly packageName?: string; readonly sourceFile: string },
  ): void => {
    exp.items.forEach((raw, i) => {
      const reasons = playbookRejectionReasons(raw);
      if (reasons.length > 0) {
        const id = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined;
        rejected.push({
          file,
          index: exp.single ? -1 : i,
          ...(exp.exportName ? { exportName: exp.exportName } : {}),
          ...(typeof id === 'string' && id.length > 0 ? { entryId: id } : {}),
          reasons,
          cause: RejectionCause.Invalid,
        });
        return;
      }
      out.push({
        ...(raw as IPlaybookInput),
        source: origin.source,
        ...(origin.packageName ? { packageName: origin.packageName } : {}),
        sourceFile: origin.sourceFile,
      });
    });
  };
  for (const file of localPlaybookFiles(inspection)) {
    files += 1;
    if (!existsSync(file)) {
      issues.push({
        severity: 'warning',
        code: 'missing-file',
        message: `playbookFiles declares ${nodePath.relative(inspection.projectRoot, file) || file} but the file is missing.`,
        source: file,
      });
      continue;
    }
    try {
      ingestAll(await importPlaybooks(file), file, {
        source: 'local',
        sourceFile: nodePath.relative(inspection.projectRoot, file),
      });
    } catch (e) {
      issues.push({
        severity: 'warning',
        code: 'load-failed',
        message: `Failed to load ${nodePath.relative(inspection.projectRoot, file) || file}: ${firstLine((e as Error).message ?? String(e))}`,
        source: file,
      });
    }
  }
  for (const pack of inspection.packs.validPacks ?? []) {
    const contributions = (pack.manifest?.contributions ?? {}) as {
      playbookFiles?: readonly string[];
    };
    const packRoot = pack.packageRoot;
    if (!packRoot) continue;
    for (const rel of contributions.playbookFiles ?? []) {
      const file = nodePath.resolve(packRoot, rel);
      files += 1;
      if (!existsSync(file)) {
        issues.push({
          severity: 'warning',
          code: 'missing-file',
          message: `Pack ${pack.packageName} declares ${rel} but the file is missing.`,
          source: file,
          packageName: pack.packageName,
        });
        continue;
      }
      try {
        ingestAll(await importPlaybooks(file), file, {
          source: 'pack',
          packageName: pack.packageName,
          sourceFile: rel,
        });
      } catch (e) {
        issues.push({
          severity: 'warning',
          code: 'load-failed',
          message: `Pack ${pack.packageName} (${rel}): ${firstLine((e as Error).message ?? String(e))}`,
          source: file,
          packageName: pack.packageName,
        });
      }
    }
  }
  CACHE.set(inspection.projectRoot, { cacheKey, list: out, issues, rejected, files });
  return { playbooks: out, issues, files, rejected };
}

export async function loadPlaybooks(
  inspection: ISharkcraftInspection,
): Promise<readonly IPlaybook[]> {
  return (await loadPlaybooksWithIssues(inspection)).playbooks;
}

export function listPlaybooks(inspection: ISharkcraftInspection): readonly IPlaybook[] {
  const cached = CACHE.get(inspection.projectRoot);
  return cached?.list ?? [];
}

export async function warmPlaybookCache(inspection: ISharkcraftInspection): Promise<void> {
  await loadPlaybooks(inspection);
}

export interface IPlaybookRunbook {
  playbookId: string;
  title: string;
  steps: readonly IPlaybookStep[];
  notes: readonly string[];
}

export function buildRunbook(playbook: IPlaybook): IPlaybookRunbook {
  const notes: string[] = [];
  // The loader refuses a playbook without an array `steps`; guard anyway, so a
  // hand-built playbook can never crash the runbook.
  const steps = Array.isArray(playbook.steps) ? playbook.steps : [];
  if (steps.length === 0) {
    notes.push('Playbook has no steps — add at least one in `definePlaybook`.');
  }
  return {
    playbookId: playbook.id,
    title: playbook.title ?? playbook.id,
    steps,
    notes,
  };
}

export interface IPlaybookRecommendation {
  playbook: IPlaybook;
  score: number;
  reasons: readonly string[];
}

/** An example counts when its content terms and the task's overlap this much (Jaccard). */
const EXAMPLE_JACCARD_THRESHOLD = 0.5;
/** Title/description overlap: +1 per distinct shared content term, capped. */
const TITLE_DESCRIPTION_CAP = 3;

/**
 * Rank playbooks for a task through THE term matcher:
 *   - whole task contained in the title: +10 (unchanged);
 *   - each tag +3 and each taskKind +4, matched in the playbook's `matchMode`
 *     (default tokens: tag `capability-pack` matches "add a capability pack");
 *   - each example +3 when its content terms overlap the task's by ≥ 0.5 (Jaccard);
 *   - +1 per distinct task content term in the title/description, capped at +3 —
 *     only with ≥ 2 shared terms or alongside another signal, so a single
 *     common verb ("add") never recommends a playbook on its own.
 */
export function recommendPlaybooks(
  playbooks: readonly IPlaybook[],
  task: string,
): readonly IPlaybookRecommendation[] {
  const lower = task.trim().toLowerCase();
  const query = prepareTermQuery(task);
  const taskContent = contentTerms(task);
  const out: IPlaybookRecommendation[] = [];
  for (const p of playbooks) {
    const mode = (p.matchMode as string) === TermMatchMode.Substring ? TermMatchMode.Substring : TermMatchMode.Tokens;
    let score = 0;
    const reasons: string[] = [];
    if (lower.length > 0 && (p.title ?? p.id).toLowerCase().includes(lower)) {
      score += 10;
      reasons.push('title matches task');
    }
    for (const t of p.tags ?? []) {
      if (matchTerm(query, t, mode)) {
        score += 3;
        reasons.push(`tag ${t}`);
      }
    }
    for (const k of p.taskKinds ?? []) {
      if (matchTerm(query, k, mode)) {
        score += 4;
        reasons.push(`taskKind ${k}`);
      }
    }
    for (const ex of p.examples ?? []) {
      if (termJaccard(taskContent, contentTerms(ex)) >= EXAMPLE_JACCARD_THRESHOLD) {
        score += 3;
        reasons.push('example matches');
      }
    }
    const shared = matchedQueryTerms(taskContent, [p.title, p.description]);
    if (shared.length >= 2 || (shared.length === 1 && score > 0)) {
      score += Math.min(TITLE_DESCRIPTION_CAP, shared.length);
      reasons.push(`title/description terms: ${shared.slice(0, TITLE_DESCRIPTION_CAP).join(', ')}`);
    }
    if (score > 0) out.push({ playbook: p, score, reasons });
  }
  return out.sort((a, b) => b.score - a.score);
}
