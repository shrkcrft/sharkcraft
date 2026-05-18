/**
 * Shared adoption checkpoint state.
 *
 * Tracks the latest diff/patch/target/draft hash for both onboard adoption
 * (`sharkcraft/onboarding/adoption/`) and construct adoption
 * (`sharkcraft/construct-drafts/adoption/`). Used by `status` and `diff`
 * commands to answer: "is the persisted state still up-to-date?"
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';

export const ADOPTION_CHECKPOINT_SCHEMA = 'sharkcraft.adoption-checkpoint/v1';

export type AdoptionCheckpointKind = 'onboard' | 'construct';

export enum AdoptionCheckpointStatus {
  Fresh = 'fresh',
  UpToDate = 'up-to-date',
  StaleDraft = 'stale-draft',
  StaleTarget = 'stale-target',
  StaleDiff = 'stale-diff',
  StaleAge = 'stale-age',
  NeedsRegenerate = 'needs-regenerate',
  Missing = 'missing',
}

/** Default max age in days before an otherwise up-to-date checkpoint is
 *  flagged as stale-age. */
export const DEFAULT_CHECKPOINT_MAX_AGE_DAYS = 30;

export interface IAdoptionCheckpoint {
  schema: typeof ADOPTION_CHECKPOINT_SCHEMA;
  kind: AdoptionCheckpointKind;
  generatedAt: string;
  command: string;
  diffHash: string;
  patchHash?: string;
  /** target relative path → sha256 hex of contents at checkpoint time. */
  targetHashes: Record<string, string>;
  /** draft relative path → sha256 hex of contents at checkpoint time. */
  draftHashes: Record<string, string>;
}

export interface IAdoptionCheckpointReadResult {
  exists: boolean;
  path: string | null;
  checkpoint: IAdoptionCheckpoint | null;
  parseError?: string;
}

function checkpointDir(projectRoot: string, kind: AdoptionCheckpointKind): string {
  if (kind === 'onboard') {
    return nodePath.join(projectRoot, 'sharkcraft', 'onboarding', 'adoption');
  }
  return nodePath.join(projectRoot, 'sharkcraft', 'construct-drafts', 'adoption');
}

export function adoptionCheckpointPath(
  projectRoot: string,
  kind: AdoptionCheckpointKind,
): string {
  return nodePath.join(checkpointDir(projectRoot, kind), 'adoption-checkpoint.json');
}

export function readAdoptionCheckpoint(
  projectRoot: string,
  kind: AdoptionCheckpointKind,
): IAdoptionCheckpointReadResult {
  const path = adoptionCheckpointPath(projectRoot, kind);
  if (!existsSync(path)) {
    return { exists: false, path, checkpoint: null };
  }
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as IAdoptionCheckpoint;
    if (data.schema !== ADOPTION_CHECKPOINT_SCHEMA) {
      return {
        exists: true,
        path,
        checkpoint: null,
        parseError: `Unexpected schema: ${(data as { schema?: string }).schema ?? '(none)'}`,
      };
    }
    return { exists: true, path, checkpoint: data };
  } catch (e) {
    return { exists: true, path, checkpoint: null, parseError: (e as Error).message };
  }
}

export function hashContent(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Strip non-deterministic fields (`generatedAt`, `schema`-changes) from a
 * rendered diff so the hash is stable across runs that produce semantically
 * equivalent output.
 */
function stripVolatileFields(jsonBody: string): string {
  try {
    const parsed = JSON.parse(jsonBody) as Record<string, unknown>;
    delete parsed['generatedAt'];
    // Sort keys for deterministic serialization.
    return JSON.stringify(parsed, Object.keys(parsed).sort());
  } catch {
    return jsonBody;
  }
}

/** Hash a rendered diff body for checkpoint comparison. Equivalent to
 *  `hashContent` but strips volatile fields like `generatedAt` first. */
export function hashDiffBody(jsonBody: string): string {
  return hashContent(stripVolatileFields(jsonBody));
}

export function hashFileIfExists(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    return hashContent(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export interface IWriteAdoptionCheckpointInput {
  projectRoot: string;
  kind: AdoptionCheckpointKind;
  command: string;
  /** Hash of the rendered diff body. */
  diffHash: string;
  /** Optional hash of the rendered patch body. */
  patchHash?: string;
  /** Files (relative to project root) the adoption would touch. */
  targets: readonly string[];
  /** Draft files (relative to project root) used to produce the plan. */
  drafts: readonly string[];
}

export function writeAdoptionCheckpoint(
  input: IWriteAdoptionCheckpointInput,
): IAdoptionCheckpoint {
  const targetHashes: Record<string, string> = {};
  for (const rel of input.targets) {
    const hash = hashFileIfExists(nodePath.resolve(input.projectRoot, rel));
    targetHashes[rel] = hash ?? '(missing)';
  }
  const draftHashes: Record<string, string> = {};
  for (const rel of input.drafts) {
    const hash = hashFileIfExists(nodePath.resolve(input.projectRoot, rel));
    draftHashes[rel] = hash ?? '(missing)';
  }
  const checkpoint: IAdoptionCheckpoint = {
    schema: ADOPTION_CHECKPOINT_SCHEMA,
    kind: input.kind,
    generatedAt: new Date().toISOString(),
    command: input.command,
    diffHash: input.diffHash,
    ...(input.patchHash ? { patchHash: input.patchHash } : {}),
    targetHashes,
    draftHashes,
  };
  const path = adoptionCheckpointPath(input.projectRoot, input.kind);
  mkdirSync(nodePath.dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(checkpoint, null, 2) + '\n', 'utf8');
  return checkpoint;
}

export interface IAdoptionCheckpointEvaluation {
  status: AdoptionCheckpointStatus;
  reasons: readonly string[];
  /** Targets whose hash diverged from the checkpoint. */
  changedTargets: readonly string[];
  /** Drafts whose hash diverged from the checkpoint. */
  changedDrafts: readonly string[];
  /** Diff hash on disk (if different). */
  currentDiffHash?: string;
  /** Age of the checkpoint in whole days. */
  ageDays?: number;
  /** True when content hashes still match but the checkpoint is
   *  older than maxAgeDays. */
  ageWarning?: boolean;
}

export interface IAdoptionCheckpointEvaluateOptions {
  targets?: readonly string[];
  drafts?: readonly string[];
  /** Max age in days before stale-age status. Default 30. */
  maxAgeDays?: number;
  /** Override current date (mainly for tests). */
  now?: Date;
}

function computeAgeDays(checkpoint: IAdoptionCheckpoint, now: Date): number {
  const generated = Date.parse(checkpoint.generatedAt);
  if (!Number.isFinite(generated)) return 0;
  const diffMs = now.getTime() - generated;
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
}

export function evaluateAdoptionCheckpoint(
  projectRoot: string,
  checkpoint: IAdoptionCheckpoint | null,
  currentDiffHash: string,
  options: IAdoptionCheckpointEvaluateOptions = {},
): IAdoptionCheckpointEvaluation {
  if (!checkpoint) {
    return {
      status: AdoptionCheckpointStatus.Missing,
      reasons: ['no adoption checkpoint on disk yet — run with --record-checkpoint'],
      changedTargets: [],
      changedDrafts: [],
    };
  }
  const reasons: string[] = [];
  const changedTargets: string[] = [];
  const changedDrafts: string[] = [];
  for (const [rel, recorded] of Object.entries(checkpoint.targetHashes)) {
    if (options.targets && !options.targets.includes(rel)) continue;
    const current = hashFileIfExists(nodePath.resolve(projectRoot, rel)) ?? '(missing)';
    if (current !== recorded) {
      changedTargets.push(rel);
    }
  }
  for (const [rel, recorded] of Object.entries(checkpoint.draftHashes)) {
    if (options.drafts && !options.drafts.includes(rel)) continue;
    const current = hashFileIfExists(nodePath.resolve(projectRoot, rel)) ?? '(missing)';
    if (current !== recorded) {
      changedDrafts.push(rel);
    }
  }
  const diffChanged = checkpoint.diffHash !== currentDiffHash;
  const now = options.now ?? new Date();
  const ageDays = computeAgeDays(checkpoint, now);
  const maxAgeDays = options.maxAgeDays ?? DEFAULT_CHECKPOINT_MAX_AGE_DAYS;
  const tooOld = maxAgeDays > 0 && ageDays > maxAgeDays;
  if (changedDrafts.length === 0 && changedTargets.length === 0 && !diffChanged) {
    if (tooOld) {
      return {
        status: AdoptionCheckpointStatus.StaleAge,
        reasons: [
          `hashes match but checkpoint is ${ageDays} day(s) old (max ${maxAgeDays}) — consider re-recording`,
        ],
        changedTargets,
        changedDrafts,
        currentDiffHash,
        ageDays,
        ageWarning: true,
      };
    }
    return {
      status: AdoptionCheckpointStatus.UpToDate,
      reasons: ['drafts, targets and diff hash all match the checkpoint'],
      changedTargets,
      changedDrafts,
      currentDiffHash,
      ageDays,
      ageWarning: false,
    };
  }
  if (changedDrafts.length > 0) {
    reasons.push(`${changedDrafts.length} draft(s) changed since checkpoint`);
  }
  if (changedTargets.length > 0) {
    reasons.push(`${changedTargets.length} target(s) changed since checkpoint`);
  }
  if (diffChanged) {
    reasons.push('diff hash no longer matches the checkpoint');
  }
  let status: AdoptionCheckpointStatus = AdoptionCheckpointStatus.NeedsRegenerate;
  if (changedDrafts.length > 0) status = AdoptionCheckpointStatus.StaleDraft;
  else if (changedTargets.length > 0) status = AdoptionCheckpointStatus.StaleTarget;
  else if (diffChanged) status = AdoptionCheckpointStatus.StaleDiff;
  return {
    status,
    reasons,
    changedTargets,
    changedDrafts,
    currentDiffHash,
    ageDays,
    ageWarning: tooOld,
  };
}

export interface IRecordAdoptionCheckpointInput {
  projectRoot: string;
  kind: AdoptionCheckpointKind;
  command: string;
  diffHash: string;
  patchHash?: string;
  targets: readonly string[];
  drafts: readonly string[];
}

export function recordAdoptionCheckpoint(
  input: IRecordAdoptionCheckpointInput,
): IAdoptionCheckpoint {
  return writeAdoptionCheckpoint(input);
}
