/**
 * Validate adoption-patch applicability without applying it. For unified diffs
 * we delegate to `git apply --check` when git is on PATH; for pseudo diffs we
 * validate referenced files exist and target hashes still match.
 *
 * Read-only. We never run `git apply` without `--check`, and we never modify
 * any target file.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { spawnSync } from 'node:child_process';
import { adoptionDir, readAdoptionState } from './adoption-state.ts';
import { validatePatchTargets, type IAdoptionPatchTarget } from './onboarding-adoption.ts';

export enum AdoptionCheckResult {
  CanApply = 'can-apply',
  CannotApply = 'cannot-apply',
  Unknown = 'unknown',
}

export interface IAdoptionCheck {
  id: string;
  passed: boolean;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

export interface IAdoptionCheckReport {
  schema: 'sharkcraft.adoption-check/v1';
  projectRoot: string;
  patchPath: string | null;
  patchFormat: 'pseudo' | 'unified' | 'unknown';
  canApply: AdoptionCheckResult;
  checks: readonly IAdoptionCheck[];
  warnings: readonly string[];
  nextCommand: string;
}

function detectPatchFormat(body: string): 'pseudo' | 'unified' | 'unknown' {
  if (/^# Format: unified/m.test(body) || /^new file mode/m.test(body) || /^@@ -\d+,\d+ \+\d+,\d+ @@/m.test(body)) {
    return 'unified';
  }
  if (/^@@ append @@/m.test(body)) return 'pseudo';
  return 'unknown';
}

function gitAvailable(): boolean {
  try {
    const res = spawnSync('git', ['--version'], { stdio: 'pipe', encoding: 'utf8' });
    return res.status === 0;
  } catch {
    return false;
  }
}

function gitApplyCheck(projectRoot: string, patchPath: string): { passed: boolean; stderr: string } {
  const res = spawnSync('git', ['apply', '--check', patchPath], {
    cwd: projectRoot,
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { passed: (res.status ?? -1) === 0, stderr: res.stderr ?? '' };
}

export interface IBuildAdoptionCheckInput {
  projectRoot: string;
  /** When provided, override the default adoption-state-derived patch path. */
  patchPath?: string;
}

export function buildAdoptionCheck(input: IBuildAdoptionCheckInput): IAdoptionCheckReport {
  const state = readAdoptionState(input.projectRoot);
  const dir = adoptionDir(input.projectRoot);
  const patchPath = input.patchPath ?? nodePath.join(dir, 'adopt.patch');
  const checks: IAdoptionCheck[] = [];
  const warnings: string[] = [];

  if (!existsSync(patchPath)) {
    checks.push({
      id: 'patch-exists',
      passed: false,
      severity: 'error',
      message: `adopt.patch not found at ${patchPath}`,
    });
    return {
      schema: 'sharkcraft.adoption-check/v1',
      projectRoot: input.projectRoot,
      patchPath: null,
      patchFormat: 'unknown',
      canApply: AdoptionCheckResult.CannotApply,
      checks,
      warnings,
      nextCommand: 'shrk onboard adopt --write-patch --diff-format unified',
    };
  }
  checks.push({
    id: 'patch-exists',
    passed: true,
    severity: 'info',
    message: `adopt.patch present at ${patchPath}`,
  });

  const body = readFileSync(patchPath, 'utf8');
  const format = detectPatchFormat(body);
  checks.push({
    id: 'patch-format-detected',
    passed: format !== 'unknown',
    severity: format === 'unknown' ? 'warning' : 'info',
    message: format === 'unknown' ? 'patch format could not be detected' : `patch format: ${format}`,
  });

  let targetCheckPassed = true;
  if (state) {
    const targets: IAdoptionPatchTarget[] = state.targetFiles.map((t) => ({
      relativePath: t.relativePath,
      existed: t.hash !== '(missing)',
      ...(t.hash !== '(missing)' ? { beforeHash: t.hash } : {}),
      bytesAdded: 0,
    }));
    const v = validatePatchTargets(input.projectRoot, targets);
    if (v.changed.length > 0) {
      targetCheckPassed = false;
      checks.push({
        id: 'target-hashes-stable',
        passed: false,
        severity: 'warning',
        message: `${v.changed.length} target file(s) changed since the patch was generated: ${v.changed.map((c) => c.relativePath).join(', ')}`,
      });
      warnings.push('regenerate the patch with `shrk onboard adopt regenerate` before applying');
    } else {
      checks.push({
        id: 'target-hashes-stable',
        passed: true,
        severity: 'info',
        message: 'every target file matches the hash recorded in adoption-state.json',
      });
    }
  } else {
    checks.push({
      id: 'adoption-state-present',
      passed: false,
      severity: 'warning',
      message: 'no adoption-state.json — target hash validation skipped',
    });
    warnings.push('run with --write-patch to write a fresh adoption state');
  }

  let gitOk: 'ok' | 'fail' | 'skipped' = 'skipped';
  let gitMsg = '';
  if (format === 'unified') {
    if (gitAvailable()) {
      const r = gitApplyCheck(input.projectRoot, patchPath);
      gitOk = r.passed ? 'ok' : 'fail';
      gitMsg = r.stderr.slice(0, 800);
      checks.push({
        id: 'git-apply-check',
        passed: r.passed,
        severity: r.passed ? 'info' : 'error',
        message: r.passed ? 'git apply --check succeeded' : `git apply --check failed: ${gitMsg.split('\n').slice(0, 3).join(' | ')}`,
      });
    } else {
      checks.push({
        id: 'git-apply-check',
        passed: false,
        severity: 'info',
        message: 'git not available — skipping git apply --check',
      });
    }
  } else if (format === 'pseudo') {
    checks.push({
      id: 'pseudo-format-info',
      passed: true,
      severity: 'info',
      message: 'pseudo-patch format — git apply is not expected to succeed; copy blocks manually',
    });
  }

  // Final verdict.
  let canApply: AdoptionCheckResult = AdoptionCheckResult.Unknown;
  if (format === 'unified' && gitOk === 'ok' && targetCheckPassed) {
    canApply = AdoptionCheckResult.CanApply;
  } else if (format === 'unified' && gitOk === 'fail') {
    canApply = AdoptionCheckResult.CannotApply;
  } else if (format === 'pseudo') {
    canApply = AdoptionCheckResult.Unknown;
  } else if (!targetCheckPassed) {
    canApply = AdoptionCheckResult.CannotApply;
  }

  const nextCommand =
    canApply === AdoptionCheckResult.CanApply
      ? `git apply ${patchPath}`
      : canApply === AdoptionCheckResult.CannotApply
        ? 'shrk onboard adopt regenerate'
        : 'shrk onboard adopt merge-preview --format markdown';

  return {
    schema: 'sharkcraft.adoption-check/v1',
    projectRoot: input.projectRoot,
    patchPath,
    patchFormat: format,
    canApply,
    checks,
    warnings,
    nextCommand,
  };
}
