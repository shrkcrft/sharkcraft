import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import {
  buildReleaseReadiness,
  inspectSharkcraft,
  ReleaseReadinessSeverity,
  renderReleaseReadinessHtml,
  pickScenarios,
  createFixtureRoot,
  collectFixtureFiles,
  assertSafeWrites,
  renderSmokeReport,
  evaluateSmokeAssertion,
  getInstallSmokePlan,
  type ISmokeAssertion,
  type ISmokeAssertionResult,
  type ISmokeScenario,
  type ISmokeScenarioResult,
  type ISmokeStep,
  type ISmokeStepResult,
  type IReleaseSmokeReport,
  type SmokeScenarioId,
  type IInstallSmokeReport,
  type IInstallSmokeStepResult,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';

const SMOKE_SCENARIO_IDS: readonly SmokeScenarioId[] = [
  'unconfigured-repo',
  'dev-workflow',
  'pr-review',
  'governance',
  'pack-authoring',
];

function tailLines(s: string, n = 12): string {
  const lines = s.split(/\r?\n/);
  return lines.slice(-n).join('\n');
}

function copyDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  if (!existsSync(src)) return;
  for (const entry of readdirSync(src)) {
    if (entry === 'node_modules' || entry === '.sharkcraft' || entry.startsWith('.git')) continue;
    const from = nodePath.join(src, entry);
    const to = nodePath.join(dest, entry);
    let stat;
    try {
      stat = statSync(from);
    } catch {
      continue;
    }
    if (stat.isDirectory()) copyDir(from, to);
    else copyFileSync(from, to);
  }
}

function prepareFixture(scenarioId: SmokeScenarioId, dest: string, cwd: string): void {
  if (scenarioId === 'unconfigured-repo') {
    writeFileSync(
      nodePath.join(dest, 'package.json'),
      JSON.stringify({ name: 'smoke-fixture', version: '0.0.0', type: 'module' }, null, 2) + '\n',
      'utf8',
    );
    return;
  }
  if (scenarioId === 'pack-authoring') {
    writeFileSync(
      nodePath.join(dest, 'package.json'),
      JSON.stringify({ name: 'smoke-pack-root', version: '0.0.0', type: 'module' }, null, 2) + '\n',
      'utf8',
    );
    return;
  }
  // dev-workflow / pr-review / governance: copy dogfood-target.
  const dogfood = nodePath.join(cwd, 'examples', 'dogfood-target');
  copyDir(dogfood, dest);
}

function runStep(
  step: ISmokeStep,
  fixtureRoot: string,
  cliEntry: string,
  cwd: string,
  options: { assertionsEnabled: boolean } = { assertionsEnabled: true },
): ISmokeStepResult {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const expectArtifacts = step.expectArtifacts ?? [];
  const forbidArtifacts = step.forbidArtifacts ?? [];
  let exitCode: number | null = null;
  let stdoutTail = '';
  let stderrTail = '';
  let stdoutFull = '';
  let stderrFull = '';
  let status: ISmokeStepResult['status'] = 'pass';
  if (step.command[0] === '__fixture__:init-unconfigured' || step.command[0] === '__fixture__:init-empty-pack-root' || step.command[0] === '__fixture__:copy-dogfood') {
    // No-op (fixture preparation happens before steps run).
    exitCode = 0;
  } else {
    const bin = step.command[0] ?? '';
    const rest = step.command.slice(1);
    // The CLI is `bun packages/cli/src/main.ts` so rewrite `shrk …` → `bun <cliEntry> …`.
    const args: string[] = bin === 'shrk' ? [cliEntry, ...rest] : [cliEntry, ...rest];
    try {
      const result = spawnSync('bun', args, {
        cwd: fixtureRoot,
        env: { ...process.env, NO_COLOR: '1' },
        encoding: 'utf8',
        timeout: 60_000,
        stdio: 'pipe',
      });
      exitCode = result.status ?? null;
      stdoutFull = result.stdout ?? '';
      stderrFull = result.stderr ?? '';
      stdoutTail = tailLines(stdoutFull);
      stderrTail = tailLines(stderrFull);
      const allowed = step.allowedExitCodes ?? [0];
      if (exitCode == null || !allowed.includes(exitCode)) status = 'fail';
    } catch (e) {
      stderrTail = (e as Error).message;
      stderrFull = stderrTail;
      status = 'fail';
      exitCode = null;
    }
  }
  const present = collectFixtureFiles(fixtureRoot);
  const artifactsFound: string[] = [];
  const artifactsMissing: string[] = [];
  for (const rel of expectArtifacts) {
    if (present.includes(rel) || existsSync(nodePath.join(fixtureRoot, rel))) {
      artifactsFound.push(rel);
    } else {
      artifactsMissing.push(rel);
      if (status === 'pass') status = 'fail';
    }
  }
  const forbiddenArtifactsFound: string[] = [];
  for (const rel of forbidArtifacts) {
    if (existsSync(nodePath.join(fixtureRoot, rel))) {
      forbiddenArtifactsFound.push(rel);
      status = 'fail';
    }
  }
  let assertionResults: ISmokeAssertionResult[] | undefined;
  if (options.assertionsEnabled && step.assertions && step.assertions.length > 0) {
    assertionResults = step.assertions.map((a: ISmokeAssertion) =>
      evaluateSmokeAssertion({ assertion: a, stdout: stdoutFull, stderr: stderrFull, fixtureRoot }),
    );
    for (const r of assertionResults) {
      if (r.status === 'fail') status = 'fail';
    }
  }
  return {
    step,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startMs,
    exitCode,
    status,
    stdoutTail,
    stderrTail,
    artifactsFound,
    artifactsMissing,
    forbiddenArtifactsFound,
    ...(assertionResults ? { assertionResults } : {}),
  };
}

async function runScenario(
  scenario: ISmokeScenario,
  cwd: string,
  tempDir: string | null,
  keep: boolean,
  options: { assertionsEnabled: boolean; cliEntryRoot?: string } = { assertionsEnabled: true },
): Promise<ISmokeScenarioResult> {
  const fixture = createFixtureRoot({
    scenarioId: scenario.id,
    baseDir: tempDir ?? undefined,
    keep,
  });
  prepareFixture(scenario.id, fixture.fixtureRoot, options.cliEntryRoot ?? cwd);
  const cliRoot = options.cliEntryRoot ?? cwd;
  const cliEntry = nodePath.join(cliRoot, 'packages', 'cli', 'src', 'main.ts');
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const stepResults: ISmokeStepResult[] = [];
  for (const step of scenario.setup) {
    stepResults.push(runStep(step, fixture.fixtureRoot, cliEntry, cwd, options));
  }
  // Snapshot the fixture after setup so the safe-write audit only flags
  // files added or modified *during* the smoke steps, not pre-existing source
  // copied in for fixture preparation.
  const afterSetupSet = new Set(collectFixtureFiles(fixture.fixtureRoot));
  for (const step of scenario.steps) {
    const r = runStep(step, fixture.fixtureRoot, cliEntry, cwd, options);
    stepResults.push(r);
  }
  // Safety: assert no writes happened outside allowed prefixes (only newly-
  // created files count).
  const present = collectFixtureFiles(fixture.fixtureRoot);
  const newlyCreated = present.filter((f) => !afterSetupSet.has(f));
  const violations = assertSafeWrites(newlyCreated);
  if (violations.length > 0) {
    stepResults.push({
      step: { title: 'Safe-write audit', command: ['__safety_audit__'] },
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      exitCode: 1,
      status: 'fail',
      stdoutTail: '',
      stderrTail: `Files written outside allowed prefixes: ${violations.slice(0, 20).join(', ')}`,
      artifactsFound: [],
      artifactsMissing: [],
      forbiddenArtifactsFound: violations,
    });
  }
  const status: ISmokeScenarioResult['status'] = stepResults.some((s) => s.status === 'fail') ? 'fail' : 'pass';
  if (!keep) {
    try {
      rmSync(fixture.fixtureRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  return {
    scenarioId: scenario.id,
    fixtureRoot: fixture.fixtureRoot,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startMs,
    status,
    steps: stepResults,
  };
}

function resolveSmokeFlags(args: ParsedArgs): { assertionsEnabled: boolean } {
  const noAssertions = flagBool(args, 'no-assertions');
  return { assertionsEnabled: !noAssertions };
}

interface ISmokeTarget {
  id: string;
  cwd: string;
  label: string;
  warning?: string;
}

// Generic adopter target replaces the previous hardcoded project target.
const BUILTIN_TARGET_IDS = ['sharkcraft', 'dogfood', 'synthetic', 'adopter'] as const;
type BuiltinTargetId = (typeof BUILTIN_TARGET_IDS)[number];

function resolveTargets(
  cwd: string,
  args: ParsedArgs,
  requested: readonly string[],
): ISmokeTarget[] {
  const want = (id: BuiltinTargetId): boolean => requested.length === 0 || requested.includes(id);
  const out: ISmokeTarget[] = [];
  if (want('sharkcraft')) out.push({ id: 'sharkcraft', cwd, label: 'sharkcraft monorepo' });
  if (want('dogfood')) {
    const p = nodePath.join(cwd, 'examples', 'dogfood-target');
    if (existsSync(p)) out.push({ id: 'dogfood', cwd: p, label: 'examples/dogfood-target' });
    else out.push({ id: 'dogfood', cwd: p, label: 'examples/dogfood-target', warning: 'dogfood-target not present — skipped' });
  }
  if (want('synthetic')) {
    const root = nodePath.join(tmpdir(), `sharkcraft-smoke-synth-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      nodePath.join(root, 'package.json'),
      JSON.stringify({ name: 'sharkcraft-synth', version: '0.0.0', type: 'module' }, null, 2),
      'utf8',
    );
    out.push({ id: 'synthetic', cwd: root, label: 'synthetic-fixture' });
  }
  if (want('adopter')) {
    const adopterRoot =
      flagString(args, 'adopter-root') ??
      process.env['SHARKCRAFT_ADOPTER_ROOT'] ??
      '';
    if (adopterRoot && existsSync(adopterRoot)) {
      out.push({ id: 'adopter', cwd: adopterRoot, label: `adopter:${adopterRoot}` });
    } else {
      out.push({
        id: 'adopter',
        cwd: adopterRoot || '(unset)',
        label: 'adopter target',
        warning:
          'Adopter root not set (pass --adopter-root or set SHARKCRAFT_ADOPTER_ROOT) — skipped.',
      });
    }
  }
  return out;
}

async function runReleaseSmoke(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const scopeRaw = (flagString(args, 'scenario') ?? 'all') as SmokeScenarioId | 'all';
  if (scopeRaw !== 'all' && !SMOKE_SCENARIO_IDS.includes(scopeRaw)) {
    process.stderr.write(`Unknown --scenario "${scopeRaw}". Use all|${SMOKE_SCENARIO_IDS.join('|')}.\n`);
    return 2;
  }
  const tempDir = flagString(args, 'temp-dir') ?? null;
  const keep = flagBool(args, 'keep-temp');
  const flags = resolveSmokeFlags(args);
  const scenarios = pickScenarios(scopeRaw);
  const startMs = Date.now();

  // Matrix mode runs scenarios across multiple targets.
  const isMatrix = flagBool(args, 'matrix');
  const targetsRequested = (flagString(args, 'target') ?? '').split(',').filter(Boolean);
  if (!isMatrix && targetsRequested.length === 0) {
    const results: ISmokeScenarioResult[] = [];
    for (const s of scenarios) {
      const r = await runScenario(s, cwd, tempDir, keep, flags);
      results.push(r);
    }
    return emitSmokeReport(args, cwd, results, startMs);
  }
  const targets = resolveTargets(cwd, args, targetsRequested);
  const matrixResults: { target: ISmokeTarget; results: ISmokeScenarioResult[] }[] = [];
  for (const target of targets) {
    if (target.warning) {
      matrixResults.push({ target, results: [] });
      continue;
    }
    const scenariosForTarget = scenarios.filter((s) => isScenarioApplicableTo(s.id, target));
    const results: ISmokeScenarioResult[] = [];
    for (const s of scenariosForTarget) {
      // Always resolve the CLI entry from the SharkCraft monorepo (cwd),
      // even when the target has its own working tree.
      const r = await runScenario(s, target.cwd, tempDir, keep, { ...flags, cliEntryRoot: cwd });
      results.push(r);
    }
    matrixResults.push({ target, results });
  }
  return emitMatrixSmokeReport(args, cwd, matrixResults, startMs);
}

/**
 * Which smoke scenarios make sense for which target.
 *
 *  - `sharkcraft` runs everything (it's the source of truth).
 *  - `dogfood` runs dev-workflow / pr-review / governance because those copy
 *    examples/dogfood-target as the fixture.
 *  - `synthetic` runs the scenarios that don't depend on a prepared source
 *    (unconfigured-repo + pack-authoring).
 *  - `adopter` runs the read-only scenarios that don't write outside the
 *    fixture (e.g. an external project that consumes a SharkCraft pack).
 */
function isScenarioApplicableTo(scenario: SmokeScenarioId, target: ISmokeTarget): boolean {
  if (target.id === 'sharkcraft') return true;
  if (target.id === 'synthetic') {
    return scenario === 'unconfigured-repo' || scenario === 'pack-authoring';
  }
  if (target.id === 'dogfood') {
    return scenario === 'dev-workflow' || scenario === 'pr-review' || scenario === 'governance';
  }
  if (target.id === 'adopter') {
    return scenario === 'unconfigured-repo' || scenario === 'pack-authoring' || scenario === 'governance';
  }
  return true;
}

function emitSmokeReport(
  args: ParsedArgs,
  cwd: string,
  results: readonly ISmokeScenarioResult[],
  startMs: number,
): number {
  const passed = results.every((r) => r.status === 'pass');
  const report: IReleaseSmokeReport = {
    schema: 'sharkcraft.release-smoke/v1',
    generatedAt: new Date().toISOString(),
    scenarios: results,
    totalDurationMs: Date.now() - startMs,
    passed,
  };
  const wantJson = flagBool(args, 'json');
  const wantReport = flagBool(args, 'report');
  const wantHtml = flagBool(args, 'html');
  const outputDir = nodePath.join(cwd, '.sharkcraft', 'reports');
  if (wantReport || wantHtml) mkdirSync(outputDir, { recursive: true });
  if (wantReport) {
    writeFileSync(nodePath.join(outputDir, 'release-smoke.json'), renderSmokeReport(report, 'json'), 'utf8');
    writeFileSync(nodePath.join(outputDir, 'release-smoke.md'), renderSmokeReport(report, 'markdown'), 'utf8');
  }
  if (wantHtml) {
    writeFileSync(nodePath.join(outputDir, 'release-smoke.html'), renderSmokeReport(report, 'html'), 'utf8');
  }
  if (wantJson) {
    process.stdout.write(renderSmokeReport(report, 'json'));
  } else {
    process.stdout.write(renderSmokeReport(report, 'text'));
  }
  return passed ? 0 : 1;
}

function emitMatrixSmokeReport(
  args: ParsedArgs,
  cwd: string,
  matrix: readonly { target: ISmokeTarget; results: readonly ISmokeScenarioResult[] }[],
  startMs: number,
): number {
  const targetReports = matrix.map((entry) => {
    const passed = entry.results.length > 0 && entry.results.every((r) => r.status === 'pass');
    return {
      target: { id: entry.target.id, label: entry.target.label, cwd: entry.target.cwd, warning: entry.target.warning ?? null },
      passed,
      scenarios: entry.results.map((r) => ({
        scenarioId: r.scenarioId,
        status: r.status,
        durationMs: r.durationMs,
      })),
    };
  });
  const overallPassed = targetReports
    .filter((t) => !t.target.warning)
    .every((t) => t.passed);
  const totalDurationMs = Date.now() - startMs;
  const payload = {
    schema: 'sharkcraft.release-smoke-matrix/v1',
    generatedAt: new Date().toISOString(),
    totalDurationMs,
    passed: overallPassed,
    targets: targetReports,
  };
  const wantJson = flagBool(args, 'json');
  const wantReport = flagBool(args, 'report');
  const outputDir = nodePath.join(cwd, '.sharkcraft', 'reports');
  if (wantReport) {
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(nodePath.join(outputDir, 'release-smoke-matrix.json'), JSON.stringify(payload, null, 2) + '\n', 'utf8');
  }
  if (wantJson) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else {
    process.stdout.write(`# Release smoke matrix — ${overallPassed ? 'PASS' : 'FAIL'}\n`);
    for (const t of targetReports) {
      if (t.target.warning) {
        process.stdout.write(`  ⚠ ${t.target.label}: ${t.target.warning}\n`);
        continue;
      }
      process.stdout.write(`  ${t.passed ? '✓' : '✗'} ${t.target.label}\n`);
      for (const s of t.scenarios) {
        process.stdout.write(`    ${s.status === 'pass' ? '✓' : '✗'} ${s.scenarioId} (${s.durationMs}ms)\n`);
      }
    }
  }
  return overallPassed ? 0 : 1;
}

async function runInstallSmokeTarball(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const baseTemp = flagString(args, 'temp-dir') ?? tmpdir();
  const tarballDir = nodePath.join(baseTemp, `sharkcraft-tarball-${Date.now()}`);
  mkdirSync(tarballDir, { recursive: true });
  const log: { step: string; status: 'pass' | 'fail' | 'skipped'; exitCode: number | null; durationMs: number; detail?: string }[] = [];
  const runStepSh = (
    bin: string,
    bargs: readonly string[],
    spawnOpts: { cwd: string; env?: NodeJS.ProcessEnv; timeout?: number } = { cwd: tarballDir },
  ): { status: 'pass' | 'fail'; exitCode: number | null; stdout: string; stderr: string } => {
    const result = spawnSync(bin, bargs, {
      cwd: spawnOpts.cwd,
      env: { ...process.env, NO_COLOR: '1', ...(spawnOpts.env ?? {}) },
      encoding: 'utf8',
      timeout: spawnOpts.timeout ?? 120_000,
      stdio: 'pipe',
    });
    const exit = result.status ?? null;
    return {
      status: exit === 0 ? 'pass' : 'fail',
      exitCode: exit,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  };
  // 1. Use the existing install-smoke-test script which already does this dance.
  const t0 = Date.now();
  const smoke = runStepSh('bun', ['run', 'release:smoke-test'], { cwd, timeout: 600_000 });
  log.push({
    step: 'release:smoke-test',
    status: smoke.status,
    exitCode: smoke.exitCode,
    durationMs: Date.now() - t0,
    detail: smoke.status === 'fail' ? smoke.stderr.split(/\r?\n/).slice(-8).join('\n') : undefined,
  });
  const ok = log.every((l) => l.status !== 'fail');
  const payload = {
    schema: 'sharkcraft.install-smoke-tarball/v1',
    generatedAt: new Date().toISOString(),
    tarballDir,
    ok,
    log,
    note: 'Delegates to `bun run release:smoke-test` so the tarball install path stays canonical.',
  };
  if (flagBool(args, 'json')) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return ok ? 0 : 1;
  }
  process.stdout.write(`# Install smoke (tarball) — ${ok ? 'OK' : 'FAIL'}\n`);
  for (const l of log) {
    process.stdout.write(`  ${l.status} ${l.step.padEnd(28)} exit=${l.exitCode ?? '?'} (${l.durationMs}ms)\n`);
    if (l.detail) process.stdout.write(`    ↳ ${l.detail.replace(/\n/g, '\n    ↳ ')}\n`);
  }
  return ok ? 0 : 1;
}

async function runInstallSmoke(args: ParsedArgs): Promise<number> {
  if (flagBool(args, 'tarball')) {
    return runInstallSmokeTarball(args);
  }
  const cwd = resolveCwd(args);
  const cliEntry = nodePath.join(cwd, 'packages', 'cli', 'src', 'main.ts');
  const isRepo = existsSync(cliEntry);
  const stepResults: IInstallSmokeStepResult[] = [];
  for (const step of getInstallSmokePlan()) {
    const start = Date.now();
    if (step.requiresRepo && !isRepo) {
      stepResults.push({
        step,
        status: 'skipped',
        exitCode: null,
        durationMs: 0,
        stdoutTail: '',
        stderrTail: '',
        reason: 'not running inside the SharkCraft repo',
      });
      continue;
    }
    const bin = step.command[0] ?? '';
    const rest = step.command.slice(1);
    const cmdArgs = bin === 'shrk' && isRepo ? [cliEntry, ...rest] : rest;
    const binToRun = bin === 'shrk' && isRepo ? 'bun' : bin;
    try {
      const result = spawnSync(binToRun, cmdArgs, {
        cwd,
        env: { ...process.env, NO_COLOR: '1' },
        encoding: 'utf8',
        timeout: 60_000,
        stdio: 'pipe',
      });
      const exit = result.status ?? null;
      const okExit = exit === 0;
      stepResults.push({
        step,
        status: okExit ? 'pass' : step.optional ? 'pass' : 'fail',
        exitCode: exit,
        durationMs: Date.now() - start,
        stdoutTail: tailLines(result.stdout ?? ''),
        stderrTail: tailLines(result.stderr ?? ''),
        ...(okExit ? {} : step.optional ? { reason: 'optional step failed; ignored' } : {}),
      });
    } catch (e) {
      stepResults.push({
        step,
        status: step.optional ? 'pass' : 'fail',
        exitCode: null,
        durationMs: Date.now() - start,
        stdoutTail: '',
        stderrTail: (e as Error).message,
        ...(step.optional ? { reason: 'optional step errored; ignored' } : {}),
      });
    }
  }
  const ok = stepResults.every((r) => r.status !== 'fail');
  const report: IInstallSmokeReport = {
    schema: 'sharkcraft.install-smoke/v1',
    generatedAt: new Date().toISOString(),
    projectRoot: cwd,
    isSharkcraftRepo: isRepo,
    steps: stepResults,
    ok,
  };
  if (flagBool(args, 'json')) {
    process.stdout.write(asJson(report) + '\n');
    return ok ? 0 : 1;
  }
  process.stdout.write(header(`Install smoke — ${ok ? 'OK' : 'FAIL'}`));
  for (const r of stepResults) {
    process.stdout.write(`  ${r.status.padEnd(8)} ${r.step.title.padEnd(30)} exit=${r.exitCode ?? '?'}${r.reason ? ' (' + r.reason + ')' : ''}\n`);
  }
  return ok ? 0 : 1;
}

async function runReadiness(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const inspection = await inspectSharkcraft({ cwd });
  const strict = flagBool(args, 'strict');
  const preflightRaw = flagString(args, 'preflight');
  const includeDocsCheck = flagBool(args, 'with-docs-check') || flagBool(args, 'include-docs-check');
  const includeExamplesCheck = flagBool(args, 'with-examples-check') || flagBool(args, 'include-examples-check');
  const includeProductCheck = flagBool(args, 'with-product-check');
  // Optional knowledge stale-check gate.
  const includeKnowledgeCheck = flagBool(args, 'with-knowledge-check');
  const report = await buildReleaseReadiness(inspection, {
    strict,
    ...(preflightRaw ? { preflightSummaryFile: preflightRaw } : {}),
    includeDocsCheck,
    includeExamplesCheck,
  });
  if (includeProductCheck) {
    const { buildProductCoherenceReport } = await import('@shrkcrft/inspector');
    const productReport = buildProductCoherenceReport(inspection, { strict });
    // Fold a single advisory line into readiness output via JSON only.
    (report as unknown as { productCheck?: unknown }).productCheck = productReport;
    if (!productReport.passed) {
      (report as { ready: boolean }).ready = false;
    }
  }
  // Knowledge stale-check.
  const cfgKnowledge =
    (inspection.config as { knowledgeCheck?: { enabled?: boolean; strict?: boolean; failOn?: readonly string[] } } | null)
      ?.knowledgeCheck;
  if (includeKnowledgeCheck || cfgKnowledge?.enabled) {
    const { buildKnowledgeStaleReport, ReferenceCheckOutcome } = await import('@shrkcrft/inspector');
    const staleReport = buildKnowledgeStaleReport(inspection);
    let requiredFailing = 0;
    for (const c of staleReport.referenceChecks) {
      const isRequired = (c.reference as { required?: boolean }).required === true;
      if (
        isRequired &&
        (c.outcome === ReferenceCheckOutcome.Stale || c.outcome === ReferenceCheckOutcome.Missing)
      ) {
        requiredFailing++;
      }
    }
    const knowledgeStrict = cfgKnowledge?.strict ?? strict;
    const knowledgeReady =
      requiredFailing === 0 &&
      (!knowledgeStrict || staleReport.counts.stale === 0);
    (report as unknown as { knowledgeCheck?: unknown }).knowledgeCheck = {
      enabled: true,
      strict: knowledgeStrict,
      counts: staleReport.counts,
      requiredFailing,
      ready: knowledgeReady,
    };
    if (!knowledgeReady) {
      (report as { ready: boolean }).ready = false;
    }
  }
  const wantHtml = flagBool(args, 'html');
  const wantReport = flagBool(args, 'report');
  if (wantReport) {
    const outDir = nodePath.join(cwd, '.sharkcraft', 'reports');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(nodePath.join(outDir, 'release-readiness.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
    if (wantHtml) {
      writeFileSync(nodePath.join(outDir, 'release-readiness.html'), renderReleaseReadinessHtml(report), 'utf8');
    }
  }
  if (flagBool(args, 'json')) {
    process.stdout.write(asJson(report) + '\n');
    return report.ready ? 0 : 1;
  }
  if (wantHtml && !wantReport) {
    process.stdout.write(renderReleaseReadinessHtml(report));
    return report.ready ? 0 : 1;
  }
  process.stdout.write(header(`Release readiness (${strict ? 'strict' : 'lenient'})`));
  process.stdout.write(kv('ready', report.ready ? 'yes' : 'no') + '\n');
  process.stdout.write(kv('blockers', String(report.blockers.length)) + '\n');
  process.stdout.write(kv('warnings', String(report.warnings.length)) + '\n');
  process.stdout.write(kv('passed', String(report.passed.length)) + '\n');
  process.stdout.write(kv('skipped', String(report.skipped.length)) + '\n\n');
  const order = [report.blockers, report.warnings, report.passed, report.skipped];
  for (const group of order) {
    for (const c of group) {
      const tag =
        c.severity === ReleaseReadinessSeverity.Error
          ? 'BLOCK'
          : c.severity === ReleaseReadinessSeverity.Warning
            ? 'WARN '
            : c.status === 'skipped'
              ? 'SKIP '
              : 'OK   ';
      process.stdout.write(`  ${tag} ${c.id.padEnd(22)} ${c.title.padEnd(32)} ${c.message}\n`);
      if (c.suggestion) process.stdout.write(`         ↳ ${c.suggestion}\n`);
    }
  }
  process.stdout.write('\nChecklist:\n');
  for (const item of report.checklist) process.stdout.write(`  • ${item}\n`);
  process.stdout.write(`\nVerdict: ${report.ready ? 'READY ✓' : 'NOT READY — see blockers above'}\n`);
  void readFileSync;
  return report.ready ? 0 : 1;
}

export const releaseCommand: ICommandHandler = {
  name: 'release',
  description: 'Release readiness aggregator + smoke harness. Read-only verdicts; smoke writes only into temp fixtures.',
  usage:
    'shrk release readiness [--strict] [--preflight <file|dir|auto>] [--html] [--report] [--json] [--with-docs-check] [--with-examples-check]\n  shrk release smoke [--scenario all|<id>] [--temp-dir <path>] [--keep-temp] [--json] [--report] [--html]',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    if (sub === 'smoke') return runReleaseSmoke({ ...args, positional: args.positional.slice(1) });
    if (sub === 'readiness') return runReadiness({ ...args, positional: args.positional.slice(1) });
    process.stderr.write('Usage: shrk release readiness | smoke\n');
    return 2;
  },
};

export const installSmokeCommand: ICommandHandler = {
  name: 'smoke',
  description: 'Verify the installed CLI surface (read-only).',
  usage: 'shrk install smoke [--json]',
  run: runInstallSmoke,
};
