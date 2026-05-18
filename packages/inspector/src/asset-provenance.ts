/**
 * Asset provenance tracking.
 *
 * Append-only JSONL ledger that records every authoring action: who/what
 * authored which knowledge entry / pack asset, when, why, and where the
 * preview/patch lives. Pure local metadata — no telemetry, no network.
 *
 * File: <projectRoot>/.sharkcraft/asset-provenance.jsonl
 *
 * Each line: a single `IAssetProvenanceEntry` JSON object, schema
 * `sharkcraft.asset-provenance/v1`.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import * as nodePath from 'node:path';

export const ASSET_PROVENANCE_SCHEMA = 'sharkcraft.asset-provenance/v1';
/**
 * Schema marker emitted iff an entry carries `relatedSpec`. v1
 * entries (no relatedSpec) remain readable forever; v2 entries add
 * the spec back-pointer without breaking back-compat.
 */
export const ASSET_PROVENANCE_SCHEMA_V2 = 'sharkcraft.asset-provenance/v2';
export type AssetProvenanceSchema =
  | typeof ASSET_PROVENANCE_SCHEMA
  | typeof ASSET_PROVENANCE_SCHEMA_V2;

export enum AssetProvenanceSource {
  Manual = 'manual',
  Agent = 'agent',
  Cli = 'cli',
  Session = 'session',
  Unknown = 'unknown',
}

export enum AssetProvenanceOperation {
  Add = 'add',
  Update = 'update',
  Remove = 'remove',
  Preview = 'preview',
  Apply = 'apply',
  Acknowledge = 'acknowledge',
}

export enum AssetKind {
  Knowledge = 'knowledge',
  SearchTuning = 'search-tuning',
  FeedbackRule = 'feedback-rule',
  AgentTest = 'agent-test',
  Convention = 'convention',
  TaskRoutingHint = 'task-routing-hint',
  RegistrationHint = 'registration-hint',
  ScaffoldPattern = 'scaffold-pattern',
  Template = 'template',
  Rule = 'rule',
  Path = 'path',
  Pipeline = 'pipeline',
  Preset = 'preset',
  Boundary = 'boundary',
}

export interface IAssetProvenanceEntry {
  schema: AssetProvenanceSchema;
  generatedAt: string;
  operation: AssetProvenanceOperation;
  assetKind: AssetKind | string;
  assetId: string;
  targetFile?: string;
  source: AssetProvenanceSource;
  sessionId?: string;
  bundleId?: string;
  reason?: string;
  relatedTask?: string;
  /**
   * Back-pointer to a `.sharkcraft/specs/<id>/` spec. Present iff
   * the entry was recorded as part of a spec implement/apply. When
   * present, the entry's schema is bumped to v2; absent entries stay v1.
   */
  relatedSpec?: string;
  author?: string;
  previewPath?: string;
  patchPath?: string;
  /** Free-form, structured payload — kept small. */
  extra?: Record<string, unknown>;
}

export interface IRecordProvenanceInput {
  /** Project root (where `.sharkcraft/` lives). */
  projectRoot: string;
  /** Entry fields — everything except schema + generatedAt (auto-filled). */
  entry: Omit<IAssetProvenanceEntry, 'schema' | 'generatedAt'>;
  /** Override the generatedAt — defaults to now. */
  generatedAt?: string;
}

export interface IProvenanceListOptions {
  /** Filter by asset kind. */
  assetKind?: AssetKind | string;
  /** Filter by asset id. */
  assetId?: string;
  /** Filter by operation. */
  operation?: AssetProvenanceOperation;
  /** Max entries to return (most recent first). */
  limit?: number;
}

export function provenancePath(projectRoot: string): string {
  return nodePath.join(projectRoot, '.sharkcraft', 'asset-provenance.jsonl');
}

export function ensureProvenanceDir(projectRoot: string): void {
  const dir = nodePath.join(projectRoot, '.sharkcraft');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function provenanceExists(projectRoot: string): boolean {
  return existsSync(provenancePath(projectRoot));
}

export function readProvenance(projectRoot: string): IAssetProvenanceEntry[] {
  const path = provenancePath(projectRoot);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const out: IAssetProvenanceEntry[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as IAssetProvenanceEntry;
      if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed.schema === ASSET_PROVENANCE_SCHEMA ||
          parsed.schema === ASSET_PROVENANCE_SCHEMA_V2)
      ) {
        out.push(parsed);
      }
    } catch {
      // Tolerate corrupt lines — the ledger is append-only and lossy
      // entries should not poison the read.
    }
  }
  return out;
}

export function recordProvenance(input: IRecordProvenanceInput): IAssetProvenanceEntry {
  const root = input.projectRoot;
  ensureProvenanceDir(root);
  const path = provenancePath(root);
  // Safety: refuse to write anywhere except inside the project root's
  // `.sharkcraft/` directory.
  const expected = nodePath.resolve(root, '.sharkcraft', 'asset-provenance.jsonl');
  const actual = nodePath.resolve(path);
  if (actual !== expected) {
    throw new Error(`refusing to write provenance outside .sharkcraft/: ${actual}`);
  }
  // Bump schema iff the entry carries a relatedSpec back-pointer.
  // Otherwise stay v1 for back-compat. The optional field is the ONLY
  // axis that triggers the bump.
  const usesV2 = (input.entry as { relatedSpec?: string }).relatedSpec !== undefined;
  const entry: IAssetProvenanceEntry = {
    schema: usesV2 ? ASSET_PROVENANCE_SCHEMA_V2 : ASSET_PROVENANCE_SCHEMA,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    ...input.entry,
  };
  if (existsSync(path)) {
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
  } else {
    writeFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
  }
  return entry;
}

export function listProvenance(
  projectRoot: string,
  options: IProvenanceListOptions = {},
): IAssetProvenanceEntry[] {
  const all = readProvenance(projectRoot);
  let filtered = all;
  if (options.assetKind) filtered = filtered.filter((e) => e.assetKind === options.assetKind);
  if (options.assetId) filtered = filtered.filter((e) => e.assetId === options.assetId);
  if (options.operation) filtered = filtered.filter((e) => e.operation === options.operation);
  // Most-recent first.
  filtered = filtered.slice().sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1));
  if (options.limit && options.limit > 0) filtered = filtered.slice(0, options.limit);
  return filtered;
}

export interface IProvenanceShowResult {
  assetKind: string;
  assetId: string;
  entries: ReadonlyArray<IAssetProvenanceEntry>;
  /** Most recent entry, for quick access. */
  latest?: IAssetProvenanceEntry;
}

export function showProvenance(
  projectRoot: string,
  assetId: string,
  assetKind?: AssetKind | string,
): IProvenanceShowResult {
  const entries = listProvenance(projectRoot, { assetId, assetKind });
  return {
    assetKind: assetKind ? String(assetKind) : entries[0]?.assetKind ?? 'unknown',
    assetId,
    entries,
    ...(entries[0] ? { latest: entries[0] } : {}),
  };
}

export interface IProvenanceReport {
  schema: 'sharkcraft.asset-provenance-report/v1';
  generatedAt: string;
  total: number;
  byKind: Readonly<Record<string, number>>;
  byOperation: Readonly<Record<string, number>>;
  bySource: Readonly<Record<string, number>>;
  recent: ReadonlyArray<IAssetProvenanceEntry>;
  /** Whether the ledger file exists at all. */
  ledgerExists: boolean;
  ledgerPath: string;
  ledgerSizeBytes: number;
}

export function buildProvenanceReport(projectRoot: string, recentLimit = 10): IProvenanceReport {
  const path = provenancePath(projectRoot);
  const ledgerExists = existsSync(path);
  const all = ledgerExists ? readProvenance(projectRoot) : [];
  const byKind: Record<string, number> = {};
  const byOperation: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  for (const e of all) {
    byKind[e.assetKind] = (byKind[e.assetKind] ?? 0) + 1;
    byOperation[e.operation] = (byOperation[e.operation] ?? 0) + 1;
    bySource[e.source] = (bySource[e.source] ?? 0) + 1;
  }
  const recent = all
    .slice()
    .sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1))
    .slice(0, recentLimit);
  let size = 0;
  if (ledgerExists) {
    try {
      size = statSync(path).size;
    } catch {
      size = 0;
    }
  }
  return {
    schema: 'sharkcraft.asset-provenance-report/v1',
    generatedAt: new Date().toISOString(),
    total: all.length,
    byKind,
    byOperation,
    bySource,
    recent,
    ledgerExists,
    ledgerPath: path,
    ledgerSizeBytes: size,
  };
}

export function renderProvenanceMarkdown(report: IProvenanceReport): string {
  const lines: string[] = [];
  lines.push('# Asset provenance report');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Ledger: \`${report.ledgerPath}\` (${report.ledgerExists ? `${report.ledgerSizeBytes} bytes` : 'missing'})`);
  lines.push(`Total entries: ${report.total}`);
  lines.push('');
  if (!report.ledgerExists) {
    lines.push('> No provenance ledger yet. Run any `shrk knowledge author` / `shrk pack author` preview to start one.');
    lines.push('');
    return lines.join('\n');
  }
  lines.push('## Counts');
  lines.push('');
  for (const [k, n] of Object.entries(report.byKind)) lines.push(`- kind \`${k}\`: ${n}`);
  for (const [k, n] of Object.entries(report.byOperation)) lines.push(`- op \`${k}\`: ${n}`);
  for (const [k, n] of Object.entries(report.bySource)) lines.push(`- source \`${k}\`: ${n}`);
  lines.push('');
  lines.push('## Recent');
  lines.push('');
  for (const e of report.recent) {
    lines.push(
      `- ${e.generatedAt} \`${e.operation}\` \`${e.assetKind}:${e.assetId}\` ← ${e.source}${e.reason ? ` — ${e.reason}` : ''}`,
    );
  }
  return lines.join('\n');
}
