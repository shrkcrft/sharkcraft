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
import {
  importModuleViaLoader,
  readContributionExport,
  RejectionCause,
  type IContributionExport,
  type IRejectedEntry,
} from '@shrkcrft/core';

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
  rejected: readonly IRejectedEntry[];
}

const CACHE = new Map<string, ICacheEntry>();

async function importTemplates(file: string): Promise<IContributionExport> {
  return readContributionExport(await importModuleViaLoader(file), { namedKeys: ['contractTemplates'] });
}

function localFiles(inspection: ISharkcraftInspection): string[] {
  const out: string[] = [];
  const dir = inspection.sharkcraftDir;
  if (!dir) return [];
  for (const name of ['contract-templates.ts', 'contract-templates/index.ts']) {
    const full = nodePath.join(dir, name);
    if (existsSync(full)) out.push(full);
  }
  // More template files come from pack manifests (`contractTemplateFiles`,
  // loaded below) — there is no local-config key for them; the strict config
  // schema rejects one, so a local read here could never be reached.
  return out;
}

/**
 * THE contract-template acceptance predicate (round 12, 12.1): one
 * `<field>: <message>` per failing field — `[]` means accepted. It used to be a
 * boolean, and a refused template read `Invalid contract template at <file>;
 * skipped.` with no id and no field.
 */
export function contractTemplateRejectionReasons(raw: unknown): readonly string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['(entry): must be an object'];
  const o = raw as Record<string, unknown>;
  const out: string[] = [];
  if (typeof o.id !== 'string') out.push('id: must be a string');
  if (typeof o.title !== 'string') out.push('title: must be a string');
  if (!(o.schema === AGENT_CONTRACT_TEMPLATE_SCHEMA || o.schema === undefined)) {
    out.push(`schema: must be "${AGENT_CONTRACT_TEMPLATE_SCHEMA}" or unset`);
  }
  if (!Array.isArray(o.defaultForbiddenFilesDetailed)) out.push('defaultForbiddenFilesDetailed: must be an array');
  return out;
}

export async function loadAllContractTemplates(
  inspection: ISharkcraftInspection,
): Promise<{
  entries: readonly IContractTemplateEntry[];
  issues: readonly IContractTemplateRegistryIssue[];
  /** Every declared template the loader refused — invalid or a duplicate id (round 12, 12.1). */
  rejected: readonly IRejectedEntry[];
}> {
  const cacheKey = `${inspection.projectRoot}:${(inspection.packs.validPacks ?? [])
    .map((p) => p.packageName + '@' + p.packageVersion)
    .join(',')}`;
  const cached = CACHE.get(inspection.projectRoot);
  if (cached && cached.cacheKey === cacheKey) {
    return { entries: cached.entries, issues: cached.issues, rejected: cached.rejected };
  }
  const seen = new Map<string, IContractTemplateEntry>();
  const entries: IContractTemplateEntry[] = [];
  const issues: IContractTemplateRegistryIssue[] = [];
  const rejected: IRejectedEntry[] = [];

  const ingest = (
    raw: unknown,
    source: ContractTemplateSource,
    packageName: string | undefined,
    sourceFile: string | undefined,
    at?: Pick<IRejectedEntry, 'file' | 'index' | 'exportName'>,
  ): void => {
    const rawId = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined;
    const id = typeof rawId === 'string' ? rawId : undefined;
    const reasons = contractTemplateRejectionReasons(raw);
    if (reasons.length > 0) {
      issues.push({
        severity: 'warning',
        code: 'invalid-template',
        message: `Invalid contract template${id ? ` "${id}"` : ''} at ${sourceFile ?? source}${
          at ? ` (${at.exportName ?? 'default'}[${at.index}])` : ''
        }; skipped — ${reasons.join('; ')}.`,
        ...(id ? { templateId: id } : {}),
        source: sourceFile,
      });
      if (at) rejected.push({ ...at, ...(id ? { entryId: id } : {}), reasons, cause: RejectionCause.Invalid });
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
      if (at) {
        rejected.push({
          ...at,
          entryId: tpl.id,
          reasons: [
            `id: "${tpl.id}" is already declared by ${existing.source}${existing.sourceFile ? ` (${existing.sourceFile})` : ''}`,
          ],
          cause: RejectionCause.DuplicateId,
        });
      }
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
  const ingestAll = (
    exp: IContributionExport,
    file: string,
    source: ContractTemplateSource,
    packageName: string | undefined,
    sourceFile: string,
  ): void => {
    exp.items.forEach((raw, i) =>
      ingest(raw, source, packageName, sourceFile, {
        file,
        index: exp.single ? -1 : i,
        ...(exp.exportName ? { exportName: exp.exportName } : {}),
      }),
    );
  };

  for (const t of ALL_CONTRACT_TEMPLATES) {
    ingest(t, ContractTemplateSource.Builtin, undefined, undefined);
  }

  for (const file of localFiles(inspection)) {
    try {
      const exp = await importTemplates(file);
      const rel = nodePath.relative(inspection.projectRoot, file) || file;
      ingestAll(exp, file, ContractTemplateSource.Local, undefined, rel);
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
        ingestAll(await importTemplates(file), file, ContractTemplateSource.Pack, pack.packageName, rel);
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

  CACHE.set(inspection.projectRoot, { cacheKey, entries, issues, rejected });
  return { entries, issues, rejected };
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
