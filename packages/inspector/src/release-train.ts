/**
 * Local release train model.
 *
 * A release train groups bundles + checks under a target version. Teams
 * use it to plan grouped releases without ever auto-publishing or
 * tagging.
 *
 * Source: `sharkcraft/release-trains/<version>.json`. Read-only at the
 * inspector layer; the CLI handles dry-run writes.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';

export const RELEASE_TRAIN_SCHEMA = 'sharkcraft.release-train/v1';

export enum ReleaseTrainStatus {
  Planning = 'planning',
  InProgress = 'in-progress',
  ReadyToTag = 'ready-to-tag',
  Released = 'released',
  Cancelled = 'cancelled',
}

export interface IReleaseTrain {
  schema: typeof RELEASE_TRAIN_SCHEMA;
  id: string;
  version: string;
  targetDate: string;
  goals: readonly string[];
  includedBundles: readonly string[];
  requiredChecks: readonly string[];
  status: ReleaseTrainStatus;
}

const DEFAULT_REQUIRED_CHECKS: readonly string[] = [
  'typecheck',
  'tests',
  'shrk release readiness --strict',
  'shrk release smoke --scenario all',
];

export function releaseTrainDir(projectRoot: string): string {
  return nodePath.join(projectRoot, 'sharkcraft', 'release-trains');
}

export function listReleaseTrains(projectRoot: string): readonly IReleaseTrain[] {
  const dir = releaseTrainDir(projectRoot);
  if (!existsSync(dir)) return [];
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const out: IReleaseTrain[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(nodePath.join(dir, f), 'utf8')) as Partial<IReleaseTrain>;
      if (!parsed.id || !parsed.version) continue;
      out.push({
        schema: RELEASE_TRAIN_SCHEMA,
        id: parsed.id,
        version: parsed.version,
        targetDate: parsed.targetDate ?? '',
        goals: parsed.goals ?? [],
        includedBundles: parsed.includedBundles ?? [],
        requiredChecks: parsed.requiredChecks ?? DEFAULT_REQUIRED_CHECKS,
        status: parsed.status ?? ReleaseTrainStatus.Planning,
      });
    } catch {
      continue;
    }
  }
  return out;
}

export function getReleaseTrain(projectRoot: string, id: string): IReleaseTrain | undefined {
  return listReleaseTrains(projectRoot).find((t) => t.id === id);
}

export function buildReleaseTrainDraft(version: string, opts: { goals?: readonly string[] } = {}): IReleaseTrain {
  const id = `train-${version.replace(/[^a-zA-Z0-9]+/g, '-')}`;
  return {
    schema: RELEASE_TRAIN_SCHEMA,
    id,
    version,
    targetDate: '',
    goals: opts.goals ?? [],
    includedBundles: [],
    requiredChecks: DEFAULT_REQUIRED_CHECKS,
    status: ReleaseTrainStatus.Planning,
  };
}

export function writeReleaseTrainDraft(projectRoot: string, train: IReleaseTrain): string {
  const dir = releaseTrainDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  const file = nodePath.join(dir, `${train.id}.json`);
  writeFileSync(file, JSON.stringify(train, null, 2), 'utf8');
  return file;
}

export interface IReleaseTrainReadiness {
  trainId: string;
  ready: boolean;
  missingBundles: readonly string[];
  pendingChecks: readonly string[];
}

export function computeReleaseTrainReadiness(
  projectRoot: string,
  train: IReleaseTrain,
): IReleaseTrainReadiness {
  const missingBundles: string[] = [];
  for (const b of train.includedBundles) {
    const path = nodePath.join(projectRoot, '.sharkcraft', 'bundles', b);
    if (!existsSync(path)) missingBundles.push(b);
  }
  // Pending checks are advisory only — the user runs them locally.
  return {
    trainId: train.id,
    ready: missingBundles.length === 0,
    missingBundles,
    pendingChecks: train.requiredChecks,
  };
}
