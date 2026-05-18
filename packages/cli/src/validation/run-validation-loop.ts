import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';

export interface IValidationCommandResult {
  command: string;
  passed: boolean;
  note?: string;
}

export interface IRunValidationLoopOptions {
  cwd: string;
  /** Explicit shell command (--command). Always treated as trusted. */
  explicitCommand?: string;
  /** Verification ids selected via repeated --verification flags. */
  verificationIds: readonly string[];
  /** When true, run every trusted verification command defined in config. */
  allVerifications: boolean;
  /** Pack-contributed commands are never auto-run; this is a future opt-in. */
  allowPackCommands: boolean;
  /** When set, validation report is written here as JSON. */
  reportDir: string | null;
  /** Optional filename for the report (default: timestamped). */
  reportFileName?: string;
  /** Optional callback when a command starts running (for progress output). */
  onCommandStart?: (label: string) => void;
}

export interface IRunValidationLoopResult {
  passed: boolean;
  warnings: number;
  commandsRun: IValidationCommandResult[];
  commandsFailed: string[];
  boundaryViolations: number;
  reportPath?: string;
}

/**
 * Run a set of verification commands defined in `sharkcraft.config.ts` plus an
 * optional explicit `--command`, then perform a non-fatal boundary scan. Writes
 * a JSON report when `reportDir` is set. Pure side effects: spawns shells the
 * caller asked for; never invents commands from pack contributions.
 */
export async function runValidationLoop(
  options: IRunValidationLoopOptions,
): Promise<IRunValidationLoopResult> {
  const out: IRunValidationLoopResult = {
    passed: true,
    warnings: 0,
    commandsRun: [],
    commandsFailed: [],
    boundaryViolations: 0,
  };

  const commands: { id?: string; command: string; trusted: boolean }[] = [];
  if (options.explicitCommand) {
    commands.push({ command: options.explicitCommand, trusted: true });
  }
  try {
    const { loadProjectConfig } = await import('@shrkcrft/config');
    const cfgResult = await loadProjectConfig(options.cwd);
    const cfg = cfgResult.ok ? cfgResult.value.config : null;
    type WithVer = {
      verificationCommands?: {
        id: string;
        command: string;
        trusted?: boolean;
        label?: string;
      }[];
    };
    const ver = (cfg as WithVer | null)?.verificationCommands ?? [];
    const wantIds = new Set(options.verificationIds);
    for (const v of ver) {
      const shouldRun = options.allVerifications || wantIds.has(v.id);
      if (!shouldRun) continue;
      commands.push({ id: v.id, command: v.command, trusted: v.trusted !== false });
    }
    const knownIds = new Set(ver.map((v) => v.id));
    for (const id of options.verificationIds) {
      if (!knownIds.has(id)) {
        out.commandsRun.push({
          command: `--verification ${id}`,
          passed: false,
          note: `unknown verification id "${id}" — define it in sharkcraft.config.ts verificationCommands[]`,
        });
        out.commandsFailed.push(`--verification ${id}`);
        out.passed = false;
      }
    }
  } catch {
    // Best-effort: a missing config just means no configured commands.
  }
  void options.allowPackCommands;

  if (commands.length === 0 && options.verificationIds.length === 0 && !options.explicitCommand) {
    out.commandsRun.push({
      command: '(no command supplied)',
      passed: true,
      note:
        'pass --command "<shell>", --verification <id>, or --all-verifications. ' +
        'Define verificationCommands[] in sharkcraft.config.ts.',
    });
  }

  for (const entry of commands) {
    const { spawnSync } = await import('node:child_process');
    const label = entry.id ? `${entry.id}: ${entry.command}` : entry.command;
    options.onCommandStart?.(label);
    const res = spawnSync(entry.command, [], {
      cwd: options.cwd,
      shell: true,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const ok = res.status === 0;
    out.commandsRun.push({ command: label, passed: ok });
    if (!ok) {
      out.commandsFailed.push(label);
      out.passed = false;
    }
  }

  // Boundary scan as a non-fatal warning (mirrors `shrk apply --validate`).
  try {
    const { inspectSharkcraft } = await import('@shrkcrft/inspector');
    const { evaluateBoundaries, scanImports } = await import('@shrkcrft/boundaries');
    const inspection = await inspectSharkcraft({ cwd: options.cwd });
    if (inspection.boundaryRegistry.size() > 0) {
      const scan = scanImports({ projectRoot: options.cwd });
      const evalResult = evaluateBoundaries(scan, inspection.boundaryRegistry.list());
      out.boundaryViolations = evalResult.violations.length;
      out.warnings += evalResult.counts.warning;
      if (evalResult.counts.error > 0) out.passed = false;
    }
  } catch {
    // boundary scan is best-effort.
  }

  if (options.reportDir) {
    if (!existsSync(options.reportDir)) mkdirSync(options.reportDir, { recursive: true });
    const filename =
      options.reportFileName ?? `validate-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const path = nodePath.join(options.reportDir, filename);
    writeFileSync(path, JSON.stringify(out, null, 2) + '\n', 'utf8');
    out.reportPath = path;
  }
  return out;
}
