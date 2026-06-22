/**
 * Plan simulation v2.
 *
 * Loads a saved generation plan (v1 or v2), reconstructs the virtual
 * post-apply file state (best-effort), classifies each operation's outcome,
 * and reports apply readiness, boundary impact, policy impact, ownership
 * review, public-API touch, likely tests, required validations, and
 * affected constructs/playbooks.
 *
 * Read-only. No source writes.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  evaluateBoundaries,
  loadTsconfigPaths,
  scanImports,
} from '@shrkcrft/boundaries';
import {
  planGeneration,
  verifyPlan,
  type IFileChange,
  type ISavedPlan,
} from '@shrkcrft/generator';
import { reviewSavedPlan, type IPlanReviewReport } from './plan-review.ts';
import { loadOwnershipRules, impactFor as ownershipImpactFor } from './ownership.ts';
import { listConstructs, loadConstructs } from './construct-registry.ts';
import { listPlaybooks, recommendPlaybooks } from './playbook-registry.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const PLAN_SIMULATION_SCHEMA = 'sharkcraft.plan-simulation/v1';

export enum PlanSimulationOperationOutcome {
  Ready = 'ready',
  SkipIdempotent = 'skip-idempotent',
  Conflict = 'conflict',
  ModifiesExisting = 'modifies-existing',
  CreatesNew = 'creates-new',
}

export enum PlanApplyReadiness {
  Ready = 'ready',
  ReadyWithReview = 'ready-with-review',
  BlockedConflicts = 'blocked-conflicts',
  BlockedPolicy = 'blocked-policy',
  BlockedBoundary = 'blocked-boundary',
  BlockedSignature = 'blocked-signature',
  BlockedMissingReview = 'blocked-missing-review',
}

export interface IPlanSimulationFile {
  relativePath: string;
  changeType: string;
  outcome: PlanSimulationOperationOutcome;
  reason?: string;
  sizeBytes: number;
  /** Best-effort: full virtual contents after the operation. Absent when
   * the simulator couldn't reconstruct them (signature-only plans, or
   * templates that don't load). */
  finalContents?: string;
  /** Hash markers used to detect public-API / barrel touches without
   * re-reading every file. */
  touchesPublicApi: boolean;
  touchesBarrelExport: boolean;
  touchesPluginKeys: boolean;
  touchesEventRegistry: boolean;
  touchesTokenRegistry: boolean;
  touchesAdapter: boolean;
  /** Line counts before/after the operation. */
  beforeLineCount?: number;
  afterLineCount?: number;
  /** Unified diff preview (best-effort; truncated). */
  diffPreview?: string;
  /** True if diffPreview was truncated. */
  diffTruncated?: boolean;
  /** Operation-specific human-readable detail. */
  operationDetail?: string;
}

export interface IPlanSimulationBoundaryHit {
  file: string;
  ruleId: string;
  importSpecifier: string;
  line: number;
  severity: string;
  message: string;
}

export interface IPlanSimulationReport {
  schema: typeof PLAN_SIMULATION_SCHEMA;
  generatedAt: string;
  source: string;
  templateId?: string;
  planSchema: string;
  signature: 'absent' | 'present' | 'invalid';
  signatureMessage?: string;
  files: readonly IPlanSimulationFile[];
  affectedAreas: readonly string[];
  affectedPathConventions: readonly string[];
  publicApiTouched: boolean;
  barrelExportTouched: boolean;
  pluginKeysTouched: boolean;
  eventRegistryTouched: boolean;
  tokenRegistryTouched: boolean;
  adapterBoundaryTouched: boolean;
  policyOwnedAreaTouched: boolean;
  ownershipReviewRequired: boolean;
  ownershipReviewFiles: readonly string[];
  likelyTests: readonly string[];
  requiredValidations: readonly string[];
  affectedConstructs: readonly string[];
  affectedPlaybooks: readonly string[];
  potentialBoundaryConcerns: readonly IPlanSimulationBoundaryHit[];
  planIntroducedBoundaryConcerns: readonly IPlanSimulationBoundaryHit[];
  policyConcerns: readonly string[];
  applyReadiness: PlanApplyReadiness;
  applyReadinessReasons: readonly string[];
  humanApprovalReminder: string;
  memoryHints: readonly string[];
  reviewPacket?: IPlanReviewReport;
  limitations: readonly string[];
}

export interface IPlanSimulationOptions {
  /** strict: any boundary error or conflict is enough to block. */
  strict?: boolean;
  includeBoundaries?: boolean;
  includeImpact?: boolean;
  includeTests?: boolean;
  includePolicies?: boolean;
  includeOwnership?: boolean;
  includeMemory?: boolean;
  /** Compute unified diff previews for each file. */
  diff?: boolean;
  /** Maximum lines per diff preview (default 80). */
  maxDiffLines?: number;
}

function readExistingFile(projectRoot: string, relativePath: string): string | null {
  try {
    const abs = nodePath.resolve(projectRoot, relativePath);
    if (!existsSync(abs)) return null;
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Minimal unified-diff renderer for two strings. Not a full LCS — uses a
 * simple longest-common-subsequence on lines via dynamic programming with
 * a guard against huge inputs. For huge inputs falls back to a summary.
 */
export function unifiedDiff(beforeText: string, afterText: string, opts: { context?: number; maxLines?: number; relativePath: string }): { body: string; truncated: boolean } {
  const context = opts.context ?? 3;
  const maxLines = opts.maxLines ?? 80;
  const before = beforeText.split('\n');
  const after = afterText.split('\n');
  // Bail out if either side is huge — emit a summary line instead.
  const LIMIT = 4000;
  if (before.length > LIMIT || after.length > LIMIT) {
    return {
      body: `--- a/${opts.relativePath}\n+++ b/${opts.relativePath}\n@@ summary @@\n- ${before.length} line(s)\n+ ${after.length} line(s)\n(diff omitted — file too large for inline preview)\n`,
      truncated: true,
    };
  }
  // LCS table
  const n = before.length;
  const m = after.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = before[i] === after[j] ? (dp[i + 1]![j + 1] ?? 0) + 1 : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
    }
  }
  // Walk to build edit script
  type Edit = { op: '=' | '-' | '+'; line: string };
  const edits: Edit[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      edits.push({ op: '=', line: before[i]! });
      i += 1;
      j += 1;
    } else if ((dp[i + 1]![j] ?? 0) >= (dp[i]![j + 1] ?? 0)) {
      edits.push({ op: '-', line: before[i]! });
      i += 1;
    } else {
      edits.push({ op: '+', line: after[j]! });
      j += 1;
    }
  }
  while (i < n) edits.push({ op: '-', line: before[i++]! });
  while (j < m) edits.push({ op: '+', line: after[j++]! });

  // Group into hunks with context lines.
  const lines: string[] = [];
  lines.push(`--- a/${opts.relativePath}`);
  lines.push(`+++ b/${opts.relativePath}`);
  let pos = 0;
  let aPos = 1;
  let bPos = 1;
  while (pos < edits.length) {
    // skip leading equals
    while (pos < edits.length && edits[pos]!.op === '=') {
      pos += 1;
      aPos += 1;
      bPos += 1;
    }
    if (pos >= edits.length) break;
    const hunkStart = Math.max(0, pos - context);
    // Find end of hunk — extend until we see `context` consecutive '=' lines
    let end = pos;
    let runEq = 0;
    while (end < edits.length && runEq < context * 2) {
      if (edits[end]!.op === '=') runEq += 1;
      else runEq = 0;
      end += 1;
    }
    const hunkEnd = Math.min(edits.length, end + context);
    // Compute hunk header (1-based line numbers)
    let aStart = aPos;
    let bStart = bPos;
    for (let k = hunkStart; k < pos; k += 1) {
      if (edits[k]!.op !== '+') aStart -= 1;
      if (edits[k]!.op !== '-') bStart -= 1;
    }
    let aCount = 0;
    let bCount = 0;
    for (let k = hunkStart; k < hunkEnd; k += 1) {
      const o = edits[k]!.op;
      if (o === '=' || o === '-') aCount += 1;
      if (o === '=' || o === '+') bCount += 1;
    }
    lines.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (let k = hunkStart; k < hunkEnd; k += 1) {
      const e = edits[k]!;
      lines.push((e.op === '=' ? ' ' : e.op) + e.line);
      if (e.op !== '+') aPos += 1;
      if (e.op !== '-') bPos += 1;
    }
    pos = hunkEnd;
  }
  // Truncate.
  let truncated = false;
  if (lines.length > maxLines + 2) {
    const head = lines.slice(0, maxLines + 2);
    head.push(`… (${lines.length - maxLines - 2} more line(s) omitted) …`);
    truncated = true;
    return { body: head.join('\n') + '\n', truncated };
  }
  return { body: lines.join('\n') + '\n', truncated };
}

function operationExplain(c: { type: string; reason?: string }): string | undefined {
  switch (c.type) {
    case 'append':
      return c.reason?.includes('already present') ? 'append marker found (idempotent skip)' : 'append snippet will be added at end-of-file';
    case 'insert-after':
      return c.reason?.includes('anchor not found')
        ? 'insert-after: anchor missing'
        : c.reason?.includes('multiple sites')
          ? 'insert-after: anchor is ambiguous (multiple matches)'
          : 'insert-after: anchor found exactly once';
    case 'insert-before':
      return c.reason?.includes('anchor not found')
        ? 'insert-before: anchor missing'
        : c.reason?.includes('multiple sites')
          ? 'insert-before: anchor is ambiguous (multiple matches)'
          : 'insert-before: anchor found exactly once';
    case 'replace':
      return c.reason?.includes('already applied')
        ? 'replace: already applied (idempotent)'
        : c.reason?.includes('expected')
          ? 'replace: match-count mismatch'
          : c.reason?.includes('not found')
            ? 'replace: find text not found'
            : 'replace: 1 match found';
    case 'export':
      return c.reason?.includes('already present')
        ? 'export: already present in barrel'
        : c.reason?.includes('does not exist')
          ? 'export: barrel file missing'
          : 'export: will append new export line';
    case 'create':
      return c.reason?.includes('identical')
        ? 'create: identical existing file (skip)'
        : c.reason?.includes('overwrite')
          ? 'create: conflict — file already exists'
          : 'create: new file';
    default:
      return undefined;
  }
}

function isPublicApiPath(p: string): boolean {
  return p.endsWith('/index.ts') || p.includes('plugin-api/') || p.includes('public-api/');
}

function isBarrelExportPath(p: string): boolean {
  return p.endsWith('/index.ts') || p.endsWith('index.tsx');
}

function isAdapterPath(p: string): boolean {
  return p.includes('/adapters/') || p.includes('adapter');
}

function detectMarker(contents: string | undefined, markers: readonly string[]): boolean {
  if (!contents) return false;
  return markers.some((m) => contents.includes(m));
}

function outcomeFor(type: string): PlanSimulationOperationOutcome {
  switch (type) {
    case 'skip':
      return PlanSimulationOperationOutcome.SkipIdempotent;
    case 'conflict':
      return PlanSimulationOperationOutcome.Conflict;
    case 'create':
      return PlanSimulationOperationOutcome.CreatesNew;
    case 'update':
    case 'append':
    case 'insert-after':
    case 'insert-before':
    case 'replace':
    case 'export':
      return PlanSimulationOperationOutcome.ModifiesExisting;
    default:
      return PlanSimulationOperationOutcome.Ready;
  }
}

function collectPlannedEdges(
  changes: readonly IFileChange[],
): { from: string; importSpecifier: string; line: number; kind: 'internal' | 'external' }[] {
  const edges: { from: string; importSpecifier: string; line: number; kind: 'internal' | 'external' }[] = [];
  const REGEXES = [
    /(?:^|\s)(?:import|export)\s+[^'"`]*?from\s+['"]([^'"`]+)['"]/g,
    /(?:^|\s)import\s+['"]([^'"`]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"`]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"`]+)['"]\s*\)/g,
  ];
  for (const c of changes) {
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(c.relativePath)) continue;
    if (!c.contents || c.contents.length === 0) continue;
    const source = c.contents;
    for (const re of REGEXES) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null) {
        const line = source.slice(0, m.index).split('\n').length;
        edges.push({
          from: c.relativePath,
          importSpecifier: m[1]!,
          line,
          kind: m[1]!.startsWith('.') ? 'internal' : 'external',
        });
      }
    }
  }
  return edges;
}

export async function simulatePlan(
  inspection: ISharkcraftInspection,
  planPath: string,
  options: IPlanSimulationOptions = {},
): Promise<IPlanSimulationReport> {
  const limitations: string[] = [];
  const raw = readFileSync(planPath, 'utf8');
  const plan = JSON.parse(raw) as ISavedPlan;
  const planSchema = String(plan.schema ?? 'unknown');

  // Reuse the existing plan review for signature/boundary/path heuristics.
  let review: IPlanReviewReport | undefined;
  try {
    review = reviewSavedPlan(inspection, planPath);
  } catch (e) {
    limitations.push(`Plan review failed: ${(e as Error).message}`);
  }

  // Re-render the template to recover virtual contents (when available).
  let liveChanges: readonly IFileChange[] = [];
  if (plan.templateId) {
    const template = inspection.templateRegistry.get(plan.templateId);
    if (template) {
      try {
        const dry = planGeneration(template, {
          templateId: plan.templateId,
          ...(plan.name ? { name: plan.name } : {}),
          variables: plan.variables ?? {},
          projectRoot: inspection.projectRoot,
        });
        liveChanges = dry.plan.changes;
      } catch (e) {
        limitations.push(`Template re-render failed: ${(e as Error).message}`);
      }
    } else {
      limitations.push(
        `Template "${plan.templateId}" not found in the live registry — virtual contents not reconstructed.`,
      );
    }
  } else {
    limitations.push('Plan has no templateId — virtual contents not reconstructed.');
  }

  const expected = plan.expectedChanges ?? [];
  const sourceList: { type: string; relativePath: string; sizeBytes: number; contents?: string; reason?: string }[] =
    liveChanges.length > 0
      ? liveChanges.map((c) => ({
          type: String(c.type),
          relativePath: c.relativePath,
          sizeBytes: c.sizeBytes,
          contents: c.contents,
          reason: c.reason,
        }))
      : expected.map((c) => ({
          type: String(c.type),
          relativePath: c.relativePath,
          sizeBytes: Number(c.sizeBytes ?? 0),
        }));

  // Marker-driven detection. Generic naming conventions for common
  // pack-owned regions; the engine ships only these defaults.
  const KEY_TABLE_MARKERS = ['Keys', 'keys'];
  const EVENT_REGISTRY_MARKERS = ['EventRegistry', 'EVENTS', 'eventRegistry', 'events.ts'];
  const TOKEN_REGISTRY_MARKERS = ['TokenRegistry', 'TOKENS', 'tokenRegistry', 'tokens.ts'];

  const maxDiffLines = options.maxDiffLines ?? 80;
  const wantDiff = options.diff === true;
  const files: IPlanSimulationFile[] = sourceList.map((c) => {
    const tpa = isPublicApiPath(c.relativePath);
    const tbe = isBarrelExportPath(c.relativePath);
    const tad = isAdapterPath(c.relativePath);
    const tpk = detectMarker(c.contents, KEY_TABLE_MARKERS) || /plugin[-_]?keys?/i.test(c.relativePath);
    const ter = detectMarker(c.contents, EVENT_REGISTRY_MARKERS) || /events?\.(ts|tsx)$/.test(c.relativePath);
    const ttr = detectMarker(c.contents, TOKEN_REGISTRY_MARKERS) || /tokens?\.(ts|tsx)$/.test(c.relativePath);
    const out: IPlanSimulationFile = {
      relativePath: c.relativePath,
      changeType: c.type,
      outcome: outcomeFor(c.type),
      sizeBytes: c.sizeBytes,
      touchesPublicApi: tpa,
      touchesBarrelExport: tbe,
      touchesPluginKeys: tpk,
      touchesEventRegistry: ter,
      touchesTokenRegistry: ttr,
      touchesAdapter: tad,
    };
    if (c.reason !== undefined) out.reason = c.reason;
    if (c.contents !== undefined) out.finalContents = c.contents;
    const explain = operationExplain({ type: c.type, ...(c.reason ? { reason: c.reason } : {}) });
    if (explain) out.operationDetail = explain;
    // Compute before/after line counts and diff when we have virtual content.
    if (c.contents !== undefined) {
      const existing = readExistingFile(inspection.projectRoot, c.relativePath);
      const beforeText = existing ?? '';
      const afterText = c.contents;
      out.beforeLineCount = existing === null ? 0 : beforeText.split('\n').length;
      out.afterLineCount = afterText.split('\n').length;
      if (wantDiff && c.type !== 'conflict' && c.type !== 'skip') {
        const diff = unifiedDiff(beforeText, afterText, {
          maxLines: maxDiffLines,
          relativePath: c.relativePath,
        });
        out.diffPreview = diff.body;
        if (diff.truncated) out.diffTruncated = true;
      }
    }
    return out;
  });

  const publicApiTouched = files.some((f) => f.touchesPublicApi);
  const barrelExportTouched = files.some((f) => f.touchesBarrelExport);
  const pluginKeysTouched = files.some((f) => f.touchesPluginKeys);
  const eventRegistryTouched = files.some((f) => f.touchesEventRegistry);
  const tokenRegistryTouched = files.some((f) => f.touchesTokenRegistry);
  const adapterBoundaryTouched = files.some((f) => f.touchesAdapter);

  // Signature
  let signature: IPlanSimulationReport['signature'] = 'absent';
  let signatureMessage: string | undefined;
  if (plan.signature) {
    signature = 'present';
    const v = verifyPlan(plan);
    if (!v.ok) {
      signature = 'invalid';
      signatureMessage = v.message;
    } else {
      signatureMessage = 'verified';
    }
  }

  // Boundary impact — current state on planned paths.
  const potentialBoundaryConcerns: IPlanSimulationBoundaryHit[] = [];
  const planIntroducedBoundaryConcerns: IPlanSimulationBoundaryHit[] = [];
  if (options.includeBoundaries !== false && inspection.boundaryRegistry.size() > 0 && files.length > 0) {
    const tsconfigPaths = loadTsconfigPaths(inspection.projectRoot);
    const aliasOpts = tsconfigPaths.aliases.size > 0 ? { tsconfigPaths } : {};
    try {
      const scan = scanImports({ projectRoot: inspection.projectRoot });
      const evalResult = evaluateBoundaries(scan, inspection.boundaryRegistry.list(), aliasOpts);
      const targetSet = new Set(files.map((f) => f.relativePath));
      for (const v of evalResult.violations) {
        if (!targetSet.has(v.file)) continue;
        potentialBoundaryConcerns.push({
          file: v.file,
          ruleId: v.ruleId,
          importSpecifier: v.importSpecifier,
          line: v.line,
          severity: v.severity,
          message: v.message,
        });
      }
    } catch (e) {
      limitations.push(`Boundary scan failed: ${(e as Error).message}`);
    }
    if (liveChanges.length > 0) {
      try {
        const plannedEdges = collectPlannedEdges(liveChanges);
        const evalResult = evaluateBoundaries(
          { filesScanned: liveChanges.length, edges: plannedEdges, warnings: [] },
          inspection.boundaryRegistry.list(),
          aliasOpts,
        );
        for (const v of evalResult.violations) {
          planIntroducedBoundaryConcerns.push({
            file: v.file,
            ruleId: v.ruleId,
            importSpecifier: v.importSpecifier,
            line: v.line,
            severity: v.severity,
            message: v.message,
          });
        }
      } catch (e) {
        limitations.push(`Planned-content boundary scan failed: ${(e as Error).message}`);
      }
    } else {
      limitations.push(
        'Virtual file contents unavailable — planned-content boundary scan skipped.',
      );
    }
  }

  // Ownership review.
  const ownershipReviewFiles: string[] = [];
  let ownershipReviewRequired = false;
  if (options.includeOwnership !== false) {
    try {
      const own = await loadOwnershipRules(inspection.projectRoot);
      const rules = own.rules;
      if (rules.length > 0) {
        const impact = ownershipImpactFor(files.map((f) => f.relativePath), rules);
        ownershipReviewRequired = impact.requiredReviewFiles.length > 0;
        for (const f of impact.requiredReviewFiles) ownershipReviewFiles.push(f);
      }
    } catch (e) {
      limitations.push(`Ownership impact failed: ${(e as Error).message}`);
    }
  }

  // Policy concerns (lightweight): we surface boundary errors as policy-relevant.
  const policyConcerns: string[] = [];
  if (options.includePolicies !== false) {
    for (const v of planIntroducedBoundaryConcerns.concat(potentialBoundaryConcerns)) {
      if (v.severity === 'error') policyConcerns.push(`${v.ruleId} (${v.file})`);
    }
  }
  const policyOwnedAreaTouched = policyConcerns.length > 0;

  // Likely tests.
  const likelyTests: string[] = [];
  if (options.includeTests !== false) {
    const allPaths = new Set(files.map((f) => f.relativePath));
    for (const f of files) {
      if (!/\.(ts|tsx)$/.test(f.relativePath)) continue;
      if (f.relativePath.includes('/tests/') || f.relativePath.endsWith('.spec.ts')) continue;
      if (!f.relativePath.startsWith('src/') && !f.relativePath.startsWith('packages/')) continue;
      const candidate = f.relativePath
        .replace(/^src\//, 'tests/')
        .replace(/\.tsx?$/, '.spec.ts');
      if (!allPaths.has(candidate)) likelyTests.push(`${f.relativePath} → expected ${candidate}`);
    }
  }

  // Required validations.
  const requiredValidations = new Set<string>([
    'bun x tsc -p tsconfig.base.json --noEmit',
    'bun test',
    'shrk doctor',
    'shrk check boundaries',
  ]);
  if (publicApiTouched || barrelExportTouched) requiredValidations.add('shrk api report --all --public-only');
  if (pluginKeysTouched) requiredValidations.add('shrk packs doctor --release');
  if (adapterBoundaryTouched) requiredValidations.add('shrk architecture violations');
  if (potentialBoundaryConcerns.length > 0 || planIntroducedBoundaryConcerns.length > 0) {
    requiredValidations.add('shrk architecture violations');
  }

  // Affected constructs / playbooks (lightweight).
  await loadConstructs(inspection);
  const constructList = listConstructs(inspection) ?? [];
  const affectedConstructs: string[] = [];
  for (const c of constructList) {
    if (files.some((f) => f.relativePath.toLowerCase().includes(c.id.toLowerCase()))) {
      affectedConstructs.push(c.id);
    }
  }
  const playbooks = await listPlaybooks(inspection);
  const playbookHints = recommendPlaybooks(playbooks, plan.templateId ?? plan.name ?? planPath)
    .slice(0, 5)
    .map((p) => p.playbook.id);

  // Apply readiness.
  const reasons: string[] = [];
  let readiness: PlanApplyReadiness;
  if (signature === 'invalid') {
    readiness = PlanApplyReadiness.BlockedSignature;
    reasons.push(`Signature invalid: ${signatureMessage ?? 'verification failed'}.`);
  } else if (files.some((f) => f.outcome === PlanSimulationOperationOutcome.Conflict)) {
    readiness = PlanApplyReadiness.BlockedConflicts;
    reasons.push('At least one operation is a conflict.');
  } else if (planIntroducedBoundaryConcerns.some((v) => v.severity === 'error')) {
    readiness = PlanApplyReadiness.BlockedBoundary;
    reasons.push('Plan introduces a boundary error.');
  } else if (policyConcerns.length > 0 && options.strict === true) {
    readiness = PlanApplyReadiness.BlockedPolicy;
    reasons.push('Policy concerns and --strict requested.');
  } else if (ownershipReviewRequired || publicApiTouched) {
    readiness = PlanApplyReadiness.ReadyWithReview;
    if (ownershipReviewRequired) reasons.push('Ownership-protected files touched.');
    if (publicApiTouched) reasons.push('Public API touched — API review required.');
  } else if (signature === 'absent' && options.strict === true) {
    readiness = PlanApplyReadiness.BlockedMissingReview;
    reasons.push('Plan unsigned and --strict requested.');
  } else {
    readiness = PlanApplyReadiness.Ready;
  }

  const memoryHints: string[] = [];
  if (options.includeMemory) {
    memoryHints.push('Memory index (if built) can highlight historically risky files in this plan.');
  }

  return {
    schema: PLAN_SIMULATION_SCHEMA,
    generatedAt: new Date().toISOString(),
    source: planPath,
    ...(plan.templateId ? { templateId: plan.templateId } : {}),
    planSchema,
    signature,
    ...(signatureMessage ? { signatureMessage } : {}),
    files,
    affectedAreas: [],
    affectedPathConventions: review?.affectedPaths ?? [],
    publicApiTouched,
    barrelExportTouched,
    pluginKeysTouched,
    eventRegistryTouched,
    tokenRegistryTouched,
    adapterBoundaryTouched,
    policyOwnedAreaTouched,
    ownershipReviewRequired,
    ownershipReviewFiles,
    likelyTests,
    requiredValidations: [...requiredValidations],
    affectedConstructs,
    affectedPlaybooks: playbookHints,
    potentialBoundaryConcerns,
    planIntroducedBoundaryConcerns,
    policyConcerns,
    applyReadiness: readiness,
    applyReadinessReasons: reasons,
    humanApprovalReminder:
      'MCP never writes. A human must run `shrk apply <plan> --verify-signature` after reviewing this simulation.',
    memoryHints,
    ...(review ? { reviewPacket: review } : {}),
    limitations,
  };
}

function listLines(title: string, items: readonly string[]): string {
  if (items.length === 0) return '';
  return `${title}:\n${items.map((i) => `  • ${i}`).join('\n')}\n\n`;
}

export function renderPlanSimulationText(r: IPlanSimulationReport): string {
  let out = `=== Plan simulation ===\n`;
  out += `  source        ${r.source}\n`;
  if (r.templateId) out += `  template      ${r.templateId}\n`;
  out += `  plan schema   ${r.planSchema}\n`;
  out += `  signature     ${r.signature}${r.signatureMessage ? ' — ' + r.signatureMessage : ''}\n`;
  out += `  readiness     ${r.applyReadiness}\n`;
  out += `  files         ${r.files.length}\n\n`;
  if (r.files.length > 0) {
    out += `Files:\n`;
    for (const f of r.files) {
      const flags: string[] = [];
      if (f.touchesPublicApi) flags.push('public-api');
      if (f.touchesBarrelExport) flags.push('barrel');
      if (f.touchesPluginKeys) flags.push('plugin-keys');
      if (f.touchesEventRegistry) flags.push('events');
      if (f.touchesTokenRegistry) flags.push('tokens');
      if (f.touchesAdapter) flags.push('adapter');
      const counts =
        f.beforeLineCount !== undefined && f.afterLineCount !== undefined
          ? `  (${f.beforeLineCount}→${f.afterLineCount} lines)`
          : '';
      out += `  [${f.outcome.padEnd(18)}] ${f.changeType.padEnd(14)} ${f.relativePath}${flags.length ? ' (' + flags.join(', ') + ')' : ''}${counts}\n`;
      if (f.operationDetail) out += `      • ${f.operationDetail}\n`;
      if (f.diffPreview) {
        for (const line of f.diffPreview.split('\n')) {
          if (!line) continue;
          out += `      ${line}\n`;
        }
        if (f.diffTruncated) out += `      … (diff truncated; raise --max-diff-lines)\n`;
      }
    }
    out += `\n`;
  }
  if (r.applyReadinessReasons.length) out += listLines('Readiness reasons', r.applyReadinessReasons);
  if (r.potentialBoundaryConcerns.length) {
    out += `Existing boundary concerns:\n`;
    for (const v of r.potentialBoundaryConcerns)
      out += `  ${v.severity.toUpperCase().padEnd(8)} ${v.file}:${v.line}  ${v.importSpecifier}  (${v.ruleId})\n`;
    out += `\n`;
  }
  if (r.planIntroducedBoundaryConcerns.length) {
    out += `Plan-introduced boundary concerns:\n`;
    for (const v of r.planIntroducedBoundaryConcerns)
      out += `  ${v.severity.toUpperCase().padEnd(8)} ${v.file}:${v.line}  ${v.importSpecifier}  (${v.ruleId})\n`;
    out += `\n`;
  }
  if (r.ownershipReviewFiles.length) out += listLines('Ownership review files', r.ownershipReviewFiles);
  if (r.likelyTests.length) out += listLines('Likely tests', r.likelyTests);
  if (r.requiredValidations.length) out += listLines('Required validations', r.requiredValidations);
  if (r.affectedConstructs.length) out += listLines('Affected constructs', r.affectedConstructs);
  if (r.affectedPlaybooks.length) out += listLines('Recommended playbooks', r.affectedPlaybooks);
  if (r.policyConcerns.length) out += listLines('Policy concerns', r.policyConcerns);
  if (r.limitations.length) out += listLines('Limitations', r.limitations);
  out += `\n${r.humanApprovalReminder}\n`;
  return out;
}

function mdList(title: string, items: readonly string[]): string {
  if (items.length === 0) return '';
  return `## ${title}\n${items.map((i) => `- ${i}`).join('\n')}\n\n`;
}

export function renderPlanSimulationMarkdown(r: IPlanSimulationReport): string {
  let out = `# Plan simulation\n\n`;
  out += `- **source**: ${r.source}\n`;
  if (r.templateId) out += `- **template**: ${r.templateId}\n`;
  out += `- **plan schema**: ${r.planSchema}\n`;
  out += `- **signature**: ${r.signature}${r.signatureMessage ? ' — ' + r.signatureMessage : ''}\n`;
  out += `- **readiness**: ${r.applyReadiness}\n`;
  out += `- **generated**: ${r.generatedAt}\n\n`;
  if (r.files.length > 0) {
    out += `## Files\n\n`;
    out += `| Outcome | Change | Path | Lines | Flags | Detail |\n| --- | --- | --- | --- | --- | --- |\n`;
    for (const f of r.files) {
      const flags: string[] = [];
      if (f.touchesPublicApi) flags.push('public-api');
      if (f.touchesBarrelExport) flags.push('barrel');
      if (f.touchesPluginKeys) flags.push('plugin-keys');
      if (f.touchesEventRegistry) flags.push('events');
      if (f.touchesTokenRegistry) flags.push('tokens');
      if (f.touchesAdapter) flags.push('adapter');
      const counts =
        f.beforeLineCount !== undefined && f.afterLineCount !== undefined
          ? `${f.beforeLineCount}→${f.afterLineCount}`
          : '—';
      out += `| ${f.outcome} | ${f.changeType} | \`${f.relativePath}\` | ${counts} | ${flags.join(', ') || '—'} | ${f.operationDetail ?? ''} |\n`;
    }
    out += `\n`;
    // Diff blocks
    const diffs = r.files.filter((f) => f.diffPreview);
    if (diffs.length > 0) {
      out += `## Diff previews\n\n`;
      for (const f of diffs) {
        out += `### \`${f.relativePath}\`\n\n`;
        out += '```diff\n' + f.diffPreview + '```\n';
        if (f.diffTruncated) out += `_diff truncated — raise \`--max-diff-lines\`._\n`;
        out += '\n';
      }
    }
  }
  out += mdList('Readiness reasons', r.applyReadinessReasons);
  out += mdList('Existing boundary concerns', r.potentialBoundaryConcerns.map((v) => `${v.severity.toUpperCase()} ${v.file}:${v.line} ${v.importSpecifier} (${v.ruleId})`));
  out += mdList('Plan-introduced boundary concerns', r.planIntroducedBoundaryConcerns.map((v) => `${v.severity.toUpperCase()} ${v.file}:${v.line} ${v.importSpecifier} (${v.ruleId})`));
  out += mdList('Ownership review files', r.ownershipReviewFiles);
  out += mdList('Likely tests', r.likelyTests);
  out += mdList('Required validations', r.requiredValidations);
  out += mdList('Affected constructs', r.affectedConstructs);
  out += mdList('Recommended playbooks', r.affectedPlaybooks);
  out += mdList('Policy concerns', r.policyConcerns);
  out += mdList('Limitations', r.limitations);
  out += `\n> ${r.humanApprovalReminder}\n`;
  return out;
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderPlanSimulationHtml(r: IPlanSimulationReport): string {
  const md = renderPlanSimulationMarkdown(r);
  // Strip the diff blocks from the markdown and re-render them as collapsible
  // <details> sections so large diffs don't blow out the page.
  const baseMd = md.replace(/## Diff previews[\s\S]*$/m, '').trimEnd();
  let details = '';
  for (const f of r.files) {
    if (!f.diffPreview) continue;
    details += `<details><summary>Diff: ${htmlEscape(f.relativePath)}${f.diffTruncated ? ' (truncated)' : ''}</summary><pre><code>${htmlEscape(f.diffPreview)}</code></pre></details>\n`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>Plan simulation</title></head><body><pre>${htmlEscape(baseMd)}</pre>\n${details}</body></html>\n`;
}
