import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as nodePath from 'node:path';
import type { ITaskPacket } from './task-packet.ts';
import type { ITaskDecomposition } from './task-decompose.ts';

export const FEATURE_BUNDLE_SCHEMA = 'sharkcraft.feature-bundle/v1';

export enum FeatureBundleStatus {
  Draft = 'draft',
  Planned = 'planned',
  PartiallyApplied = 'partially-applied',
  Applied = 'applied',
  Validated = 'validated',
  Failed = 'failed',
  Completed = 'completed',
}

export enum BundleRiskLevel {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
  Critical = 'critical',
}

export interface IFeatureBundlePlan {
  /** Stable name within the bundle (basename without extension). */
  name: string;
  templateId: string;
  generatedName?: string;
  variables: Record<string, string>;
  missingVariables: readonly string[];
  /** Plans file under `plans/<name>.json` or `plans/<name>.intent.md`. */
  file: string;
  status: 'intent' | 'saved' | 'reviewed' | 'applied' | 'failed';
  reviewReportFile?: string;
  signed?: boolean;
  /** Files this plan is expected to write (best-effort). */
  expectedTargets: readonly string[];
}

export interface IFeatureBundlePlanGroup {
  /** Ordering group: plans in the same group can be applied in any order. */
  id: string;
  planNames: readonly string[];
  description?: string;
}

export interface IFeatureBundleDependency {
  from: string;
  to: string;
  reason: string;
}

export interface IFeatureBundleValidation {
  startedAt: string;
  finishedAt: string;
  passed: boolean;
  warnings: number;
  commandsRun: { command: string; passed: boolean; note?: string }[];
  boundaryViolations: number;
  reportFile: string;
}

export interface IFeatureBundle {
  schema: typeof FEATURE_BUNDLE_SCHEMA;
  id: string;
  task: string;
  createdAt: string;
  updatedAt: string;
  projectRoot: string;
  sessionId?: string;
  pipelineId?: string;
  status: FeatureBundleStatus;
  plans: readonly IFeatureBundlePlan[];
  planGroups: readonly IFeatureBundlePlanGroup[];
  dependencies: readonly IFeatureBundleDependency[];
  validations: readonly IFeatureBundleValidation[];
  reports: readonly string[];
  affectedFiles: readonly string[];
  affectedAreas: readonly string[];
  riskLevel: BundleRiskLevel;
  nextAction: string | null;
  commandHints: readonly string[];
  warnings: readonly string[];
}

export function getBundlesRoot(cwd: string): string {
  return nodePath.join(cwd, '.sharkcraft', 'bundles');
}

export function getBundleDir(cwd: string, id: string): string {
  return nodePath.join(getBundlesRoot(cwd), id);
}

function nowIso(): string {
  return new Date().toISOString();
}

export interface ICreateFeatureBundleInput {
  id: string;
  task: string;
  projectRoot: string;
  packet: ITaskPacket;
  decomposition?: ITaskDecomposition;
  sessionId?: string;
}

export function createFeatureBundleState(input: ICreateFeatureBundleInput): IFeatureBundle {
  const created = nowIso();
  const pipelineId = input.packet.recommendedPipelines[0]?.pipelineId;
  const commandHints = [...input.packet.recommendedCliCommands].slice(0, 6);
  const dec = input.decomposition;
  const initialPlans: IFeatureBundlePlan[] = [];

  const out: IFeatureBundle = {
    schema: FEATURE_BUNDLE_SCHEMA,
    id: input.id,
    task: input.task,
    createdAt: created,
    updatedAt: created,
    projectRoot: input.projectRoot,
    status: FeatureBundleStatus.Draft,
    plans: initialPlans,
    planGroups: [],
    dependencies: [],
    validations: [],
    reports: [],
    affectedFiles: [],
    affectedAreas: dec?.riskAreas ?? [],
    riskLevel: assessRisk(input.packet, dec),
    nextAction: `shrk bundle plan ${input.id}`,
    commandHints,
    warnings: [],
  };
  if (input.sessionId) out.sessionId = input.sessionId;
  if (pipelineId) out.pipelineId = pipelineId;
  return out;
}

function assessRisk(packet: ITaskPacket, dec?: ITaskDecomposition): BundleRiskLevel {
  const subtasks = dec?.subtasks ?? [];
  if (subtasks.some((s) => s.riskLevel === 'high')) return BundleRiskLevel.High;
  if (packet.forbiddenActions.length > 5) return BundleRiskLevel.Medium;
  if (subtasks.some((s) => s.riskLevel === 'medium')) return BundleRiskLevel.Medium;
  return BundleRiskLevel.Low;
}

export function writeFeatureBundle(cwd: string, bundle: IFeatureBundle): IFeatureBundle {
  const dir = getBundleDir(cwd, bundle.id);
  mkdirSync(dir, { recursive: true });
  mkdirSync(nodePath.join(dir, 'plans'), { recursive: true });
  mkdirSync(nodePath.join(dir, 'reviews'), { recursive: true });
  mkdirSync(nodePath.join(dir, 'reports'), { recursive: true });
  const next: IFeatureBundle = { ...bundle, updatedAt: nowIso() };
  writeFileSync(
    nodePath.join(dir, 'bundle.json'),
    JSON.stringify(next, null, 2) + '\n',
    'utf8',
  );
  return next;
}

export function readFeatureBundle(cwd: string, id: string): IFeatureBundle | null {
  const file = nodePath.join(getBundleDir(cwd, id), 'bundle.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as IFeatureBundle;
  } catch {
    return null;
  }
}

export function listFeatureBundles(cwd: string): IFeatureBundle[] {
  const root = getBundlesRoot(cwd);
  if (!existsSync(root)) return [];
  const ids: string[] = [];
  try {
    for (const e of readdirSync(root)) {
      try {
        if (statSync(nodePath.join(root, e)).isDirectory()) ids.push(e);
      } catch {
        /* ignore */
      }
    }
  } catch {
    return [];
  }
  ids.sort();
  const out: IFeatureBundle[] = [];
  for (const id of ids) {
    const b = readFeatureBundle(cwd, id);
    if (b) out.push(b);
  }
  return out;
}

export function upsertBundlePlan(
  bundle: IFeatureBundle,
  plan: IFeatureBundlePlan,
): IFeatureBundle {
  const plans = bundle.plans.filter((p) => p.name !== plan.name);
  return { ...bundle, plans: [...plans, plan] };
}

export function recomputeBundleStatus(bundle: IFeatureBundle): IFeatureBundle {
  if (bundle.plans.length === 0) return { ...bundle, status: FeatureBundleStatus.Draft };
  const allApplied = bundle.plans.every((p) => p.status === 'applied');
  const someApplied = bundle.plans.some((p) => p.status === 'applied');
  const allReviewed = bundle.plans.every((p) => p.status === 'reviewed' || p.status === 'applied' || p.status === 'intent');
  const validatedOk = bundle.validations.length > 0 && bundle.validations.every((v) => v.passed);
  let status: FeatureBundleStatus = FeatureBundleStatus.Draft;
  if (allReviewed && !someApplied) status = FeatureBundleStatus.Planned;
  if (someApplied && !allApplied) status = FeatureBundleStatus.PartiallyApplied;
  if (allApplied) status = FeatureBundleStatus.Applied;
  if (allApplied && validatedOk) status = FeatureBundleStatus.Validated;
  if (bundle.validations.some((v) => !v.passed)) status = FeatureBundleStatus.Failed;
  return { ...bundle, status };
}

export function setBundleNextAction(
  bundle: IFeatureBundle,
  nextAction: string | null,
): IFeatureBundle {
  return { ...bundle, nextAction };
}

export function recordBundleReport(bundle: IFeatureBundle, file: string): IFeatureBundle {
  if (bundle.reports.includes(file)) return bundle;
  return { ...bundle, reports: [...bundle.reports, file] };
}

export function recordBundleValidation(
  bundle: IFeatureBundle,
  v: IFeatureBundleValidation,
): IFeatureBundle {
  return { ...bundle, validations: [...bundle.validations, v] };
}

/**
 * Mark a plan as applied (status='applied') after a human ran `shrk apply`.
 * Returns the updated bundle without touching validations.
 */
export function markBundlePlanApplied(
  bundle: IFeatureBundle,
  planName: string,
  note?: string,
): IFeatureBundle {
  const plans = bundle.plans.map((p) =>
    p.name === planName ? ({ ...p, status: 'applied' as const, ...(note ? { note } : {}) } as IFeatureBundlePlan) : p,
  );
  return { ...bundle, plans };
}

/**
 * Persist graph-derived dependencies onto the bundle so MCP / read-only
 * consumers can see the order without rebuilding the graph from the
 * registries. `planGroups` are derived from the topological order: every plan
 * whose predecessors are already in an earlier group becomes a new group.
 */
export function setBundleDependencies(
  bundle: IFeatureBundle,
  edges: readonly IFeatureBundleDependency[],
  order: readonly string[],
): IFeatureBundle {
  const incoming = new Map<string, Set<string>>();
  for (const e of edges) {
    const s = incoming.get(e.to) ?? new Set<string>();
    s.add(e.from);
    incoming.set(e.to, s);
  }
  const placed = new Set<string>();
  const groups: IFeatureBundlePlanGroup[] = [];
  let remaining = [...order];
  let idx = 0;
  while (remaining.length > 0) {
    const wave = remaining.filter((n) => {
      const deps = incoming.get(n) ?? new Set<string>();
      for (const d of deps) if (!placed.has(d)) return false;
      return true;
    });
    if (wave.length === 0) {
      // Cycle remnant — pack everything left into a final group so the
      // bundle stays writable.
      groups.push({
        id: `group-${idx + 1}`,
        planNames: remaining,
        description: 'unresolved dependency cycle',
      });
      for (const n of remaining) placed.add(n);
      break;
    }
    groups.push({
      id: `group-${idx + 1}`,
      planNames: wave,
    });
    for (const n of wave) placed.add(n);
    remaining = remaining.filter((n) => !placed.has(n));
    idx += 1;
  }
  return { ...bundle, dependencies: edges, planGroups: groups };
}
