import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { scanImports, loadTsconfigPaths } from '@shrkcrft/boundaries';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import type { IAreaMap } from './area-map.ts';
import { AreaKind, buildAreaMap } from './area-map.ts';
import { rankAll } from './task-ranker.ts';
import { loadOwnershipRules, impactFor, type IOwnershipImpact } from './ownership.ts';

export const IMPACT_ANALYSIS_SCHEMA = 'sharkcraft.impact-analysis/v2';

export enum ImpactRisk {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
  Critical = 'critical',
}

export enum ImpactInputKind {
  File = 'file',
  Files = 'files',
  Specifier = 'specifier',
  Since = 'since',
  Staged = 'staged',
  Plan = 'plan',
  Bundle = 'bundle',
  Task = 'task',
  Mixed = 'mixed',
  Empty = 'empty',
}

export interface IImpactAnalysisInput {
  task?: string;
  files?: readonly string[];
  planTargets?: readonly string[];
  specifier?: string;
  /** Hint: how the caller produced the file list. */
  inputKind?: ImpactInputKind;
  areaMap?: IAreaMap;
  /** Cap on transitive depth. Default: 5. */
  maxDepth?: number;
  /** Max items in each list (truncation guard). Default: 200. */
  limit?: number;
}

export interface IImpactDependentPath {
  /** Direct importer file. */
  from: string;
  /** Ultimate target file in the input set (or the file reached through specifier). */
  to: string;
  /** Files visited on the way from `from` → `to`. */
  via: readonly string[];
}

export interface IImpactAreaSummary {
  id: string;
  kind: AreaKind;
  fileCount: number;
}

export interface IImpactWorkspaceSummary {
  name: string;
  directory: string;
  fileCount: number;
}

export interface IImpactPolicyConcern {
  policyId: string;
  reason: string;
  severity: 'info' | 'warning' | 'error';
}

export interface IImpactBoundaryConcern {
  ruleId: string;
  reason: string;
  severity: 'info' | 'warning' | 'error';
}

export interface IImpactReason {
  code: string;
  message: string;
  detail?: string;
}

export interface IImpactTruncation {
  list: string;
  total: number;
  shown: number;
}

export interface IImpactAnalysis {
  schema: typeof IMPACT_ANALYSIS_SCHEMA;
  task: string;
  inputKind: ImpactInputKind;
  /** Files / paths that the caller is asking about (normalized, relative to projectRoot). */
  normalizedTargets: readonly string[];
  /** Specifier the caller passed in, when --specifier was used. */
  specifier?: string;
  /** Files mentioned in the original input (kept for the legacy field name). */
  affectedFiles: readonly string[];
  /** Direct dependents — files that import one of the targets directly. */
  directDependents: readonly string[];
  /** Transitive dependents — files reachable via repeated importer edges. */
  transitiveDependents: readonly string[];
  /** Example dependency paths (truncated by `limit`). */
  dependencyPathExamples: readonly IImpactDependentPath[];
  /** Areas the target/dependents touch. */
  affectedAreas: readonly IImpactAreaSummary[];
  /** Workspace packages the target/dependents touch. */
  affectedPackages: readonly IImpactWorkspaceSummary[];
  /** Path conventions the target/dependents touch. */
  affectedPathConventions: readonly string[];
  /** Boundary rules potentially impacted. */
  potentialBoundaryRisks: readonly IImpactBoundaryConcern[];
  /** Policy checks potentially affected. */
  affectedPolicies: readonly IImpactPolicyConcern[];
  /** Ownership entries touched (best-effort summary). */
  affectedOwnership: IOwnershipImpact | null;
  /** Templates likely affected by changes. */
  affectedTemplates: readonly { id: string; name: string }[];
  /** Pipelines likely affected. */
  affectedPipelines: readonly { id: string; title: string }[];
  /** Presets likely affected. */
  affectedPresets: readonly { id: string; name: string }[];
  /** Constructs likely affected. */
  affectedConstructs: readonly { id: string; type: string; title: string }[];
  /** Heuristic likely-test files (existing + suggested). */
  likelyTests: readonly string[];
  /** Suggested commands. */
  suggestedTestCommands: readonly string[];
  suggestedFullTestCommands: readonly string[];
  suggestedValidationCommands: readonly string[];
  suggestedReviewCommands: readonly string[];
  /** Related rules / templates for the task. */
  relatedRules: readonly { id: string; title: string }[];
  relatedTemplates: readonly { id: string; name: string }[];
  /** Risk classification + reasons. */
  risk: ImpactRisk;
  riskReasons: readonly IImpactReason[];
  explanation: string;
  /** Truncation notes for over-limit lists. */
  truncations: readonly IImpactTruncation[];
  /** Diagnostics (warnings emitted while computing the report). */
  diagnostics: readonly string[];
}

interface IBuildContext {
  inspection: ISharkcraftInspection;
  files: readonly string[];
  inputKind: ImpactInputKind;
  task: string;
  specifier?: string;
  maxDepth: number;
  limit: number;
  areaMap: IAreaMap;
}

const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_LIMIT = 200;

function unique<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}

function inferInputKind(input: IImpactAnalysisInput): ImpactInputKind {
  if (input.inputKind) return input.inputKind;
  if (input.specifier) return ImpactInputKind.Specifier;
  if (input.planTargets && input.planTargets.length > 0 && (!input.files || input.files.length === 0)) {
    return ImpactInputKind.Plan;
  }
  if (input.files && input.files.length > 0) return ImpactInputKind.Files;
  if (input.task) return ImpactInputKind.Task;
  return ImpactInputKind.Empty;
}

function normalizeRel(projectRoot: string, p: string): string {
  if (!p) return p;
  if (nodePath.isAbsolute(p)) {
    const rel = nodePath.relative(projectRoot, p);
    return rel.split(nodePath.sep).join('/');
  }
  // Strip leading ./ noise.
  return p.replace(/^\.\/?/, '').split(nodePath.sep).join('/');
}

interface IReverseGraph {
  /** file → set of files importing it. */
  importers: Map<string, Set<string>>;
  /** all internal edges scanned. */
  edgeCount: number;
  /** alias map used for resolution. */
  aliasMap: ReadonlyMap<string, readonly string[]>;
}

function buildReverseGraph(projectRoot: string): IReverseGraph {
  let scan;
  try {
    scan = scanImports({ projectRoot });
  } catch {
    return { importers: new Map(), edgeCount: 0, aliasMap: new Map() };
  }
  let aliasMap: ReadonlyMap<string, readonly string[]>;
  try {
    aliasMap = loadTsconfigPaths(projectRoot).aliases;
  } catch {
    aliasMap = new Map();
  }
  const importers = new Map<string, Set<string>>();
  for (const e of scan.edges) {
    const targets = resolveTargets(projectRoot, e.from, e.importSpecifier, aliasMap);
    for (const t of targets) {
      const set = importers.get(t) ?? new Set<string>();
      set.add(e.from);
      importers.set(t, set);
    }
  }
  return { importers, edgeCount: scan.edges.length, aliasMap };
}

function resolveTargets(
  projectRoot: string,
  from: string,
  spec: string,
  aliasMap: ReadonlyMap<string, readonly string[]>,
): string[] {
  const out: string[] = [];
  if (spec.startsWith('.')) {
    const dir = nodePath.posix.dirname(from);
    const joined = nodePath.posix.normalize(nodePath.posix.join(dir, spec));
    out.push(joined);
    out.push(joined + '.ts');
    out.push(joined + '.tsx');
    out.push(joined + '/index.ts');
    return out;
  }
  for (const [pattern, paths] of aliasMap.entries()) {
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      if (!spec.startsWith(prefix)) continue;
      const rest = spec.slice(prefix.length);
      for (const targetPattern of paths) {
        const resolved = targetPattern.replace(/\*/g, rest);
        out.push(resolved);
        out.push(resolved + '.ts');
        out.push(resolved + '.tsx');
        out.push(resolved + '/index.ts');
      }
      continue;
    }
    if (pattern === spec) {
      for (const t of paths) {
        out.push(t);
        out.push(t + '.ts');
        out.push(t + '.tsx');
        out.push(t + '/index.ts');
      }
    }
  }
  return out;
}

function matchTargetsBySpecifier(
  spec: string,
  aliasMap: ReadonlyMap<string, readonly string[]>,
): string[] {
  // Returns possible files the specifier could resolve to, regardless of
  // the importing file. Used by --specifier.
  if (spec.startsWith('.')) return [];
  const out: string[] = [];
  for (const [pattern, paths] of aliasMap.entries()) {
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      if (!spec.startsWith(prefix)) continue;
      const rest = spec.slice(prefix.length);
      for (const targetPattern of paths) {
        const resolved = targetPattern.replace(/\*/g, rest);
        out.push(resolved);
        out.push(resolved + '.ts');
        out.push(resolved + '/index.ts');
      }
    } else if (pattern === spec) {
      for (const t of paths) {
        out.push(t);
        out.push(t + '.ts');
        out.push(t + '/index.ts');
      }
    }
  }
  return out;
}

function closeDependents(
  reverse: IReverseGraph,
  seeds: readonly string[],
  maxDepth: number,
): { direct: string[]; transitive: string[]; paths: IImpactDependentPath[] } {
  const direct = new Set<string>();
  const all = new Set<string>();
  const paths: IImpactDependentPath[] = [];
  const visited = new Map<string, number>();
  // BFS from each seed.
  for (const seed of seeds) {
    const queue: { node: string; depth: number; via: string[]; root: string }[] = [
      { node: seed, depth: 0, via: [], root: seed },
    ];
    const seenLocal = new Set<string>([seed]);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const importers = reverse.importers.get(cur.node);
      if (!importers) continue;
      for (const importer of importers) {
        if (cur.depth === 0) direct.add(importer);
        all.add(importer);
        if (paths.length < 25 && cur.via.length < 4) {
          paths.push({
            from: importer,
            to: cur.root,
            via: [...cur.via, cur.node],
          });
        }
        const prevDepth = visited.get(importer);
        if (prevDepth !== undefined && prevDepth <= cur.depth + 1) continue;
        visited.set(importer, cur.depth + 1);
        if (cur.depth + 1 >= maxDepth) continue;
        if (seenLocal.has(importer)) continue;
        seenLocal.add(importer);
        queue.push({
          node: importer,
          depth: cur.depth + 1,
          via: [...cur.via, cur.node],
          root: cur.root,
        });
      }
    }
  }
  return { direct: [...direct].sort(), transitive: [...all].sort(), paths };
}

function detectWorkspaces(ctx: IBuildContext): IImpactWorkspaceSummary[] {
  const pkgPath = nodePath.join(ctx.inspection.projectRoot, 'package.json');
  if (!existsSync(pkgPath)) return [];
  let workspaces: string[] = [];
  try {
    const json = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      workspaces?: readonly string[] | { packages?: readonly string[] };
    };
    if (Array.isArray(json.workspaces)) workspaces = [...json.workspaces];
    else
      workspaces =
        (json.workspaces as { packages?: readonly string[] } | undefined)?.packages?.slice() ??
        [];
  } catch {
    return [];
  }
  const out = new Map<string, IImpactWorkspaceSummary>();
  for (const w of workspaces) {
    const dir = w.replace(/\/\*?$/, '');
    for (const f of ctx.files) {
      if (!f.startsWith(dir + '/')) continue;
      const rest = f.slice(dir.length + 1);
      const pkgName = rest.split('/')[0];
      if (!pkgName) continue;
      const pkgFile = nodePath.join(ctx.inspection.projectRoot, dir, pkgName, 'package.json');
      if (!existsSync(pkgFile)) continue;
      const key = `${dir}/${pkgName}`;
      const existing = out.get(key);
      let name = pkgName;
      try {
        name =
          (JSON.parse(readFileSync(pkgFile, 'utf8')) as { name?: string }).name ?? pkgName;
      } catch {
        /* ignore */
      }
      if (existing) {
        existing.fileCount += 1;
      } else {
        out.set(key, { name, directory: key, fileCount: 1 });
      }
    }
  }
  return [...out.values()].sort((a, b) => b.fileCount - a.fileCount);
}

function affectedAreaSummary(ctx: IBuildContext): IImpactAreaSummary[] {
  const allTouched = unique([...ctx.files]);
  const out = new Map<string, IImpactAreaSummary>();
  for (const a of ctx.areaMap.areas) {
    const hitCount = allTouched.filter((f) =>
      a.paths.some((p) => f === p || f.startsWith(p + '/') || f.startsWith(p)),
    ).length;
    if (hitCount > 0) {
      out.set(a.id, { id: a.id, kind: a.kind, fileCount: hitCount });
    }
  }
  return [...out.values()].sort((a, b) => b.fileCount - a.fileCount);
}

function boundaryRisks(
  ctx: IBuildContext,
  affected: readonly IImpactAreaSummary[],
): IImpactBoundaryConcern[] {
  const risks: IImpactBoundaryConcern[] = [];
  const seen = new Set<string>();
  for (const a of affected) {
    const area = ctx.areaMap.areas.find((x) => x.id === a.id);
    if (!area) continue;
    for (const ruleId of area.boundaryRuleIds) {
      const rule = ctx.inspection.boundaryRegistry.get(ruleId);
      if (!rule) continue;
      const key = `${a.id}:${ruleId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      risks.push({
        ruleId,
        reason: `Affects area ${a.id}; rule ${ruleId} guards that area.`,
        severity: ((rule as { severity?: 'info' | 'warning' | 'error' }).severity ?? 'warning'),
      });
    }
  }
  return risks;
}

function affectedTemplates(
  ctx: IBuildContext,
): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const t of ctx.inspection.templateRegistry.list()) {
    const tp = (t as unknown as { targetPath?: unknown }).targetPath;
    const path = typeof tp === 'string' ? tp : '';
    if (!path) continue;
    if (ctx.files.some((f) => f.includes(path) || path.includes(f.split('/').pop() ?? ''))) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push({ id: t.id, name: t.name });
    }
  }
  return out;
}

function affectedPipelines(ctx: IBuildContext): { id: string; title: string }[] {
  const out: { id: string; title: string }[] = [];
  for (const p of ctx.inspection.pipelineRegistry.list()) {
    const stepsString = JSON.stringify(p.steps ?? []).toLowerCase();
    if (ctx.files.some((f) => stepsString.includes(f.toLowerCase()))) {
      out.push({ id: p.id, title: p.title ?? p.id });
    }
  }
  return out;
}

function affectedPresets(ctx: IBuildContext): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  try {
    const presets = ctx.inspection.presetRegistry.list() as unknown as readonly {
      id?: string;
      name?: string;
    }[];
    for (const p of presets) {
      if (!p.id) continue;
      const blob = JSON.stringify(p).toLowerCase();
      if (ctx.files.some((f) => blob.includes(f.toLowerCase().split('/').pop() ?? ''))) {
        out.push({ id: p.id, name: p.name ?? p.id });
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

function affectedConstructs(
  ctx: IBuildContext,
): { id: string; type: string; title: string }[] {
  // Constructs come from the project's construct registry (loaded at inspection time).
  // We probe the inspection object for an optional `constructs` field.
  const list = (ctx.inspection as unknown as {
    constructs?: { id: string; type: string; title: string; files?: readonly string[] }[];
  }).constructs;
  if (!list) return [];
  const out: { id: string; type: string; title: string }[] = [];
  const allTouched = new Set(ctx.files);
  for (const c of list) {
    const cf = c.files ?? [];
    if (cf.some((f) => allTouched.has(f) || ctx.files.some((tf) => tf.startsWith(f) || f.startsWith(tf)))) {
      out.push({ id: c.id, type: c.type, title: c.title });
    }
  }
  return out;
}

function affectedPolicies(
  ctx: IBuildContext,
  affected: readonly IImpactAreaSummary[],
  boundary: readonly IImpactBoundaryConcern[],
): IImpactPolicyConcern[] {
  // Lightweight: surface policies whose ids hint at boundaries / public-api / ownership
  // when those domains are in play. The full policy run is a separate command.
  const concerns: IImpactPolicyConcern[] = [];
  const hasPublicApi = ctx.files.some(
    (f) => f.includes('index.ts') || f.includes('plugin-api') || f.includes('public-api'),
  );
  const touchesPolicy = ctx.files.some((f) => f.includes('policy') || f.includes('policy-engine'));
  if (boundary.length > 0) {
    concerns.push({
      policyId: 'policy.boundary-impact',
      reason: 'Touches files governed by boundary rules; run `shrk policy run`.',
      severity: 'warning',
    });
  }
  if (hasPublicApi) {
    concerns.push({
      policyId: 'plugin-api.public-entrypoint',
      reason: 'Touches a public entrypoint; downstream consumers may be affected.',
      severity: 'warning',
    });
  }
  if (touchesPolicy) {
    concerns.push({
      policyId: 'policy.engine',
      reason: 'Modifies the policy engine itself; run policy tests with fixtures.',
      severity: 'warning',
    });
  }
  if (affected.some((a) => a.kind === AreaKind.Core)) {
    concerns.push({
      policyId: 'core.protected-area',
      reason: 'Core area touched; requires elevated review.',
      severity: 'error',
    });
  }
  return concerns;
}

async function ownershipImpactFor(
  ctx: IBuildContext,
): Promise<IOwnershipImpact | null> {
  try {
    const cfg = ctx.inspection.config as { ownership?: { sources?: readonly string[] } } | null;
    const sources = cfg?.ownership?.sources;
    const { rules } = await loadOwnershipRules(ctx.inspection.projectRoot, sources);
    if (rules.length === 0) return null;
    return impactFor(ctx.files, rules);
  } catch {
    return null;
  }
}

function pathConventionsTouched(ctx: IBuildContext): string[] {
  const out = new Set<string>();
  const list = ctx.inspection.pathService.list();
  for (const p of list) {
    const meta = (p.metadata ?? {}) as { path?: string };
    const segment = (meta.path ?? p.id ?? '').replace(/\*+/g, '');
    if (!segment) continue;
    if (ctx.files.some((f) => f.includes(segment))) out.add(p.id);
  }
  return [...out].sort();
}

function classifyRisk(input: {
  directCount: number;
  transitiveCount: number;
  boundaryCount: number;
  affectedAreaCount: number;
  publicApi: boolean;
  packCount: number;
  ownershipReview: boolean;
  missingTests: boolean;
  hitsCore: boolean;
  hitsPolicy: boolean;
  hitsTemplates: boolean;
}): { risk: ImpactRisk; reasons: IImpactReason[] } {
  const reasons: IImpactReason[] = [];
  let score = 0;

  if (input.directCount === 0 && input.transitiveCount === 0) {
    reasons.push({ code: 'no-dependents', message: 'No dependents detected.' });
  }
  if (input.directCount > 5) {
    score += 10;
    reasons.push({
      code: 'many-direct-dependents',
      message: `${input.directCount} direct dependents.`,
    });
  } else if (input.directCount > 0) {
    score += 4;
    reasons.push({
      code: 'direct-dependents',
      message: `${input.directCount} direct dependents.`,
    });
  }
  if (input.transitiveCount > 25) {
    score += 18;
    reasons.push({
      code: 'large-transitive-closure',
      message: `${input.transitiveCount} transitive dependents.`,
    });
  } else if (input.transitiveCount > 10) {
    score += 10;
  }
  if (input.publicApi) {
    score += 15;
    reasons.push({
      code: 'public-api',
      message: 'Touches a public-API entry-point or re-export.',
    });
  }
  if (input.hitsCore) {
    score += 18;
    reasons.push({
      code: 'core-area',
      message: 'Touches core area.',
    });
  }
  if (input.boundaryCount > 0) {
    score += 10;
    reasons.push({
      code: 'boundary-rules',
      message: `${input.boundaryCount} boundary rule(s) potentially impacted.`,
    });
  }
  if (input.packCount > 1) {
    score += 6;
    reasons.push({
      code: 'cross-package',
      message: `Spans ${input.packCount} workspace packages.`,
    });
  }
  if (input.ownershipReview) {
    score += 8;
    reasons.push({
      code: 'ownership-review',
      message: 'Affects ownership-protected files; reviewer required.',
    });
  }
  if (input.missingTests) {
    score += 6;
    reasons.push({
      code: 'missing-tests',
      message: 'Some target files have no co-located tests.',
    });
  }
  if (input.hitsPolicy) {
    score += 10;
    reasons.push({
      code: 'policy-impact',
      message: 'Policy-engine surface or policy-governed area touched.',
    });
  }
  if (input.hitsTemplates) {
    score += 4;
    reasons.push({
      code: 'template-impact',
      message: 'Templates / pipelines reference these paths.',
    });
  }
  if (input.affectedAreaCount > 4) {
    score += 6;
    reasons.push({
      code: 'spans-areas',
      message: `Spans ${input.affectedAreaCount} repo areas.`,
    });
  }

  let risk: ImpactRisk = ImpactRisk.Low;
  if (score >= 35) risk = ImpactRisk.Critical;
  else if (score >= 22) risk = ImpactRisk.High;
  else if (score >= 10) risk = ImpactRisk.Medium;
  return { risk, reasons };
}

function findLikelyTests(projectRoot: string, files: readonly string[]): {
  existing: string[];
  missing: string[];
} {
  const existing = new Set<string>();
  const missing: string[] = [];
  for (const f of files) {
    if (/\.(spec|test)\.[jt]sx?$/.test(f)) {
      existing.add(f);
      continue;
    }
    if (!/\.(ts|tsx|js|jsx)$/.test(f)) continue;
    const candidates = [
      f.replace(/\.(ts|tsx|js|jsx)$/, '.spec.$1'),
      f.replace(/\.(ts|tsx|js|jsx)$/, '.test.$1'),
      f.replace(/^src\//, 'tests/').replace(/\.(ts|tsx|js|jsx)$/, '.spec.$1'),
      (() => {
        const parsed = nodePath.parse(f);
        return nodePath.join(parsed.dir, '__tests__', `${parsed.name}.test${parsed.ext}`);
      })(),
    ];
    let anyExists = false;
    for (const c of candidates) {
      if (existsSync(nodePath.join(projectRoot, c))) {
        existing.add(c);
        anyExists = true;
        break;
      }
    }
    if (!anyExists) missing.push(candidates[0]!);
  }
  return { existing: [...existing].sort(), missing };
}

export async function analyzeImpact(
  inspection: ISharkcraftInspection,
  input: IImpactAnalysisInput,
): Promise<IImpactAnalysis> {
  const maxDepth = input.maxDepth ?? DEFAULT_MAX_DEPTH;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const inputKind = inferInputKind(input);
  const areaMap = input.areaMap ?? buildAreaMap(inspection);

  const explicitFiles = (input.files ?? []).map((f) => normalizeRel(inspection.projectRoot, f));
  const planTargets = (input.planTargets ?? []).map((f) =>
    normalizeRel(inspection.projectRoot, f),
  );
  const reverse = buildReverseGraph(inspection.projectRoot);

  // Resolve specifier to a candidate file set, if applicable.
  let specifierTargets: string[] = [];
  if (input.specifier) {
    specifierTargets = matchTargetsBySpecifier(input.specifier, reverse.aliasMap)
      .filter((f) => existsSync(nodePath.join(inspection.projectRoot, f)))
      .map((f) => normalizeRel(inspection.projectRoot, f));
  }

  const files = unique([...explicitFiles, ...planTargets, ...specifierTargets]);
  const task = (input.task ?? '').trim() || files.join(' ') || (input.specifier ?? '');

  const ctx: IBuildContext = {
    inspection,
    files,
    inputKind,
    task,
    ...(input.specifier ? { specifier: input.specifier } : {}),
    maxDepth,
    limit,
    areaMap,
  };

  const { direct, transitive, paths } = closeDependents(reverse, files, maxDepth);
  const directDependents = direct.slice(0, limit);
  const transitiveDependents = transitive.slice(0, limit);

  // Expand context with dependents for area / boundary / policy computation.
  const expandedFiles = unique([...files, ...directDependents.slice(0, 50), ...transitiveDependents.slice(0, 50)]);
  const expandedCtx: IBuildContext = { ...ctx, files: expandedFiles };
  const affectedAreas = affectedAreaSummary(expandedCtx);
  const affectedPackages = detectWorkspaces(expandedCtx);
  const pathConventions = pathConventionsTouched(expandedCtx);
  const boundaryConcerns = boundaryRisks(expandedCtx, affectedAreas);
  const policyConcerns = affectedPolicies(expandedCtx, affectedAreas, boundaryConcerns);
  const ownership = await ownershipImpactFor(expandedCtx);
  const templates = affectedTemplates(expandedCtx);
  const pipelines = affectedPipelines(expandedCtx);
  const presets = affectedPresets(expandedCtx);
  const constructs = affectedConstructs(expandedCtx);

  const { existing: likelyTests, missing: missingTests } = findLikelyTests(
    inspection.projectRoot,
    files,
  );
  // Reverse-import graph: any dependent that is itself a test file genuinely
  // exercises the changed file — including cross-directory tests the filename
  // conventions miss (e.g. src/__tests__/foo.test.ts importing src/sub/foo.ts).
  // So the agent's `tests impact` / `impact` returns the exact minimal set to
  // run instead of falling back to the whole suite.
  const TEST_FILE_RE = /\.(spec|test)\.[jt]sx?$/;
  const dependentTests = unique(
    [...directDependents, ...transitiveDependents].filter((f) => TEST_FILE_RE.test(f)),
  );
  const minimalTests = unique([...likelyTests, ...dependentTests]);

  // Per-target test suggestion (minimal commands).
  const suggestedTestCommands = unique([
    ...(minimalTests.length > 0 ? [`bun test ${minimalTests.slice(0, 12).join(' ')}`] : []),
    'bun test',
  ]);

  const suggestedFullTestCommands = unique([
    'bun test',
    'bun x tsc -p tsconfig.base.json --noEmit',
  ]);

  const suggestedValidationCommands = unique([
    'shrk check boundaries',
    'shrk policy run',
    'bun x tsc -p tsconfig.base.json --noEmit',
    'bun test',
  ]);

  const suggestedReviewCommands = unique([
    'shrk review packet --v3',
    'shrk impact ' + files.slice(0, 3).join(','),
    'shrk owners impact --files ' + files.slice(0, 3).join(','),
  ]);

  const ranking = rankAll(inspection, task || files.join(' '), 6);
  const relatedRules = ranking.rules.slice(0, 5).map((r) => ({
    id: r.item.id,
    title: r.item.title,
  }));
  const relatedTemplates = ranking.templates.slice(0, 5).map((t) => ({
    id: t.item.id,
    name: t.item.name,
  }));

  const publicApi = files.some(
    (f) =>
      f.endsWith('/index.ts') ||
      f.endsWith('main.ts') ||
      f.includes('public-api/'),
  );
  const hitsCore = affectedAreas.some(
    (a) => a.kind === AreaKind.Core,
  );
  const hitsPolicy = files.some((f) => f.includes('policy') || f.includes('policy-engine'));
  const hitsTemplates = templates.length > 0 || pipelines.length > 0;
  const ownershipReview = (ownership?.requiredReviewFiles.length ?? 0) > 0;

  const { risk, reasons: riskReasons } = classifyRisk({
    directCount: direct.length,
    transitiveCount: transitive.length,
    boundaryCount: boundaryConcerns.length,
    affectedAreaCount: affectedAreas.length,
    publicApi,
    packCount: affectedPackages.length,
    ownershipReview,
    missingTests: missingTests.length > 0,
    hitsCore,
    hitsPolicy,
    hitsTemplates,
  });

  const truncations: IImpactTruncation[] = [];
  if (direct.length > limit) {
    truncations.push({ list: 'directDependents', total: direct.length, shown: limit });
  }
  if (transitive.length > limit) {
    truncations.push({
      list: 'transitiveDependents',
      total: transitive.length,
      shown: limit,
    });
  }
  if (paths.length > 25) {
    truncations.push({ list: 'dependencyPathExamples', total: paths.length, shown: 25 });
  }

  const explanation = buildExplanation(
    risk,
    direct.length,
    transitive.length,
    boundaryConcerns.length,
    affectedAreas.length,
  );

  const diagnostics: string[] = [];
  if (reverse.edgeCount === 0) {
    diagnostics.push('Import-graph scan returned no edges — reverse closure unavailable.');
  }
  if (files.length === 0) {
    diagnostics.push('No target files derived from input.');
  }

  const result: IImpactAnalysis = {
    schema: IMPACT_ANALYSIS_SCHEMA,
    task,
    inputKind,
    normalizedTargets: files,
    affectedFiles: files,
    directDependents,
    transitiveDependents,
    dependencyPathExamples: paths.slice(0, 25),
    affectedAreas,
    affectedPackages,
    affectedPathConventions: pathConventions,
    potentialBoundaryRisks: boundaryConcerns,
    affectedPolicies: policyConcerns,
    affectedOwnership: ownership,
    affectedTemplates: templates,
    affectedPipelines: pipelines,
    affectedPresets: presets,
    affectedConstructs: constructs,
    likelyTests: minimalTests,
    suggestedTestCommands,
    suggestedFullTestCommands,
    suggestedValidationCommands,
    suggestedReviewCommands,
    relatedRules,
    relatedTemplates,
    risk,
    riskReasons,
    explanation,
    truncations,
    diagnostics,
  };
  if (input.specifier) {
    result.specifier = input.specifier;
  }
  return result;
}

function buildExplanation(
  risk: ImpactRisk,
  directCount: number,
  transitiveCount: number,
  boundaryCount: number,
  areaCount: number,
): string {
  return [
    `Risk: ${risk}.`,
    `${directCount} direct + ${transitiveCount} transitive dependent(s);`,
    `${areaCount} area(s); ${boundaryCount} boundary rule(s).`,
  ].join(' ');
}
