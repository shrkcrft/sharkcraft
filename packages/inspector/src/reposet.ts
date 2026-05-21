/**
 * Multi-repo / reposet awareness.
 *
 * A reposet config (`sharkcraft.reposet.json`) declares multiple local
 * repository roots a team works across. SharkCraft can map, brief, and
 * report across them — read-only, never writes into any repo.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { inspectSharkcraft, runDoctor, type ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const REPOSET_SCHEMA = 'sharkcraft.reposet/v1';

export interface IRepoSetEntry {
  id: string;
  name: string;
  root: string;
  tags: readonly string[];
  role: string;
}

export interface IRepoSetConfig {
  schema: typeof REPOSET_SCHEMA;
  repos: readonly IRepoSetEntry[];
}

export interface IRepoSetMapEntry {
  id: string;
  name: string;
  root: string;
  exists: boolean;
  doctor?: { ok: number; errors: number; warnings: number; info: number };
  packages?: number;
  constructs?: number;
  /** Number of boundary rules in the repo. */
  boundaryRules?: number;
  /** Number of registered policy overrides. */
  policyOverrides?: number;
  /** Number of validation/verification commands declared in the local config. */
  verificationCommands?: number;
  /** Number of templates declared in the local config. */
  templates?: number;
  /** Number of pipelines declared in the local config. */
  pipelines?: number;
  /** Last inspection error (if any). */
  lastInspectionError?: string;
  warnings: readonly string[];
}

export interface IRepoSetMap {
  schema: 'sharkcraft.reposet-map/v1';
  generatedAt: string;
  repos: readonly IRepoSetMapEntry[];
}

const REPOSET_FILE_CANDIDATES = ['sharkcraft.reposet.json', '.sharkcraft/reposet.json'];

export function loadReposetConfig(cwd: string): IRepoSetConfig | null {
  for (const cand of REPOSET_FILE_CANDIDATES) {
    const abs = nodePath.join(cwd, cand);
    if (!existsSync(abs)) continue;
    try {
      const parsed = JSON.parse(readFileSync(abs, 'utf8')) as { repos?: readonly IRepoSetEntry[] };
      const repos: IRepoSetEntry[] = [];
      for (const r of parsed.repos ?? []) {
        if (!r || typeof r.id !== 'string' || typeof r.root !== 'string') continue;
        repos.push({
          id: r.id,
          name: r.name ?? r.id,
          root: r.root,
          tags: Array.isArray(r.tags) ? [...r.tags] : [],
          role: typeof r.role === 'string' ? r.role : 'unspecified',
        });
      }
      return { schema: REPOSET_SCHEMA, repos };
    } catch {
      return null;
    }
  }
  return null;
}

function exampleConfigBody(): string {
  return JSON.stringify(
    {
      schema: REPOSET_SCHEMA,
      repos: [
        { id: 'sharkcraft', name: 'SharkCraft', root: '.', tags: ['engine'], role: 'engine' },
        { id: 'example-consumer', name: 'Example consumer project', root: '../example-consumer', tags: ['consumer'], role: 'consumer' },
      ],
    },
    null,
    2,
  );
}

export function previewReposetInit(cwd: string): { targetPath: string; body: string } {
  return {
    targetPath: nodePath.join(cwd, 'sharkcraft.reposet.json'),
    body: exampleConfigBody(),
  };
}

export interface IBuildReposetMapOptions {
  parallel?: boolean;
  concurrency?: number;
}

async function inspectOne(r: IRepoSetEntry): Promise<IRepoSetMapEntry> {
  const abs = nodePath.isAbsolute(r.root) ? r.root : nodePath.resolve(process.cwd(), r.root);
  const exists = existsSync(abs);
  if (!exists) {
    return { id: r.id, name: r.name, root: abs, exists, warnings: ['repo root missing'] };
  }
  try {
    const inspection: ISharkcraftInspection = await inspectSharkcraft({ cwd: abs });
    let doctor = { ok: 0, errors: 0, warnings: 0, info: 0 };
    try {
      const dr = runDoctor(inspection);
      doctor = { ok: dr.summary.ok, errors: dr.summary.errors, warnings: dr.summary.warnings, info: dr.summary.info };
    } catch {
      /* keep zeros */
    }
    const cfg = inspection.config as
      | {
          policyOverrides?: readonly unknown[];
          verificationCommands?: readonly unknown[];
        }
      | null;
    const policyOverrides = Array.isArray(cfg?.policyOverrides) ? cfg!.policyOverrides!.length : 0;
    const verificationCommands = Array.isArray(cfg?.verificationCommands)
      ? cfg!.verificationCommands!.length
      : 0;
    const boundaryRules = inspection.boundaryRegistry.size();
    const templates = inspection.templates.length;
    const pipelines = inspection.pipelines.length;
    return {
      id: r.id,
      name: r.name,
      root: abs,
      exists,
      doctor,
      packages: inspection.packs.validPacks?.length ?? 0,
      constructs: 0,
      boundaryRules,
      policyOverrides,
      verificationCommands,
      templates,
      pipelines,
      warnings: [],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      id: r.id,
      name: r.name,
      root: abs,
      exists,
      lastInspectionError: message,
      warnings: [`inspectSharkcraft failed: ${message}`],
    };
  }
}

export async function buildReposetMap(
  config: IRepoSetConfig,
  options: IBuildReposetMapOptions = {},
): Promise<IRepoSetMap> {
  if (options.parallel !== true) {
    const repos: IRepoSetMapEntry[] = [];
    for (const r of config.repos) repos.push(await inspectOne(r));
    return { schema: 'sharkcraft.reposet-map/v1', generatedAt: new Date().toISOString(), repos };
  }
  // Bounded-concurrency parallel inspection, preserving input order.
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const indexed: IRepoSetMapEntry[] = new Array(config.repos.length);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(concurrency, config.repos.length); w++) {
    workers.push(
      (async () => {
        while (true) {
          const i = cursor++;
          if (i >= config.repos.length) return;
          const repo = config.repos[i];
          if (!repo) continue;
          indexed[i] = await inspectOne(repo);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return { schema: 'sharkcraft.reposet-map/v1', generatedAt: new Date().toISOString(), repos: indexed };
}

export function renderReposetMapText(map: IRepoSetMap): string {
  const lines: string[] = [];
  lines.push('=== Reposet map ===');
  for (const r of map.repos) {
    lines.push(`  ${r.id.padEnd(18)} ${r.exists ? '[OK]' : '[MISSING]'} ${r.root}`);
    if (r.doctor) {
      lines.push(
        `    doctor: ok=${r.doctor.ok} info=${r.doctor.info} warn=${r.doctor.warnings} err=${r.doctor.errors}`,
      );
    }
    const stats = [
      r.packages !== undefined ? `packs=${r.packages}` : '',
      r.boundaryRules !== undefined ? `boundaries=${r.boundaryRules}` : '',
      r.policyOverrides !== undefined ? `overrides=${r.policyOverrides}` : '',
      r.verificationCommands !== undefined ? `verify-cmds=${r.verificationCommands}` : '',
      r.templates !== undefined ? `templates=${r.templates}` : '',
      r.pipelines !== undefined ? `pipelines=${r.pipelines}` : '',
    ]
      .filter((x) => x.length > 0)
      .join(' ');
    if (stats.length > 0) lines.push(`    ${stats}`);
    if (r.warnings.length > 0) for (const w of r.warnings) lines.push(`    ! ${w}`);
  }
  return lines.join('\n') + '\n';
}
