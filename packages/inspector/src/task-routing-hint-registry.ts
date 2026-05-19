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
  validateTaskRoutingHint,
  type ITaskRoutingHint,
} from '@shrkcrft/plugin-api';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { importModuleViaLoader } from '@shrkcrft/core';

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

async function importDefault<T>(file: string): Promise<readonly T[]> {
  const mod = (await importModuleViaLoader(file)) as {
    default?: readonly T[] | T;
    taskRoutingHints?: readonly T[];
  };
  if (Array.isArray(mod.default)) return mod.default;
  if (mod.default && typeof mod.default === 'object') return [mod.default as T];
  if (Array.isArray(mod.taskRoutingHints)) return mod.taskRoutingHints;
  return [];
}

function localFiles(inspection: ISharkcraftInspection): string[] {
  const out: string[] = [];
  const dir = inspection.sharkcraftDir;
  if (!dir) return [];
  for (const name of ['task-routing-hints.ts', 'task-routing-hints/index.ts']) {
    const abs = nodePath.join(dir, name);
    if (existsSync(abs)) out.push(abs);
  }
  const cfg = inspection.config as { taskRoutingHintFiles?: readonly string[] } | null;
  for (const rel of cfg?.taskRoutingHintFiles ?? []) {
    out.push(nodePath.isAbsolute(rel) ? rel : nodePath.join(dir, rel));
  }
  return out;
}

export async function loadTaskRoutingHints(
  inspection: ISharkcraftInspection,
): Promise<{ entries: readonly ITaskRoutingHintEntry[]; issues: readonly ITaskRoutingHintDoctorIssue[] }> {
  const entries: ITaskRoutingHintEntry[] = [];
  const issues: ITaskRoutingHintDoctorIssue[] = [];
  const seen = new Set<string>();

  const ingest = (
    raw: ITaskRoutingHint,
    source: TaskRoutingHintSource,
    packageName: string | undefined,
    sourceFile: string,
  ): void => {
    const v = validateTaskRoutingHint(raw);
    if (!v.valid) {
      for (const i of v.issues) {
        issues.push({
          severity: 'error',
          code: 'invalid-hint',
          message: `${i.field}: ${i.message}`,
          hintId: typeof raw.id === 'string' ? raw.id : undefined,
          source: sourceFile,
        });
      }
      return;
    }
    if (seen.has(raw.id)) {
      issues.push({
        severity: 'error',
        code: 'duplicate-id',
        message: `Task routing hint "${raw.id}" already loaded; skipping ${sourceFile}.`,
        hintId: raw.id,
        source: sourceFile,
      });
      return;
    }
    seen.add(raw.id);
    entries.push({
      hint: raw,
      source,
      ...(packageName ? { packageName } : {}),
      sourceFile,
    });
  };

  for (const file of localFiles(inspection)) {
    try {
      const list = await importDefault<ITaskRoutingHint>(file);
      const rel = nodePath.relative(inspection.projectRoot, file) || file;
      for (const h of list) ingest(h, TaskRoutingHintSource.Local, undefined, rel);
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
        const list = await importDefault<ITaskRoutingHint>(file);
        for (const h of list) ingest(h, TaskRoutingHintSource.Pack, pack.packageName, rel);
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
  return { entries, issues };
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
  const lower = task.toLowerCase();
  const out: ITaskRoutingMatchResult[] = [];
  for (const e of entries) {
    let score = 0;
    const reasons: string[] = [];
    for (const kw of e.hint.match.keywords ?? []) {
      if (lower.includes(kw.toLowerCase())) {
        score += 2;
        reasons.push(`keyword: ${kw}`);
      }
    }
    for (const p of e.hint.match.phrases ?? []) {
      if (lower.includes(p.toLowerCase())) {
        score += 3;
        reasons.push(`phrase: ${p}`);
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
