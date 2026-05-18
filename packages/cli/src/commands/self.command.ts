import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  buildSelfAudit,
  detectSharkcraftRepo,
  inspectSharkcraft,
  buildReleaseReadiness,
  buildDocsCheck,
  buildExamplesCheck,
  renderSelfAuditText,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagNumber,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson } from '../output/format-output.ts';

interface IRunInput {
  bin: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
}

interface IRunResult {
  ok: boolean;
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
}

function tail(s: string, n = 12): string {
  return s.split(/\r?\n/).slice(-n).join('\n');
}

function runCheck(input: IRunInput): IRunResult {
  try {
    const result = spawnSync(input.bin, input.args, {
      cwd: input.cwd,
      env: { ...process.env, NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: input.timeoutMs,
      stdio: 'pipe',
    });
    const exit = result.status ?? null;
    return {
      ok: exit === 0,
      exitCode: exit,
      stdoutTail: tail(result.stdout ?? ''),
      stderrTail: tail(result.stderr ?? ''),
    };
  } catch (e) {
    return { ok: false, exitCode: null, stdoutTail: '', stderrTail: (e as Error).message };
  }
}

interface IExtraEvidence {
  commandsDoctorOk: boolean | null;
  runtimeDoctorOk: boolean | null;
  safetyAuditOk: boolean | null;
  packsDoctorOk: boolean | null;
  demoPackageValidateOk: boolean | null;
  perCheckDurations: Record<string, number>;
}

async function runInternalChecks(cwd: string, cliEntry: string, timeoutMs: number): Promise<IExtraEvidence> {
  const durations: Record<string, number> = {};
  const cycle = (id: string, args: readonly string[]): IRunResult => {
    const start = Date.now();
    const r = runCheck({ bin: 'bun', args: [cliEntry, ...args], cwd, timeoutMs });
    durations[id] = Date.now() - start;
    return r;
  };
  const commandsDoctor = cycle('commands-doctor', ['commands', 'doctor']);
  const runtimeDoctor = cycle('runtime-doctor', ['runtime', 'doctor']);
  const safetyAudit = cycle('safety-audit', ['safety', 'audit']);
  const packsDoctor = cycle('packs-doctor', ['packs', 'doctor', '--release']);
  const demoValidate = cycle('demo-validate', ['demo', 'package', '--validate', '--scenario', 'pr-review']);
  return {
    commandsDoctorOk: commandsDoctor.ok,
    runtimeDoctorOk: runtimeDoctor.ok,
    safetyAuditOk: safetyAudit.ok,
    packsDoctorOk: packsDoctor.ok,
    demoPackageValidateOk: demoValidate.ok,
    perCheckDurations: durations,
  };
}

export const selfAuditCommand: ICommandHandler = {
  name: 'audit',
  description: 'Run the SharkCraft self-dogfood audit (only meaningful inside the SharkCraft repo). Read-only.',
  usage: 'shrk self audit [--json] [--report] [--run] [--timeout-ms <n>]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const isRepo = detectSharkcraftRepo(cwd);
    if (!isRepo) {
      const report = buildSelfAudit(cwd);
      if (flagBool(args, 'json')) process.stdout.write(asJson(report) + '\n');
      else process.stdout.write(renderSelfAuditText(report));
      return 0;
    }
    const inspection = await inspectSharkcraft({ cwd });
    const readiness = await buildReleaseReadiness(inspection, {
      includeDocsCheck: true,
      includeExamplesCheck: true,
    });
    const docsCheck = buildDocsCheck(cwd);
    const examplesCheck = buildExamplesCheck(cwd);
    let extra: IExtraEvidence | null = null;
    let cliEntry = nodePath.join(cwd, 'packages', 'cli', 'src', 'main.ts');
    if (!existsSync(cliEntry)) cliEntry = 'shrk';
    if (flagBool(args, 'run')) {
      const timeoutMs = flagNumber(args, 'timeout-ms') ?? 90_000;
      extra = await runInternalChecks(cwd, cliEntry, timeoutMs);
    }
    const report = buildSelfAudit(cwd, {
      releaseReadinessReady: readiness.ready,
      releaseReadinessBlockers: readiness.blockers.length,
      releaseReadinessWarnings: readiness.warnings.length,
      mcpAuditWriteToolCount: 0,
      docsCheckOk: docsCheck.ok,
      examplesCheckOk: examplesCheck.ok,
      ...(extra
        ? {
            commandsDoctorErrors: extra.commandsDoctorOk ? 0 : 1,
            runtimeDoctorOk: extra.runtimeDoctorOk,
            packsDoctorOk: extra.packsDoctorOk,
            demoPackageValidateOk: extra.demoPackageValidateOk,
          }
        : {}),
    });
    if (flagBool(args, 'report')) {
      const outDir = nodePath.join(cwd, '.sharkcraft', 'reports');
      mkdirSync(outDir, { recursive: true });
      writeFileSync(
        nodePath.join(outDir, 'self-audit.json'),
        JSON.stringify({ ...report, extra }, null, 2) + '\n',
        'utf8',
      );
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ ...report, extra }) + '\n');
      return report.ok ? 0 : 1;
    }
    process.stdout.write(renderSelfAuditText(report));
    if (extra) {
      process.stdout.write('\nRan internal checks:\n');
      for (const [k, v] of Object.entries(extra.perCheckDurations)) {
        process.stdout.write(`  ${k.padEnd(24)} ${v}ms\n`);
      }
    }
    return report.ok ? 0 : 1;
  },
};
