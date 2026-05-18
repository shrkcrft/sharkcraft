import { spawnSync } from 'node:child_process';
import { evaluateBoundaries, loadTsconfigPaths, scanImports } from '@shrkcrft/boundaries';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { rankAll } from './task-ranker.ts';

export interface IReviewPacket {
  changedFiles: readonly string[];
  /** Affected path-convention ids (best-effort substring match). */
  affectedPaths: readonly string[];
  /** Rules likely relevant to these changes. */
  relevantRules: readonly { id: string; title: string; reason: string }[];
  /** Pipelines/templates likely relevant. */
  relevantTemplates: readonly { id: string; name: string }[];
  relevantPipelines: readonly { id: string; title: string }[];
  /** Boundary violations restricted to the changed files. */
  boundaryViolations: readonly {
    ruleId: string;
    file: string;
    importSpecifier: string;
    line: number;
    severity: string;
    message: string;
  }[];
  /** Heuristic: missing tests for any changed `src/**` files. */
  missingTestsHeuristic: readonly string[];
  /** Verification commands recommended for the change set. */
  verificationCommands: readonly string[];
  /** Free-form instructions block intended for an AI PR reviewer. */
  reviewerInstructions: string;
}

export interface IBuildReviewPacketOptions {
  /**
   * Mode of selecting changed files:
   *  - { since: 'HEAD' } → git diff --name-only HEAD
   *  - { staged: true } → git diff --name-only --cached
   *  - { files: [...] } → explicit list (paths relative to project root)
   */
  since?: string;
  staged?: boolean;
  files?: readonly string[];
}

function gitDiffFiles(cwd: string, opts: IBuildReviewPacketOptions): string[] {
  if (opts.files && opts.files.length > 0) return [...opts.files];
  const args = ['diff', '--name-only'];
  if (opts.staged) args.push('--cached');
  if (opts.since) args.push(opts.since);
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) return [];
  return (res.stdout ?? '')
    .toString()
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function buildPseudoTask(files: readonly string[]): string {
  // Use the top-level dir of each file as a pseudo-task description so the
  // ranker can latch onto path-aware tokens (e.g. "src services").
  const tokens = new Set<string>();
  for (const f of files) {
    for (const seg of f.split('/').slice(0, 4)) tokens.add(seg);
  }
  return [...tokens].join(' ');
}

function missingTestsHeuristic(files: readonly string[]): string[] {
  const out: string[] = [];
  const set = new Set(files);
  for (const f of files) {
    if (!f.endsWith('.ts') && !f.endsWith('.tsx')) continue;
    if (f.includes('/tests/') || f.endsWith('.spec.ts') || f.endsWith('.test.ts')) continue;
    if (!f.startsWith('src/')) continue;
    const candidate = f
      .replace(/^src\//, 'tests/')
      .replace(/\.tsx?$/, '.spec.ts');
    if (!set.has(candidate)) out.push(`${f} → expected ${candidate}`);
  }
  return out;
}

export function buildReviewPacket(
  inspection: ISharkcraftInspection,
  options: IBuildReviewPacketOptions = {},
): IReviewPacket {
  const changedFiles = gitDiffFiles(inspection.projectRoot, options);
  const pseudoTask = buildPseudoTask(changedFiles);
  const ranking = rankAll(inspection, pseudoTask, 8);

  // Affected paths: any path-convention whose title or content mentions any
  // path segment from the changed files.
  const segments = new Set<string>();
  for (const f of changedFiles) {
    for (const seg of f.split('/')) segments.add(seg.toLowerCase());
  }
  const affectedPaths = inspection.pathService
    .list()
    .filter((p) =>
      [...segments].some((s) =>
        (p.title + ' ' + p.content).toLowerCase().includes(s),
      ),
    )
    .map((p) => p.id);

  // Boundary violations restricted to changed files.
  let boundaryViolations: IReviewPacket['boundaryViolations'] = [];
  if (inspection.boundaryRegistry.size() > 0 && changedFiles.length > 0) {
    const scan = scanImports({ projectRoot: inspection.projectRoot });
    const tsconfigPaths = loadTsconfigPaths(inspection.projectRoot);
    const evalResult = evaluateBoundaries(scan, inspection.boundaryRegistry.list(), {
      ...(tsconfigPaths.aliases.size > 0 ? { tsconfigPaths } : {}),
    });
    const changedSet = new Set(changedFiles);
    boundaryViolations = evalResult.violations
      .filter((v) => changedSet.has(v.file))
      .map((v) => ({
        ruleId: v.ruleId,
        file: v.file,
        importSpecifier: v.importSpecifier,
        line: v.line,
        severity: v.severity,
        message: v.message,
      }));
  }

  const verificationCommands = unique([
    'shrk doctor',
    'shrk check boundaries',
    'bun x tsc -p tsconfig.base.json --noEmit',
    'bun test',
  ]);

  const reviewerInstructions = [
    `# AI reviewer instructions`,
    ``,
    `This PR touches ${changedFiles.length} file(s).`,
    `Use the SharkCraft data below to focus your review:`,
    ``,
    `1. Confirm the changed files respect the project's path conventions.`,
    `2. Cross-check the listed rules — anything missing?`,
    `3. Look at the boundary violations (if any) — those are objective.`,
    `4. Look at the missing-tests heuristic — is each new src/ file tested?`,
    `5. Run the verification commands before approving.`,
    ``,
    `**Do not write code yourself.** Suggest changes to the human author; the`,
    `human uses \`shrk apply\` for any writes.`,
  ].join('\n');

  return {
    changedFiles,
    affectedPaths,
    relevantRules: ranking.rules.slice(0, 6).map((r) => ({
      id: r.item.id,
      title: r.item.title,
      reason: r.reasons.join('; '),
    })),
    relevantTemplates: ranking.templates.slice(0, 6).map((t) => ({
      id: t.item.id,
      name: t.item.name,
    })),
    relevantPipelines: ranking.pipelines.slice(0, 3).map((p) => ({
      id: p.item.id,
      title: p.item.title,
    })),
    boundaryViolations,
    missingTestsHeuristic: missingTestsHeuristic(changedFiles),
    verificationCommands,
    reviewerInstructions,
  };
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
