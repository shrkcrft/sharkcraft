import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { listConstructs, type IConstruct } from './construct-registry.ts';
import {
  InferredConstructConfidence,
  type IInferredConstruct,
} from './construct-inference.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { importModuleViaLoader } from '@shrkcrft/core';

export const CONSTRUCT_ADOPTION_SCHEMA = 'sharkcraft.construct-adoption-plan/v1';

export enum ConstructAdoptionCategory {
  SafeToAdopt = 'safe-to-adopt',
  ManualReview = 'manual-review',
  LowConfidence = 'low-confidence',
  AlreadyCovered = 'already-covered',
  Conflict = 'conflict',
}

export interface IConstructAdoptionEntry {
  id: string;
  type: string;
  title: string;
  category: ConstructAdoptionCategory;
  confidence: InferredConstructConfidence;
  reasons: readonly string[];
  /** A short pseudo-diff body for the patch file. */
  diff: string;
  /** The full inferred construct payload. */
  inferred: IInferredConstruct;
}

export interface IConstructAdoptionPlan {
  schema: typeof CONSTRUCT_ADOPTION_SCHEMA;
  generatedAt: string;
  projectRoot: string;
  draftsFile: string | null;
  entries: readonly IConstructAdoptionEntry[];
  summary: {
    total: number;
    safeToAdopt: number;
    manualReview: number;
    lowConfidence: number;
    alreadyCovered: number;
    conflict: number;
  };
  warnings: readonly string[];
}

export type ConstructAdoptionIncludes = 'facets' | 'publicApi' | 'events' | 'tokens';

export interface IConstructAdoptionInput {
  /** Minimum confidence required for safe-to-adopt classification. */
  minConfidence?: InferredConstructConfidence;
  /** Optional subset of payload fields to include in the diff. */
  include?: readonly ConstructAdoptionIncludes[];
}

const DEFAULT_DRAFTS_PATH = 'construct-drafts/constructs.draft.ts';
const ADOPTION_DIR = 'construct-drafts/adoption';

function confidenceRank(c: InferredConstructConfidence): number {
  if (c === InferredConstructConfidence.High) return 3;
  if (c === InferredConstructConfidence.Medium) return 2;
  return 1;
}

async function loadDrafts(file: string): Promise<readonly IInferredConstruct[]> {
  if (!existsSync(file)) return [];
  try {
    const mod = (await importModuleViaLoader(file)) as {
      default?: readonly IInferredConstruct[];
      constructs?: readonly IInferredConstruct[];
    };
    if (Array.isArray(mod.default)) return mod.default;
    if (Array.isArray(mod.constructs)) return mod.constructs;
    return [];
  } catch {
    return [];
  }
}

function safeJsonStringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function buildDiff(
  inferred: IInferredConstruct,
  existing: IConstruct | null,
  include: readonly ConstructAdoptionIncludes[] = ['facets', 'publicApi', 'events', 'tokens'],
): string {
  const lines: string[] = [];
  const files = inferred.files ?? [];
  const publicApi = inferred.publicApi ?? [];
  const events = inferred.events ?? [];
  const tokens = inferred.tokens ?? [];
  if (!existing) {
    lines.push(`+ Add construct: ${inferred.id} (${inferred.type})`);
    if (files.length > 0) lines.push(`+   files: ${files.slice(0, 6).join(', ')}`);
    if (include.includes('publicApi') && publicApi.length > 0) {
      lines.push(`+   publicApi: ${publicApi.slice(0, 4).join(', ')}`);
    }
    if (include.includes('events') && events.length > 0) {
      lines.push(`+   events: ${events.join(', ')}`);
    }
    if (include.includes('tokens') && tokens.length > 0) {
      lines.push(`+   tokens: ${tokens.join(', ')}`);
    }
    return lines.join('\n') + '\n';
  }
  lines.push(`~ Construct already exists: ${existing.id}`);
  const existingFiles = new Set(existing.files ?? []);
  for (const f of files) {
    if (!existingFiles.has(f)) lines.push(`+   file: ${f}`);
  }
  if (include.includes('publicApi')) {
    const existingApi = new Set(existing.publicApi ?? []);
    for (const a of publicApi) {
      if (!existingApi.has(a)) lines.push(`+   publicApi: ${a}`);
    }
  }
  if (include.includes('events')) {
    const existingEv = new Set(existing.events ?? []);
    for (const e of events) {
      if (!existingEv.has(e)) lines.push(`+   event: ${e}`);
    }
  }
  if (include.includes('tokens')) {
    const existingTok = new Set(existing.tokens ?? []);
    for (const t of tokens) {
      if (!existingTok.has(t)) lines.push(`+   token: ${t}`);
    }
  }
  return lines.join('\n') + '\n';
}

function classify(
  inferred: IInferredConstruct,
  existing: IConstruct | null,
  options: IConstructAdoptionInput,
): { category: ConstructAdoptionCategory; reasons: string[] } {
  const reasons: string[] = [];
  const files = inferred.files ?? [];
  if (existing) {
    const sameType = existing.type === inferred.type;
    const existingFiles = existing.files ?? [];
    const filesOverlap = existingFiles.some((f) => files.includes(f));
    if (
      sameType &&
      filesOverlap &&
      files.every((f) => existingFiles.includes(f)) &&
      files.length > 0
    ) {
      reasons.push('construct already registered with identical files');
      return { category: ConstructAdoptionCategory.AlreadyCovered, reasons };
    }
    if (!sameType) {
      reasons.push(
        `id collision: existing type "${existing.type}" vs inferred "${inferred.type}"`,
      );
      return { category: ConstructAdoptionCategory.Conflict, reasons };
    }
    reasons.push('existing construct may need merging');
    return { category: ConstructAdoptionCategory.ManualReview, reasons };
  }
  const min = options.minConfidence ?? InferredConstructConfidence.Medium;
  const rank = confidenceRank(inferred.confidence ?? InferredConstructConfidence.Low);
  if (rank < confidenceRank(min)) {
    reasons.push(`confidence ${inferred.confidence ?? '(unknown)'} below required ${min}`);
    return { category: ConstructAdoptionCategory.LowConfidence, reasons };
  }
  if (rank === confidenceRank(InferredConstructConfidence.High)) {
    return { category: ConstructAdoptionCategory.SafeToAdopt, reasons: ['high confidence'] };
  }
  return {
    category: ConstructAdoptionCategory.ManualReview,
    reasons: [`medium confidence — review files: ${files.slice(0, 3).join(', ')}`],
  };
}

export interface IConstructAdoptionPaths {
  /** Absolute path to `construct-drafts/adoption/`. */
  adoptionDir: string;
  planFile: string;
  patchFile: string;
  summaryFile: string;
}

export function constructAdoptionPaths(
  inspection: ISharkcraftInspection,
): IConstructAdoptionPaths | null {
  if (!inspection.sharkcraftDir) return null;
  const adoptionDir = nodePath.join(inspection.sharkcraftDir, ADOPTION_DIR);
  return {
    adoptionDir,
    planFile: nodePath.join(adoptionDir, 'construct-adoption-plan.md'),
    patchFile: nodePath.join(adoptionDir, 'construct-adopt.patch'),
    summaryFile: nodePath.join(adoptionDir, 'construct-adopt-summary.json'),
  };
}

export async function buildConstructAdoptionPlan(
  inspection: ISharkcraftInspection,
  options: IConstructAdoptionInput = {},
): Promise<IConstructAdoptionPlan> {
  const warnings: string[] = [];
  const draftsFile = inspection.sharkcraftDir
    ? nodePath.join(inspection.sharkcraftDir, DEFAULT_DRAFTS_PATH)
    : null;
  const rawDrafts = draftsFile ? await loadDrafts(draftsFile) : [];
  // Drafts written by `shrk constructs infer --write-drafts` strip the
  // inference-only fields. Fill defaults so adoption can still classify.
  const drafts: IInferredConstruct[] = rawDrafts.map((d) => ({
    ...d,
    confidence: d.confidence ?? InferredConstructConfidence.Medium,
    evidence: d.evidence ?? [],
    files: d.files ?? [],
    publicApi: d.publicApi ?? [],
    draft: d.draft ?? '',
  }));
  if (drafts.length === 0) {
    warnings.push(
      `No construct drafts found at ${draftsFile ?? '(no sharkcraft dir)'} — run \`shrk constructs infer --write-drafts\` first.`,
    );
  }
  const existing = listConstructs(inspection);
  const byId = new Map(existing.map((c) => [c.id, c] as const));
  const include = options.include ?? ['facets', 'publicApi', 'events', 'tokens'];
  const entries: IConstructAdoptionEntry[] = [];
  for (const inferred of drafts) {
    const ex = byId.get(inferred.id) ?? null;
    const { category, reasons } = classify(inferred, ex, options);
    entries.push({
      id: inferred.id,
      type: inferred.type,
      title: inferred.title,
      category,
      confidence: inferred.confidence,
      reasons,
      diff: buildDiff(inferred, ex, include),
      inferred,
    });
  }
  const summary = {
    total: entries.length,
    safeToAdopt: entries.filter((e) => e.category === ConstructAdoptionCategory.SafeToAdopt).length,
    manualReview: entries.filter((e) => e.category === ConstructAdoptionCategory.ManualReview).length,
    lowConfidence: entries.filter((e) => e.category === ConstructAdoptionCategory.LowConfidence).length,
    alreadyCovered: entries.filter((e) => e.category === ConstructAdoptionCategory.AlreadyCovered).length,
    conflict: entries.filter((e) => e.category === ConstructAdoptionCategory.Conflict).length,
  };
  return {
    schema: CONSTRUCT_ADOPTION_SCHEMA,
    generatedAt: new Date().toISOString(),
    projectRoot: inspection.projectRoot,
    draftsFile,
    entries,
    summary,
    warnings,
  };
}

export function renderConstructAdoptionMarkdown(plan: IConstructAdoptionPlan): string {
  const lines: string[] = [];
  lines.push('# Construct adoption plan');
  lines.push('');
  lines.push(`Generated: ${plan.generatedAt}`);
  // Render the drafts path relative to the project root so the rendered
  // markdown (which often gets committed) doesn't leak absolute paths.
  const relDrafts = plan.draftsFile
    ? plan.draftsFile.startsWith(plan.projectRoot + nodePath.sep)
      ? plan.draftsFile.slice(plan.projectRoot.length + 1)
      : nodePath.basename(plan.draftsFile)
    : '(none)';
  lines.push(`Drafts: ${relDrafts}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Total: ${plan.summary.total}`);
  lines.push(`- Safe to adopt: ${plan.summary.safeToAdopt}`);
  lines.push(`- Manual review: ${plan.summary.manualReview}`);
  lines.push(`- Low confidence: ${plan.summary.lowConfidence}`);
  lines.push(`- Already covered: ${plan.summary.alreadyCovered}`);
  lines.push(`- Conflict: ${plan.summary.conflict}`);
  lines.push('');
  if (plan.warnings.length > 0) {
    lines.push('## Warnings');
    lines.push('');
    for (const w of plan.warnings) lines.push(`- ${w}`);
    lines.push('');
  }
  const groups: ConstructAdoptionCategory[] = [
    ConstructAdoptionCategory.SafeToAdopt,
    ConstructAdoptionCategory.ManualReview,
    ConstructAdoptionCategory.LowConfidence,
    ConstructAdoptionCategory.AlreadyCovered,
    ConstructAdoptionCategory.Conflict,
  ];
  for (const cat of groups) {
    const items = plan.entries.filter((e) => e.category === cat);
    if (items.length === 0) continue;
    lines.push(`## ${cat} (${items.length})`);
    lines.push('');
    for (const e of items) {
      lines.push(`### ${e.id} \`${e.type}\` — ${e.confidence}`);
      for (const r of e.reasons) lines.push(`- ${r}`);
      lines.push('');
      lines.push('```');
      lines.push(e.diff.trim());
      lines.push('```');
      lines.push('');
    }
  }
  lines.push('## Next step');
  lines.push('');
  lines.push('Copy approved entries from `construct-adopt.patch` into `sharkcraft/constructs.ts`.');
  lines.push('SharkCraft never modifies `constructs.ts` automatically.');
  return lines.join('\n') + '\n';
}

export function renderConstructAdoptionPatch(plan: IConstructAdoptionPlan): string {
  const lines: string[] = [];
  lines.push('# SharkCraft construct adoption pseudo-patch');
  lines.push(`# Generated: ${plan.generatedAt}`);
  lines.push('# Apply manually — SharkCraft never writes constructs.ts.');
  lines.push('');
  const groups: ConstructAdoptionCategory[] = [
    ConstructAdoptionCategory.SafeToAdopt,
    ConstructAdoptionCategory.ManualReview,
    ConstructAdoptionCategory.LowConfidence,
    ConstructAdoptionCategory.AlreadyCovered,
    ConstructAdoptionCategory.Conflict,
  ];
  for (const cat of groups) {
    const items = plan.entries.filter((e) => e.category === cat);
    if (items.length === 0) continue;
    lines.push(`## ${cat}`);
    for (const e of items) {
      lines.push(`### ${e.id}`);
      lines.push(e.diff);
    }
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

export interface IConstructAdoptionWriteResult {
  written: boolean;
  paths: IConstructAdoptionPaths;
  files: readonly string[];
}

export function writeConstructAdoption(
  inspection: ISharkcraftInspection,
  plan: IConstructAdoptionPlan,
): IConstructAdoptionWriteResult {
  const paths = constructAdoptionPaths(inspection);
  if (!paths) {
    throw new Error('No sharkcraft/ directory — cannot write adoption files.');
  }
  mkdirSync(paths.adoptionDir, { recursive: true });
  const wrote: string[] = [];
  writeFileSync(paths.planFile, renderConstructAdoptionMarkdown(plan), 'utf8');
  wrote.push(paths.planFile);
  writeFileSync(paths.patchFile, renderConstructAdoptionPatch(plan), 'utf8');
  wrote.push(paths.patchFile);
  writeFileSync(paths.summaryFile, safeJsonStringify(plan.summary) + '\n', 'utf8');
  wrote.push(paths.summaryFile);
  return { written: true, paths, files: wrote };
}

export interface IConstructAdoptionStatus {
  schema: 'sharkcraft.construct-adoption-status/v1';
  exists: boolean;
  paths: IConstructAdoptionPaths | null;
  planAgeMs: number | null;
  summary: IConstructAdoptionPlan['summary'] | null;
}

export function readConstructAdoptionStatus(
  inspection: ISharkcraftInspection,
): IConstructAdoptionStatus {
  const paths = constructAdoptionPaths(inspection);
  if (!paths) {
    return {
      schema: 'sharkcraft.construct-adoption-status/v1',
      exists: false,
      paths: null,
      planAgeMs: null,
      summary: null,
    };
  }
  let summary: IConstructAdoptionPlan['summary'] | null = null;
  if (existsSync(paths.summaryFile)) {
    try {
      summary = JSON.parse(readFileSync(paths.summaryFile, 'utf8'));
    } catch {
      summary = null;
    }
  }
  let planAgeMs: number | null = null;
  if (existsSync(paths.planFile)) {
    try {
      planAgeMs = Date.now() - statSync(paths.planFile).mtimeMs;
    } catch {
      /* ignore */
    }
  }
  return {
    schema: 'sharkcraft.construct-adoption-status/v1',
    exists: existsSync(paths.planFile),
    paths,
    planAgeMs,
    summary,
  };
}
