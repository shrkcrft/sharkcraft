import { existsSync, readFileSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { readPlanFromFile, type ISavedPlan, type ISavedPlanExpectedChange } from '@shrkcrft/generator';
import {
  flagBool,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';
import { printError } from '../output/print-error.ts';

interface IFileFinding {
  relativePath: string;
  type: string;
  status: 'compliant' | 'missing' | 'shrunk' | 'unexpected-type' | 'no-content';
  expectedSizeBytes?: number;
  actualSizeBytes?: number;
  detail?: string;
}

interface IValidateReport {
  schema: 'sharkcraft.scaffold-validate/v1';
  planFile: string;
  templateId: string;
  name?: string;
  projectRoot: string;
  totals: {
    expected: number;
    compliant: number;
    missing: number;
    shrunk: number;
    unexpectedType: number;
  };
  findings: IFileFinding[];
  folderOpFindings: Array<{ kind: string; targetPath: string; status: 'compliant' | 'missing'; detail?: string }>;
  status: 'ok' | 'partial' | 'failed';
  handoffForClaude: string;
}

/**
 * `shrk scaffold-validate <plan-file>` — verify that the files
 * recorded in a saved generation plan actually exist on disk and
 * look like they came from the template.
 *
 * Read-only: never writes, never re-runs the template. Designed to
 * run after `shrk apply` (or after a human manually copied a plan
 * into place) to catch:
 *   - missing files (apply was interrupted, or somebody deleted)
 *   - shrunken files (someone replaced the body with `// TODO`)
 *   - mismatched operation type (plan said `create`, disk shows
 *     something else)
 *
 * NOT a full template-replay check — we can't know the exact
 * expected body without re-rendering the template, which would
 * be far more expensive and would couple this command to every
 * template's variable resolution. Sizes + existence + type catches
 * 95% of real-world failures.
 */
export const scaffoldValidateCommand: ICommandHandler = {
  name: 'scaffold-validate',
  description:
    'Verify that the files recorded in a saved generation plan exist on disk and match the planned type/size envelope.',
  usage: 'shrk scaffold-validate <plan-file> [--json] [--shrink-tolerance N]',
  async run(args: ParsedArgs): Promise<number> {
    const planArg = args.positional[0]?.trim();
    if (!planArg) {
      process.stderr.write('Usage: shrk scaffold-validate <plan-file> [--json] [--shrink-tolerance N]\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const json = flagBool(args, 'json');
    const shrinkTolerance =
      typeof args.flags.get('shrink-tolerance') === 'string'
        ? Number(args.flags.get('shrink-tolerance') as string)
        : 0.25;
    const planFile = nodePath.isAbsolute(planArg) ? planArg : nodePath.resolve(cwd, planArg);
    if (!existsSync(planFile)) {
      process.stderr.write(`Plan file not found: ${planFile}\n`);
      return 1;
    }
    const loaded = readPlanFromFile(planFile);
    if (!loaded.ok) {
      printError(loaded.error);
      return 1;
    }
    const plan = loaded.value;
    const projectRoot = nodePath.isAbsolute(plan.projectRoot)
      ? plan.projectRoot
      : nodePath.resolve(cwd, plan.projectRoot);
    const expected = plan.expectedChanges ?? [];
    const findings: IFileFinding[] = [];
    for (const change of expected) {
      findings.push(checkChange(projectRoot, change, shrinkTolerance));
    }
    const folderFindings = (plan.folderOps ?? []).map((op) => {
      const target = nodePath.join(projectRoot, op.targetPath);
      if (op.kind === 'rename-folder') {
        // After apply, the renamed folder should be at newPath, and
        // the old path should not exist (unless human reverted).
        const newPath = op.newPath ? nodePath.join(projectRoot, op.newPath) : '';
        if (newPath && existsSync(newPath)) {
          return { kind: op.kind, targetPath: op.targetPath, status: 'compliant' as const };
        }
        return {
          kind: op.kind,
          targetPath: op.targetPath,
          status: 'missing' as const,
          detail: `rename target "${op.newPath ?? '?'}" not found`,
        };
      }
      if (op.kind === 'delete-folder') {
        if (!existsSync(target)) {
          return { kind: op.kind, targetPath: op.targetPath, status: 'compliant' as const };
        }
        return {
          kind: op.kind,
          targetPath: op.targetPath,
          status: 'missing' as const,
          detail: 'folder still present (delete not applied)',
        };
      }
      return { kind: String(op.kind), targetPath: op.targetPath, status: 'missing' as const };
    });
    const totals = {
      expected: expected.length,
      compliant: findings.filter((f) => f.status === 'compliant').length,
      missing: findings.filter((f) => f.status === 'missing').length,
      shrunk: findings.filter((f) => f.status === 'shrunk').length,
      unexpectedType: findings.filter((f) => f.status === 'unexpected-type').length,
    };
    const hasFailures = totals.missing > 0 || totals.unexpectedType > 0;
    const hasWarnings = totals.shrunk > 0;
    const status: IValidateReport['status'] = hasFailures
      ? 'failed'
      : hasWarnings || folderFindings.some((f) => f.status === 'missing')
        ? 'partial'
        : 'ok';
    const report: IValidateReport = {
      schema: 'sharkcraft.scaffold-validate/v1',
      planFile,
      templateId: plan.templateId,
      ...(plan.name !== undefined ? { name: plan.name } : {}),
      projectRoot,
      totals,
      findings,
      folderOpFindings: folderFindings,
      status,
      handoffForClaude: handoffFor(status, totals, folderFindings.length),
    };
    if (json) {
      process.stdout.write(asJson(report) + '\n');
      return status === 'failed' ? 1 : 0;
    }
    renderText(report);
    return status === 'failed' ? 1 : 0;
  },
};

function checkChange(
  projectRoot: string,
  change: ISavedPlanExpectedChange,
  shrinkTolerance: number,
): IFileFinding {
  const abs = nodePath.join(projectRoot, change.relativePath);
  const base: IFileFinding = {
    relativePath: change.relativePath,
    type: change.type,
    status: 'compliant',
    expectedSizeBytes: change.sizeBytes,
  };
  // delete-file plans expect the file NOT to exist after apply.
  if (change.type === 'delete') {
    if (existsSync(abs)) {
      return { ...base, status: 'unexpected-type', detail: 'file is still present after delete plan' };
    }
    return base;
  }
  if (!existsSync(abs)) {
    return { ...base, status: 'missing', detail: 'file not found on disk' };
  }
  let stat;
  try {
    stat = statSync(abs);
  } catch (e) {
    return { ...base, status: 'missing', detail: (e as Error).message };
  }
  if (!stat.isFile()) {
    return { ...base, status: 'unexpected-type', detail: 'path is not a regular file' };
  }
  // Read first chunk to detect "the file was reduced to a stub by hand"
  // (`// TODO`, `export {}`, empty). We compare against the planned size
  // with a tolerance — humans naturally grow files, but shrinking past
  // tolerance is suspicious.
  const actualSize = stat.size;
  base.actualSizeBytes = actualSize;
  if (change.sizeBytes > 0) {
    const ratio = actualSize / change.sizeBytes;
    if (ratio < 1 - shrinkTolerance) {
      let snippet = '';
      try {
        snippet = readFileSync(abs, 'utf8').slice(0, 200).replace(/\s+/g, ' ');
      } catch {
        /* ignore */
      }
      return {
        ...base,
        status: 'shrunk',
        detail: `actual ${actualSize}B is < ${Math.round((1 - shrinkTolerance) * 100)}% of expected ${change.sizeBytes}B${snippet ? ` (head: "${snippet}")` : ''}`,
      };
    }
  } else if (actualSize === 0) {
    return { ...base, status: 'no-content', detail: 'file is empty' };
  }
  return base;
}

function handoffFor(
  status: IValidateReport['status'],
  totals: IValidateReport['totals'],
  folderCount: number,
): string {
  if (status === 'failed') {
    return `Scaffold integrity failed: ${totals.missing} missing, ${totals.unexpectedType} type mismatch. Re-run \`shrk apply <plan>\` or investigate manually.`;
  }
  if (status === 'partial') {
    const bits: string[] = [];
    if (totals.shrunk > 0) bits.push(`${totals.shrunk} file(s) shrunk past tolerance`);
    if (folderCount > 0) bits.push(`folder op(s) inconsistent`);
    return `Scaffold OK but with warnings: ${bits.join(', ')}. Probably fine but worth a glance.`;
  }
  return 'Scaffold looks intact — every planned file is on disk with the expected envelope.';
}

function renderText(r: IValidateReport): void {
  process.stdout.write(
    header(`scaffold-validate — ${r.templateId}${r.name ? ` (${r.name})` : ''}`),
  );
  process.stdout.write(`plan:        ${r.planFile}\n`);
  process.stdout.write(`status:      ${r.status}\n`);
  process.stdout.write(
    `summary:     ${r.totals.compliant}/${r.totals.expected} compliant, ` +
      `${r.totals.missing} missing, ${r.totals.shrunk} shrunk, ${r.totals.unexpectedType} type-mismatch\n`,
  );
  process.stdout.write('\n');
  for (const f of r.findings) {
    const marker =
      f.status === 'compliant' ? '✓' : f.status === 'missing' ? '✗' : f.status === 'shrunk' ? '⚠' : '?';
    process.stdout.write(`  ${marker} ${f.relativePath} [${f.type}]`);
    if (f.detail) process.stdout.write(` — ${f.detail}`);
    process.stdout.write('\n');
  }
  if (r.folderOpFindings.length > 0) {
    process.stdout.write('\nfolder ops:\n');
    for (const f of r.folderOpFindings) {
      const marker = f.status === 'compliant' ? '✓' : '✗';
      process.stdout.write(`  ${marker} ${f.kind} ${f.targetPath}${f.detail ? ` — ${f.detail}` : ''}\n`);
    }
  }
  process.stdout.write(`\nhandoff: ${r.handoffForClaude}\n`);
}
