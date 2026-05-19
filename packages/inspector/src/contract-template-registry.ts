/**
 * Contract template registry. Merges engine built-ins with
 * pack-contributed contract templates via `contractTemplateFiles`.
 */
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  ALL_CONTRACT_TEMPLATES,
  AGENT_CONTRACT_TEMPLATE_SCHEMA,
  type IAgentContractTemplate,
} from './agent-contract-templates.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { importModuleViaLoader } from '@shrkcrft/core';

export const CONTRACT_TEMPLATE_REGISTRY_SCHEMA = 'sharkcraft.contract-template-registry/v1';

export enum ContractTemplateSource {
  Builtin = 'builtin',
  Local = 'local',
  Pack = 'pack',
}

export interface IContractTemplateEntry {
  readonly template: IAgentContractTemplate;
  readonly source: ContractTemplateSource;
  readonly packageName?: string;
  readonly sourceFile?: string;
}

export interface IContractTemplateRegistryIssue {
  readonly severity: 'info' | 'warning' | 'error';
  readonly code: string;
  readonly message: string;
  readonly templateId?: string;
  readonly source?: string;
}

interface ICacheEntry {
  cacheKey: string;
  entries: readonly IContractTemplateEntry[];
  issues: readonly IContractTemplateRegistryIssue[];
}

const CACHE = new Map<string, ICacheEntry>();

async function importDefault<T>(file: string): Promise<readonly T[]> {
  const mod = (await importModuleViaLoader(file)) as {
    default?: readonly T[] | T;
    contractTemplates?: readonly T[];
  };
  if (Array.isArray(mod.default)) return mod.default;
  if (mod.default && typeof mod.default === 'object') return [mod.default as T];
  if (Array.isArray(mod.contractTemplates)) return mod.contractTemplates;
  return [];
}

function localFiles(inspection: ISharkcraftInspection): string[] {
  const out: string[] = [];
  const dir = inspection.sharkcraftDir;
  if (!dir) return [];
  for (const name of ['contract-templates.ts', 'contract-templates/index.ts']) {
    const full = nodePath.join(dir, name);
    if (existsSync(full)) out.push(full);
  }
  const cfg = inspection.config as { contractTemplateFiles?: readonly string[] } | null;
  for (const rel of cfg?.contractTemplateFiles ?? []) {
    out.push(nodePath.isAbsolute(rel) ? rel : nodePath.join(dir, rel));
  }
  return out;
}

function isValidTemplate(raw: unknown): raw is IAgentContractTemplate {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.title === 'string' &&
    (o.schema === AGENT_CONTRACT_TEMPLATE_SCHEMA || o.schema === undefined) &&
    Array.isArray(o.defaultForbiddenFilesDetailed)
  );
}

export async function loadAllContractTemplates(
  inspection: ISharkcraftInspection,
): Promise<{
  entries: readonly IContractTemplateEntry[];
  issues: readonly IContractTemplateRegistryIssue[];
}> {
  const cacheKey = `${inspection.projectRoot}:${(inspection.packs.validPacks ?? [])
    .map((p) => p.packageName + '@' + p.packageVersion)
    .join(',')}`;
  const cached = CACHE.get(inspection.projectRoot);
  if (cached && cached.cacheKey === cacheKey) {
    return { entries: cached.entries, issues: cached.issues };
  }
  const seen = new Map<string, IContractTemplateEntry>();
  const entries: IContractTemplateEntry[] = [];
  const issues: IContractTemplateRegistryIssue[] = [];

  const ingest = (
    raw: unknown,
    source: ContractTemplateSource,
    packageName: string | undefined,
    sourceFile: string | undefined,
  ): void => {
    if (!isValidTemplate(raw)) {
      issues.push({
        severity: 'warning',
        code: 'invalid-template',
        message: `Invalid contract template at ${sourceFile ?? source}; skipped.`,
        source: sourceFile,
      });
      return;
    }
    const tpl = raw as IAgentContractTemplate;
    const existing = seen.get(tpl.id);
    if (existing) {
      issues.push({
        severity: 'error',
        code: 'duplicate-id',
        message: `Contract template id "${tpl.id}" already loaded from ${existing.source}${existing.sourceFile ? ' (' + existing.sourceFile + ')' : ''}; skipping ${source}${sourceFile ? ' (' + sourceFile + ')' : ''}.`,
        templateId: tpl.id,
        source: sourceFile,
      });
      return;
    }
    const entry: IContractTemplateEntry = {
      template: tpl,
      source,
      ...(packageName ? { packageName } : {}),
      ...(sourceFile ? { sourceFile } : {}),
    };
    seen.set(tpl.id, entry);
    entries.push(entry);
  };

  for (const t of ALL_CONTRACT_TEMPLATES) {
    ingest(t, ContractTemplateSource.Builtin, undefined, undefined);
  }

  for (const file of localFiles(inspection)) {
    try {
      const list = await importDefault<unknown>(file);
      const rel = nodePath.relative(inspection.projectRoot, file) || file;
      for (const raw of list) ingest(raw, ContractTemplateSource.Local, undefined, rel);
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
    const contributions = (pack.manifest?.contributions ?? {}) as {
      contractTemplateFiles?: readonly string[];
    };
    for (const rel of contributions.contractTemplateFiles ?? []) {
      const file = nodePath.resolve(pack.packageRoot, rel);
      if (!existsSync(file)) {
        issues.push({
          severity: 'warning',
          code: 'missing-file',
          message: `Pack ${pack.packageName} declares contract template ${rel} but the file is missing.`,
          source: file,
        });
        continue;
      }
      try {
        const list = await importDefault<unknown>(file);
        for (const raw of list) ingest(raw, ContractTemplateSource.Pack, pack.packageName, rel);
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

  CACHE.set(inspection.projectRoot, { cacheKey, entries, issues });
  return { entries, issues };
}

export async function listAllContractTemplates(
  inspection: ISharkcraftInspection,
): Promise<readonly IAgentContractTemplate[]> {
  const { entries } = await loadAllContractTemplates(inspection);
  return entries.map((e) => e.template);
}

export function clearContractTemplateRegistryCache(projectRoot?: string): void {
  if (projectRoot) CACHE.delete(projectRoot);
  else CACHE.clear();
}
