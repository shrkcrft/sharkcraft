import { readFileSync } from 'node:fs';
import {
  evaluateBoundaries,
  loadTsconfigPaths,
  scanImports,
} from '@shrkcrft/boundaries';
import {
  checkFolderOpSafety,
  FolderOpSafety,
  planGeneration,
  verifyPlan,
  type IFileChange,
  type ISavedPlan,
} from '@shrkcrft/generator';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export interface IPlanReviewFile {
  /** Now surfaces the v2 operation kinds explicitly instead of collapsing them to 'unknown'. */
  type:
    | 'create'
    | 'update'
    | 'append'
    | 'insert-after'
    | 'insert-before'
    | 'replace'
    | 'export'
    | 'skip'
    | 'conflict'
    | 'unknown';
  relativePath: string;
  reason?: string;
  /** When true, the entry modifies an already-existing file. UI surfaces this prominently. */
  modifiesExisting?: boolean;
}

export interface IPlanIntroducedBoundaryConcern {
  /** Planned file (path relative to project root). */
  file: string;
  ruleId: string;
  ruleTitle: string;
  importSpecifier: string;
  line: number;
  severity: string;
  message: string;
  suggestedFix?: string;
  resolvedVia?: string;
}

export interface IPlanReviewFolderOp {
  kind: 'rename-folder' | 'delete-folder';
  targetPath: string;
  newPath?: string;
  safety: 'safe' | 'unsafe';
  safetyReason?: string;
  /** Human-friendly hint: which allow flag is needed (e.g. `--allow-folder-ops`). */
  requiresAllowFlag: 'allow-folder-ops' | 'allow-folder-ops+allow-delete-folder';
}

export interface IPlanReviewReport {
  source: string;
  templateId?: string;
  /** Aggregated file outcomes. */
  files: IPlanReviewFile[];
  /** Folder operations carried by the plan. */
  folderOps: readonly IPlanReviewFolderOp[];
  /** Signature status (if a signature is present). */
  signature: 'absent' | 'present' | 'invalid';
  signatureMessage?: string;
  /** Best-effort link from changed files to path conventions. */
  affectedPaths: readonly string[];
  /** Heuristic missing-tests list (src/x.ts → tests/x.spec.ts). */
  missingTestsHeuristic: readonly string[];
  /** Boundary violations in the *current* project state on the target paths. */
  potentialBoundaryConcerns: readonly {
    file: string;
    ruleId: string;
    importSpecifier: string;
    line: number;
    severity: string;
  }[];
  /**
   * NEW: boundary violations the plan would *introduce* by writing the planned
   * file contents. Computed by re-rendering the template (when available) and
   * scanning its imports against the boundary rules.
   */
  planIntroducedBoundaryConcerns: readonly IPlanIntroducedBoundaryConcern[];
  /** Verification commands recommended to run after apply. */
  verificationCommands: readonly string[];
  humanApprovalReminder: string;
}

export function reviewSavedPlan(
  inspection: ISharkcraftInspection,
  planPath: string,
): IPlanReviewReport {
  const raw = readFileSync(planPath, 'utf8');
  const plan = JSON.parse(raw) as ISavedPlan;

  // Re-render the template to recover file contents — saved plans intentionally
  // don't store contents to keep the plan compact and signature-stable.
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
      } catch {
        // If re-render fails, fall back to expectedChanges metadata only.
      }
    }
  }

  // Build the surface from live changes when available, otherwise from
  // expectedChanges metadata.
  const expected = plan.expectedChanges ?? [];
  const files: IPlanReviewFile[] = liveChanges.length
    ? liveChanges.map((c) => {
        const type = classifyChangeType(String(c.type));
        const out: IPlanReviewFile = {
          type,
          relativePath: c.relativePath,
        };
        if (c.reason) out.reason = c.reason;
        if (modifiesExistingFor(type)) out.modifiesExisting = true;
        return out;
      })
    : expected.map((c) => {
        const type = classifyChangeType(c.type);
        const out: IPlanReviewFile = {
          type,
          relativePath: c.relativePath,
        };
        if (modifiesExistingFor(type)) out.modifiesExisting = true;
        return out;
      });

  // Signature status.
  let signature: IPlanReviewReport['signature'] = 'absent';
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

  // Affected paths heuristic.
  const segments = new Set<string>();
  for (const f of files) {
    for (const seg of f.relativePath.split('/')) segments.add(seg.toLowerCase());
  }
  const affectedPaths = inspection.pathService
    .list()
    .filter((p) =>
      [...segments].some((s) => (p.title + ' ' + p.content).toLowerCase().includes(s)),
    )
    .map((p) => p.id);

  // Missing-tests heuristic.
  const missingTestsHeuristic: string[] = [];
  const allPaths = new Set(files.map((f) => f.relativePath));
  for (const f of files) {
    if (f.type !== 'create' && f.type !== 'update') continue;
    if (!f.relativePath.endsWith('.ts') && !f.relativePath.endsWith('.tsx')) continue;
    if (f.relativePath.includes('/tests/') || f.relativePath.endsWith('.spec.ts')) continue;
    if (!f.relativePath.startsWith('src/')) continue;
    const candidate = f.relativePath
      .replace(/^src\//, 'tests/')
      .replace(/\.tsx?$/, '.spec.ts');
    if (!allPaths.has(candidate)) {
      missingTestsHeuristic.push(`${f.relativePath} → expected ${candidate}`);
    }
  }

  // Current-state boundary scan on the target paths (existing behavior).
  let potentialBoundaryConcerns: IPlanReviewReport['potentialBoundaryConcerns'] = [];
  const tsconfigPaths = loadTsconfigPaths(inspection.projectRoot);
  const aliasOpts =
    tsconfigPaths.aliases.size > 0 ? { tsconfigPaths } : {};
  if (inspection.boundaryRegistry.size() > 0 && files.length > 0) {
    const scan = scanImports({ projectRoot: inspection.projectRoot });
    const evalResult = evaluateBoundaries(
      scan,
      inspection.boundaryRegistry.list(),
      aliasOpts,
    );
    const targetSet = new Set(files.map((f) => f.relativePath));
    potentialBoundaryConcerns = evalResult.violations
      .filter((v) => targetSet.has(v.file))
      .map((v) => ({
        file: v.file,
        ruleId: v.ruleId,
        importSpecifier: v.importSpecifier,
        line: v.line,
        severity: v.severity,
      }));
  }

  // Plan-introduced boundary concerns: scan imports inside the *planned*
  // file contents and evaluate them as if those files existed at their
  // planned paths.
  const planIntroducedBoundaryConcerns: IPlanIntroducedBoundaryConcern[] = [];
  if (inspection.boundaryRegistry.size() > 0 && liveChanges.length > 0) {
    const plannedEdges = collectPlannedEdges(liveChanges);
    const evalResult = evaluateBoundaries(
      { filesScanned: liveChanges.length, edges: plannedEdges, warnings: [] },
      inspection.boundaryRegistry.list(),
      aliasOpts,
    );
    for (const v of evalResult.violations) {
      const rule = inspection.boundaryRegistry.get(v.ruleId);
      planIntroducedBoundaryConcerns.push({
        file: v.file,
        ruleId: v.ruleId,
        ruleTitle: rule?.title ?? v.ruleId,
        importSpecifier: v.importSpecifier,
        line: v.line,
        severity: v.severity,
        message: v.message,
        ...(v.suggestedFix ? { suggestedFix: v.suggestedFix } : {}),
        ...(v.resolvedVia ? { resolvedVia: v.resolvedVia } : {}),
      });
    }
  }

  // Folder ops surfaced with safety verdict + required allow flag.
  const folderOps: IPlanReviewFolderOp[] = (plan.folderOps ?? []).map((op) => {
    // We check folder-op safety with allowDeleteFolder OFF so the report
    // surfaces the strictest verdict; the human reading the review sees
    // the worst case.
    const safety = checkFolderOpSafety(inspection.projectRoot, op.targetPath, op.kind);
    const entry: IPlanReviewFolderOp = {
      kind: op.kind,
      targetPath: op.targetPath,
      safety: safety.safety === FolderOpSafety.Safe ? 'safe' : 'unsafe',
      requiresAllowFlag:
        op.kind === 'delete-folder'
          ? 'allow-folder-ops+allow-delete-folder'
          : 'allow-folder-ops',
    };
    if (op.newPath !== undefined) entry.newPath = op.newPath;
    if (safety.reason !== undefined) entry.safetyReason = safety.reason;
    return entry;
  });

  const out: IPlanReviewReport = {
    source: planPath,
    files,
    folderOps,
    signature,
    affectedPaths,
    missingTestsHeuristic,
    potentialBoundaryConcerns,
    planIntroducedBoundaryConcerns,
    verificationCommands: [
      'shrk doctor',
      'shrk check boundaries',
      'bun x tsc -p tsconfig.base.json --noEmit',
      'bun test',
    ],
    humanApprovalReminder:
      'The MCP server never writes. A human must run `shrk apply <plan> --verify-signature` after reviewing this report.',
  };
  if (plan.templateId) out.templateId = plan.templateId;
  if (signatureMessage) out.signatureMessage = signatureMessage;
  return out;
}

function classifyChangeType(s: string): IPlanReviewFile['type'] {
  switch (s) {
    case 'create':
      return 'create';
    case 'update':
    case 'overwrite':
      return 'update';
    case 'append':
      return 'append';
    case 'insert-after':
      return 'insert-after';
    case 'insert-before':
      return 'insert-before';
    case 'replace':
      return 'replace';
    case 'export':
      return 'export';
    case 'skip':
      return 'skip';
    case 'conflict':
      return 'conflict';
    default:
      return 'unknown';
  }
}

function modifiesExistingFor(type: IPlanReviewFile['type']): boolean {
  return (
    type === 'update' ||
    type === 'append' ||
    type === 'insert-after' ||
    type === 'insert-before' ||
    type === 'replace' ||
    type === 'export'
  );
}

function collectPlannedEdges(
  changes: readonly IFileChange[],
): { from: string; importSpecifier: string; line: number; kind: 'internal' | 'external' }[] {
  const edges: { from: string; importSpecifier: string; line: number; kind: 'internal' | 'external' }[] = [];
  // Reuse the same regex set as scan-imports (kept in sync manually for v1).
  const REGEXES = [
    /(?:^|\s)(?:import|export)\s+[^'"`]*?from\s+['"]([^'"`]+)['"]/g,
    /(?:^|\s)import\s+['"]([^'"`]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"`]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"`]+)['"]\s*\)/g,
  ];
  for (const c of changes) {
    if (c.type !== 'create' && c.type !== 'update') continue;
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(c.relativePath)) continue;
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
