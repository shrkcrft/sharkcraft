import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IPlaybookInput, IPlaybookStep } from '@shrkcrft/plugin-api';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { importModuleViaLoader } from '@shrkcrft/core';

export const PLAYBOOK_REGISTRY_SCHEMA = 'sharkcraft.playbook-registry/v1';

export interface IPlaybook extends IPlaybookInput {
  source: 'local' | 'pack';
  packageName?: string;
  sourceFile?: string;
}

interface ICacheEntry {
  cacheKey: string;
  list: IPlaybook[];
}

const CACHE = new Map<string, ICacheEntry>();

async function importDefault<T>(file: string): Promise<readonly T[]> {
  const mod = (await importModuleViaLoader(file)) as {
    default?: readonly T[] | T;
    playbooks?: readonly T[];
  };
  if (Array.isArray(mod.default)) return mod.default;
  if (mod.default && typeof mod.default === 'object') return [mod.default as T];
  if (Array.isArray(mod.playbooks)) return mod.playbooks as readonly T[];
  return [];
}

function localPlaybookFiles(inspection: ISharkcraftInspection): string[] {
  const out: string[] = [];
  const dir = inspection.sharkcraftDir;
  if (!dir) return [];
  for (const f of ['playbooks.ts', 'playbooks/index.ts']) {
    const full = nodePath.join(dir, f);
    if (existsSync(full)) out.push(full);
  }
  const cfg = inspection.config as { playbookFiles?: readonly string[] } | null;
  if (cfg?.playbookFiles) {
    for (const rel of cfg.playbookFiles) out.push(nodePath.join(dir, rel));
  }
  return out;
}

export async function loadPlaybooks(
  inspection: ISharkcraftInspection,
): Promise<readonly IPlaybook[]> {
  const cacheKey = `${inspection.projectRoot}:${inspection.packs.validPacks
    .map((p) => p.packageName + '@' + p.packageVersion)
    .join(',')}`;
  const cached = CACHE.get(inspection.projectRoot);
  if (cached && cached.cacheKey === cacheKey) return cached.list;
  const out: IPlaybook[] = [];
  for (const file of localPlaybookFiles(inspection)) {
    try {
      const list = await importDefault<IPlaybookInput>(file);
      for (const p of list) {
        if (!p?.id) continue;
        out.push({
          ...p,
          source: 'local',
          sourceFile: nodePath.relative(inspection.projectRoot, file),
        });
      }
    } catch {
      /* ignore */
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
      if (!existsSync(file)) continue;
      try {
        const list = await importDefault<IPlaybookInput>(file);
        for (const p of list) {
          if (!p?.id) continue;
          out.push({
            ...p,
            source: 'pack',
            packageName: pack.packageName,
            sourceFile: rel,
          });
        }
      } catch {
        /* ignore */
      }
    }
  }
  CACHE.set(inspection.projectRoot, { cacheKey, list: out });
  return out;
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
  if (playbook.steps.length === 0) {
    notes.push('Playbook has no steps — add at least one in `definePlaybook`.');
  }
  return {
    playbookId: playbook.id,
    title: playbook.title ?? playbook.id,
    steps: playbook.steps,
    notes,
  };
}

export interface IPlaybookRecommendation {
  playbook: IPlaybook;
  score: number;
  reasons: readonly string[];
}

export function recommendPlaybooks(
  playbooks: readonly IPlaybook[],
  task: string,
): readonly IPlaybookRecommendation[] {
  const lower = task.toLowerCase();
  const out: IPlaybookRecommendation[] = [];
  for (const p of playbooks) {
    let score = 0;
    const reasons: string[] = [];
    if ((p.title ?? p.id).toLowerCase().includes(lower)) {
      score += 10;
      reasons.push('title matches task');
    }
    for (const t of p.tags ?? []) {
      if (lower.includes(t.toLowerCase())) {
        score += 3;
        reasons.push(`tag ${t}`);
      }
    }
    for (const k of p.taskKinds ?? []) {
      if (lower.includes(k.toLowerCase())) {
        score += 4;
        reasons.push(`taskKind ${k}`);
      }
    }
    for (const ex of p.examples ?? []) {
      if (lower.includes(ex.toLowerCase()) || ex.toLowerCase().includes(lower)) {
        score += 3;
        reasons.push('example matches');
      }
    }
    if (score > 0) out.push({ playbook: p, score, reasons });
  }
  return out.sort((a, b) => b.score - a.score);
}

void readFileSync;
