/**
 * sharkcraft.adoption-state/v1
 *
 * Persistent state for the onboarding adoption workflow. Written under
 * `sharkcraft/onboarding/adoption/adoption-state.json` whenever a patch is
 * generated. Captures source draft + target file hashes so freshness can be
 * computed deterministically without re-running inference.
 *
 * Writes are confined to `sharkcraft/onboarding/adoption/` — never live config.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as nodePath from 'node:path';
import { AdoptionCategory } from './onboarding-adoption.ts';
import type {
  AdoptionKind,
  IAdoptionItem,
  IAdoptionPatchTarget,
  IAdoptionPlan,
} from './onboarding-adoption.ts';

export const ADOPTION_STATE_SCHEMA = 'sharkcraft.adoption-state/v1';

export enum AdoptionFreshnessStatus {
  Fresh = 'fresh',
  Stale = 'stale',
  Unknown = 'unknown',
}

export interface IAdoptionStateCategorySummary {
  [AdoptionCategory.SafeToAdopt]: readonly string[];
  [AdoptionCategory.ManualReview]: readonly string[];
  [AdoptionCategory.LowConfidence]: readonly string[];
  [AdoptionCategory.Conflict]: readonly string[];
  [AdoptionCategory.AlreadyCovered]: readonly string[];
  [AdoptionCategory.Skipped]: readonly string[];
}

export interface IAdoptionStateFile {
  relativePath: string;
  hash: string;
}

export interface IAdoptionStateFreshness {
  status: AdoptionFreshnessStatus;
  staleReasons: readonly string[];
}

export interface IAdoptionState {
  schema: typeof ADOPTION_STATE_SCHEMA;
  projectRoot: string;
  createdAt: string;
  updatedAt: string;
  sharkcraftVersion: string;
  command: string;
  sourceDraftFiles: readonly IAdoptionStateFile[];
  targetFiles: readonly IAdoptionStateFile[];
  /** Patch + summary + report files this run produced. Relative to projectRoot. */
  generatedFiles: readonly string[];
  patchPath: string;
  summaryPath: string;
  reportPath?: string;
  diffFormat: 'pseudo' | 'unified';
  confidenceThreshold: 'high' | 'medium' | 'low';
  includedKinds: readonly AdoptionKind[];
  excludedKinds: readonly AdoptionKind[];
  categories: IAdoptionStateCategorySummary;
  freshness: IAdoptionStateFreshness;
  warnings: readonly string[];
  nextCommands: readonly string[];
}

const ADOPTION_DIR_RELATIVE = nodePath.join('sharkcraft', 'onboarding', 'adoption');
const ADOPTION_DRAFT_DIR_RELATIVE = nodePath.join('sharkcraft', 'onboarding');
const STATE_FILENAME = 'adoption-state.json';

export function adoptionDir(projectRoot: string): string {
  return nodePath.resolve(projectRoot, ADOPTION_DIR_RELATIVE);
}

export function adoptionStatePath(projectRoot: string): string {
  return nodePath.join(adoptionDir(projectRoot), STATE_FILENAME);
}

export function adoptionHistoryDir(projectRoot: string): string {
  return nodePath.join(adoptionDir(projectRoot), 'history');
}

function readSafe(absolute: string): string | null {
  try {
    return readFileSync(absolute, 'utf8');
  } catch {
    return null;
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function hashFile(absolute: string): string | null {
  const body = readSafe(absolute);
  if (body === null) return null;
  return sha256(body);
}

function buildCategoryIds(plan: IAdoptionPlan): IAdoptionStateCategorySummary {
  const out: Record<AdoptionCategory, string[]> = {
    [AdoptionCategory.SafeToAdopt]: [],
    [AdoptionCategory.ManualReview]: [],
    [AdoptionCategory.LowConfidence]: [],
    [AdoptionCategory.Conflict]: [],
    [AdoptionCategory.AlreadyCovered]: [],
    [AdoptionCategory.Skipped]: [],
  };
  for (const it of plan.items) {
    out[it.category].push(`${it.kind}:${it.id}`);
  }
  return {
    [AdoptionCategory.SafeToAdopt]: out[AdoptionCategory.SafeToAdopt],
    [AdoptionCategory.ManualReview]: out[AdoptionCategory.ManualReview],
    [AdoptionCategory.LowConfidence]: out[AdoptionCategory.LowConfidence],
    [AdoptionCategory.Conflict]: out[AdoptionCategory.Conflict],
    [AdoptionCategory.AlreadyCovered]: out[AdoptionCategory.AlreadyCovered],
    [AdoptionCategory.Skipped]: out[AdoptionCategory.Skipped],
  };
}

/** Collect every draft file under sharkcraft/onboarding/ that the adoption
 *  plan derived items from. We always include the directory listing for
 *  robustness — a draft can affect the plan without being explicitly named. */
function collectDraftFileHashes(projectRoot: string): IAdoptionStateFile[] {
  const dir = nodePath.resolve(projectRoot, ADOPTION_DRAFT_DIR_RELATIVE);
  if (!existsSync(dir)) return [];
  const files: IAdoptionStateFile[] = [];
  const visit = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e === 'adoption') continue; // never include adoption outputs as drafts
      const full = nodePath.join(d, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        visit(full);
      } else if (st.isFile() && /\.(draft\.ts|draft\.md|md|ts)$/.test(e)) {
        const body = readSafe(full);
        if (body !== null) {
          files.push({
            relativePath: nodePath.relative(projectRoot, full).split(nodePath.sep).join('/'),
            hash: sha256(body),
          });
        }
      }
    }
  };
  visit(dir);
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function collectTargetHashes(
  projectRoot: string,
  targets: readonly IAdoptionPatchTarget[],
): IAdoptionStateFile[] {
  const out: IAdoptionStateFile[] = [];
  for (const t of targets) {
    if (t.beforeHash) {
      out.push({ relativePath: t.relativePath, hash: t.beforeHash });
      continue;
    }
    const full = nodePath.resolve(projectRoot, t.relativePath);
    const h = hashFile(full);
    out.push({ relativePath: t.relativePath, hash: h ?? '(missing)' });
  }
  return out;
}

export interface IBuildAdoptionStateInput {
  projectRoot: string;
  command: string;
  patchPath: string;
  summaryPath: string;
  reportPath?: string;
  diffFormat: 'pseudo' | 'unified';
  plan: IAdoptionPlan;
  targets: readonly IAdoptionPatchTarget[];
  generatedFiles: readonly string[];
  warnings?: readonly string[];
  nextCommands?: readonly string[];
  sharkcraftVersion?: string;
  /** When provided, preserve the prior createdAt (so updatedAt reflects regen). */
  previousCreatedAt?: string;
}

export function buildAdoptionState(input: IBuildAdoptionStateInput): IAdoptionState {
  const now = new Date().toISOString();
  const state: IAdoptionState = {
    schema: ADOPTION_STATE_SCHEMA,
    projectRoot: input.projectRoot,
    createdAt: input.previousCreatedAt ?? now,
    updatedAt: now,
    sharkcraftVersion: input.sharkcraftVersion ?? '0.1.0-alpha.2',
    command: input.command,
    sourceDraftFiles: collectDraftFileHashes(input.projectRoot),
    targetFiles: collectTargetHashes(input.projectRoot, input.targets),
    generatedFiles: input.generatedFiles,
    patchPath: input.patchPath,
    summaryPath: input.summaryPath,
    ...(input.reportPath ? { reportPath: input.reportPath } : {}),
    diffFormat: input.diffFormat,
    confidenceThreshold: input.plan.confidence,
    includedKinds: input.plan.included,
    excludedKinds: input.plan.excluded,
    categories: buildCategoryIds(input.plan),
    freshness: { status: AdoptionFreshnessStatus.Fresh, staleReasons: [] },
    warnings: input.warnings ?? [],
    nextCommands:
      input.nextCommands ??
      [
        'shrk onboard adopt status',
        'shrk onboard adopt review',
        'git apply sharkcraft/onboarding/adoption/adopt.patch',
      ],
  };
  return state;
}

export function writeAdoptionState(projectRoot: string, state: IAdoptionState): string {
  const target = adoptionStatePath(projectRoot);
  const dir = nodePath.dirname(target);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!target.startsWith(adoptionDir(projectRoot))) {
    throw new Error(`adoption state path escapes adoption dir: ${target}`);
  }
  writeFileSync(target, JSON.stringify(state, null, 2) + '\n', 'utf8');
  return target;
}

export function readAdoptionState(projectRoot: string): IAdoptionState | null {
  const target = adoptionStatePath(projectRoot);
  const body = readSafe(target);
  if (body === null) return null;
  try {
    const parsed = JSON.parse(body) as IAdoptionState;
    if (parsed.schema !== ADOPTION_STATE_SCHEMA) return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface IComputeFreshnessResult extends IAdoptionStateFreshness {
  changedTargets: readonly IAdoptionStateFile[];
  changedDrafts: readonly IAdoptionStateFile[];
  missingTargets: readonly string[];
  missingDrafts: readonly string[];
}

/**
 * Recompute freshness from disk. Compares stored hashes against current file
 * content. A patch is stale when any target or draft file changed since the
 * state was written (or when state files are missing).
 */
export function computeAdoptionFreshness(
  projectRoot: string,
  state: IAdoptionState | null,
): IComputeFreshnessResult {
  if (!state) {
    return {
      status: AdoptionFreshnessStatus.Unknown,
      staleReasons: ['no adoption state on disk'],
      changedTargets: [],
      changedDrafts: [],
      missingTargets: [],
      missingDrafts: [],
    };
  }
  const reasons: string[] = [];
  const changedTargets: IAdoptionStateFile[] = [];
  const changedDrafts: IAdoptionStateFile[] = [];
  const missingTargets: string[] = [];
  const missingDrafts: string[] = [];

  for (const t of state.targetFiles) {
    const full = nodePath.resolve(projectRoot, t.relativePath);
    if (!existsSync(full)) {
      // The "(missing)" placeholder means "the target didn't exist when we
      // wrote the patch" — that's a create-file hunk. If it still doesn't
      // exist, that's fresh. If it now exists, that's a stale-target change.
      if (t.hash === '(missing)') continue;
      missingTargets.push(t.relativePath);
      reasons.push(`target file vanished: ${t.relativePath}`);
      continue;
    }
    const current = hashFile(full);
    if (t.hash === '(missing)') {
      // Target was created since plan-time.
      changedTargets.push(t);
      reasons.push(`target file created after patch: ${t.relativePath}`);
      continue;
    }
    if (current && current !== t.hash) {
      changedTargets.push(t);
      reasons.push(`target file changed: ${t.relativePath}`);
    }
  }

  // Drafts: compare against the directory now. Any added/removed/edited file
  // is a stale signal.
  const currentDrafts = collectDraftFileHashes(projectRoot);
  const currentByPath = new Map(currentDrafts.map((f) => [f.relativePath, f.hash]));
  const previousByPath = new Map(state.sourceDraftFiles.map((f) => [f.relativePath, f.hash]));
  for (const [path, hash] of previousByPath) {
    if (!currentByPath.has(path)) {
      missingDrafts.push(path);
      reasons.push(`draft file removed: ${path}`);
      continue;
    }
    if (currentByPath.get(path) !== hash) {
      changedDrafts.push({ relativePath: path, hash });
      reasons.push(`draft file changed: ${path}`);
    }
  }
  for (const [path, hash] of currentByPath) {
    if (!previousByPath.has(path)) {
      changedDrafts.push({ relativePath: path, hash });
      reasons.push(`new draft file appeared: ${path}`);
    }
  }

  const status =
    reasons.length === 0 ? AdoptionFreshnessStatus.Fresh : AdoptionFreshnessStatus.Stale;
  return {
    status,
    staleReasons: reasons,
    changedTargets,
    changedDrafts,
    missingTargets,
    missingDrafts,
  };
}

/** Archive the previous adoption-state.json + adopt.patch under history/. */
export interface IArchiveAdoptionStateResult {
  archived: readonly string[];
  historyDir: string;
}

export function archivePreviousAdoptionOutputs(
  projectRoot: string,
  timestamp: string = new Date().toISOString().replace(/[:.]/g, '-'),
): IArchiveAdoptionStateResult {
  const dir = adoptionDir(projectRoot);
  if (!existsSync(dir)) return { archived: [], historyDir: adoptionHistoryDir(projectRoot) };
  const history = adoptionHistoryDir(projectRoot);
  if (!existsSync(history)) mkdirSync(history, { recursive: true });
  const archived: string[] = [];
  for (const name of ['adoption-state.json', 'adopt.patch', 'adoption-plan.md', 'adopt-summary.json']) {
    const src = nodePath.join(dir, name);
    if (!existsSync(src)) continue;
    const dest = nodePath.join(history, `${timestamp}-${name}`);
    if (existsSync(dest)) {
      // Never overwrite history.
      continue;
    }
    renameSync(src, dest);
    archived.push(dest);
  }
  return { archived, historyDir: history };
}

/** Convenience used by `shrk onboard adopt regenerate`. */
export interface IUpdateAdoptionStateInput
  extends Omit<IBuildAdoptionStateInput, 'previousCreatedAt'> {
  /** When the user passes --force, we still archive previous outputs first. */
  archivePrevious: boolean;
}

export function updateAdoptionStateAfterRegenerate(
  input: IUpdateAdoptionStateInput,
): { state: IAdoptionState; archived: IArchiveAdoptionStateResult | null; statePath: string } {
  const previous = readAdoptionState(input.projectRoot);
  const archived = input.archivePrevious
    ? archivePreviousAdoptionOutputs(input.projectRoot)
    : null;
  const state = buildAdoptionState({
    ...input,
    ...(previous ? { previousCreatedAt: previous.createdAt } : {}),
  });
  const statePath = writeAdoptionState(input.projectRoot, state);
  return { state, archived, statePath };
}

// Re-export for convenience.
export type { IAdoptionItem };
