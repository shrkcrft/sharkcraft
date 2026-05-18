import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IRepositoryKnowledgeModel } from './repository-knowledge-model.ts';

export const INGEST_ADOPTION_SCHEMA = 'sharkcraft.ingest-adoption/v1';

export enum IngestAdoptionStatus {
  SafeAppend = 'safe-append',
  ManualReview = 'manual-review',
  LowConfidence = 'low-confidence',
  AlreadyCovered = 'already-covered',
  GeneratedProtected = 'generated-protected',
}

export interface IIngestAdoptionEntry {
  /** Where the entry would land (sharkcraft/*.ts). */
  target: string;
  kind: string;
  id: string;
  status: IngestAdoptionStatus;
  reason: string;
  bodyExcerpt?: string;
}

export interface IIngestAdoptionPlan {
  schema: typeof INGEST_ADOPTION_SCHEMA;
  projectRoot: string;
  entries: readonly IIngestAdoptionEntry[];
  /** Aggregate counts per status. */
  counts: Readonly<Record<IngestAdoptionStatus, number>>;
  /** Whether the plan needs human review. */
  reviewRequired: boolean;
}

export interface IBuildIngestAdoptionPlanOptions {
  model: IRepositoryKnowledgeModel;
  /** When true, treat low-confidence entries as manual-review. Default true. */
  strict?: boolean;
  /** Skip these targets (e.g. excluded sections). */
  excludeTargets?: readonly string[];
}

const LIVE_FILES: ReadonlyArray<string> = [
  'sharkcraft/rules.ts',
  'sharkcraft/paths.ts',
  'sharkcraft/templates.ts',
  'sharkcraft/pipelines.ts',
  'sharkcraft/boundaries.ts',
  'sharkcraft/knowledge.ts',
  'sharkcraft/constructs.ts',
  'sharkcraft/policies.ts',
  'sharkcraft/playbooks.ts',
  'sharkcraft/presets.ts',
];

export function buildIngestAdoptionPlan(
  options: IBuildIngestAdoptionPlanOptions,
): IIngestAdoptionPlan {
  const model = options.model;
  const excluded = new Set(options.excludeTargets ?? []);
  const entries: IIngestAdoptionEntry[] = [];
  const counts: Record<IngestAdoptionStatus, number> = {
    [IngestAdoptionStatus.SafeAppend]: 0,
    [IngestAdoptionStatus.ManualReview]: 0,
    [IngestAdoptionStatus.LowConfidence]: 0,
    [IngestAdoptionStatus.AlreadyCovered]: 0,
    [IngestAdoptionStatus.GeneratedProtected]: 0,
  };

  const liveContent = readLiveFiles(model.projectRoot);

  const generatedPathSet = new Set<string>();
  for (const root of model.generatedVsHandwritten.generatedRoots) generatedPathSet.add(root.path);

  for (const file of model.recommendedSharkCraftFiles) {
    if (excluded.has(file.target)) continue;
    const liveBody = liveContent.get(file.target) ?? '';
    for (const entry of file.entries) {
      const isGenerated = isUnderGenerated(entry.id, generatedPathSet);
      let status: IngestAdoptionStatus;
      if (isGenerated) {
        status = IngestAdoptionStatus.GeneratedProtected;
      } else if (liveBody.includes(`'${entry.id}'`) || liveBody.includes(`"${entry.id}"`)) {
        status = IngestAdoptionStatus.AlreadyCovered;
      } else if ((entry.reason ?? '').toLowerCase().includes('low confidence')) {
        status = IngestAdoptionStatus.LowConfidence;
      } else if (options.strict !== false && needsManualReview(file.target, entry.kind)) {
        status = IngestAdoptionStatus.ManualReview;
      } else {
        status = IngestAdoptionStatus.SafeAppend;
      }
      entries.push({
        target: file.target,
        kind: entry.kind,
        id: entry.id,
        status,
        reason: entry.reason,
      });
      counts[status] += 1;
    }
  }

  const reviewRequired = counts[IngestAdoptionStatus.ManualReview] > 0 || counts[IngestAdoptionStatus.LowConfidence] > 0;

  return {
    schema: INGEST_ADOPTION_SCHEMA,
    projectRoot: model.projectRoot,
    entries,
    counts,
    reviewRequired,
  };
}

export interface IWriteIngestAdoptionOptions {
  plan: IIngestAdoptionPlan;
  outDir?: string;
}

export interface IWrittenIngestAdoption {
  outDir: string;
  files: readonly { path: string; bytes: number }[];
}

export function writeIngestAdoption(opts: IWriteIngestAdoptionOptions): IWrittenIngestAdoption {
  const outDir = nodePath.resolve(opts.outDir ?? nodePath.join(opts.plan.projectRoot, 'sharkcraft', 'ingestion', 'adoption'));
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const files: { path: string; bytes: number }[] = [];
  const write = (rel: string, body: string): void => {
    const full = nodePath.join(outDir, rel);
    if (!full.startsWith(outDir + nodePath.sep)) throw new Error(`escapes outDir: ${rel}`);
    writeFileSync(full, body, 'utf8');
    files.push({ path: full, bytes: Buffer.byteLength(body, 'utf8') });
  };

  write('ingest-adoption-state.json', JSON.stringify(opts.plan, null, 2));
  write('ingest-adopt-summary.json', JSON.stringify({
    schema: 'sharkcraft.ingest-adopt-summary/v1',
    counts: opts.plan.counts,
    reviewRequired: opts.plan.reviewRequired,
  }, null, 2));
  write('ingest-adoption-plan.md', renderIngestAdoptionPlanMarkdown(opts.plan));
  write('ingest-adopt.patch', renderIngestAdoptionPatch(opts.plan));

  return { outDir, files };
}

function readLiveFiles(projectRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of LIVE_FILES) {
    const abs = nodePath.join(projectRoot, rel);
    if (existsSync(abs)) {
      try {
        out.set(rel, readFileSync(abs, 'utf8'));
      } catch {
        out.set(rel, '');
      }
    } else {
      out.set(rel, '');
    }
  }
  return out;
}

function isUnderGenerated(id: string, generatedPaths: ReadonlySet<string>): boolean {
  for (const p of generatedPaths) {
    if (id.includes(p)) return true;
  }
  return false;
}

function needsManualReview(target: string, kind: string): boolean {
  if (target === 'sharkcraft/templates.ts') return true; // Always manual.
  if (target === 'sharkcraft/policies.ts' && kind === 'policy') return false; // Safe append.
  if (target === 'sharkcraft/boundaries.ts') return false; // Safe append.
  if (target === 'sharkcraft/constructs.ts') return false; // Safe append.
  return false;
}

export function renderIngestAdoptionPlanMarkdown(plan: IIngestAdoptionPlan): string {
  const lines: string[] = [];
  lines.push('# Ingest adoption plan');
  lines.push('');
  lines.push(`Review required: **${plan.reviewRequired ? 'yes' : 'no'}**`);
  lines.push('');
  lines.push('| Status | Count |');
  lines.push('|---|---|');
  for (const [k, v] of Object.entries(plan.counts)) lines.push(`| ${k} | ${v} |`);
  lines.push('');
  lines.push('## Entries');
  lines.push('');
  lines.push('| Target | Kind | Id | Status | Reason |');
  lines.push('|---|---|---|---|---|');
  for (const e of plan.entries) {
    lines.push(`| \`${e.target}\` | ${e.kind} | \`${e.id}\` | ${e.status} | ${e.reason} |`);
  }
  return lines.join('\n');
}

export function renderIngestAdoptionPatch(plan: IIngestAdoptionPlan): string {
  const lines: string[] = [];
  lines.push('# Generated by `shrk ingest adopt --write-patch`. Apply manually:');
  lines.push('# 1) Review each block.');
  lines.push('# 2) Copy the safe-append blocks into the corresponding sharkcraft/*.ts file.');
  lines.push('# 3) Resolve manual-review entries by hand.');
  lines.push('');
  const grouped = new Map<string, IIngestAdoptionEntry[]>();
  for (const e of plan.entries) {
    if (e.status === IngestAdoptionStatus.GeneratedProtected || e.status === IngestAdoptionStatus.AlreadyCovered) continue;
    const list = grouped.get(e.target) ?? [];
    list.push(e);
    grouped.set(e.target, list);
  }
  for (const [target, list] of grouped) {
    lines.push(`## ${target}`);
    lines.push('');
    for (const e of list) {
      lines.push(`### ${e.status} — \`${e.id}\` (${e.kind})`);
      lines.push(`> ${e.reason}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}
