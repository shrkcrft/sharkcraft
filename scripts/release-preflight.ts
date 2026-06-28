#!/usr/bin/env bun
// release-preflight: full chain that gates a v0.1.0-alpha.N tag.
//
// Runs each step in order, captures the exit code, surfaces a final summary,
// and exits non-zero if any step fails. Intended to be the one command a
// release engineer runs on a clean checkout before tagging.
import { spawnSync } from 'node:child_process';

interface IStep {
  name: string;
  cmd: string;
  args: readonly string[];
  /** When true, a failure here aborts the rest of the chain. */
  required: boolean;
}

interface IStepResult {
  step: IStep;
  status: 'ok' | 'failed' | 'skipped';
  durationMs: number;
  exitCode: number | null;
}

const withNodeCompat = process.argv.includes('--with-node-compat');
const withE2E = process.argv.includes('--with-e2e');

// Resolve `shrk` to the local workspace CLI (`bun packages/cli/src/main.ts …`)
// so preflight runs against THIS repo's engine instead of whatever the global
// `shrk` binary on PATH happens to point at. Important when dogfooding on a
// machine that has shrk linked from another monorepo.
const LOCAL_SHRK = ['packages/cli/src/main.ts'];

const STEPS: readonly IStep[] = [
  { name: 'typecheck', cmd: 'bun', args: ['x', 'tsc', '-p', 'tsconfig.base.json', '--noEmit'], required: true },
  // R37: hard-gate on import-hygiene errors. `shrk check imports` exits
  // non-zero on any `error`-severity finding, including lazy
  // `require('node:*')`. Warnings (dynamic imports) do not block.
  { name: 'import-hygiene', cmd: 'bun', args: [...LOCAL_SHRK, 'check', 'imports'], required: true },
  // R58 — `docs/schemas/` must mirror the in-memory schema registry.
  // Run `shrk schemas emit --write` to refresh.
  { name: 'schemas-drift', cmd: 'bun', args: [...LOCAL_SHRK, 'schemas', 'emit', '--check'], required: true },
  // R58 — every doctor verb must emit parseable JSON on --json, including
  // error paths. Regressions surface here.
  { name: 'doctor-json-audit', cmd: 'bun', args: ['run', 'audit:doctor-json'], required: true },
  // --timeout 30000: spawn-based integration tests shell out to a full
  // `bun main.ts <cmd>` (the helpers cap that at 60s via spawnSync). Under the
  // load of a full release run those spawns can exceed Bun's default 5s
  // per-test timeout, producing flaky "timed out after 5000ms" failures that
  // are not real regressions. 30s gives ample headroom while still catching a
  // genuine hang. Keep in sync with the `test` script + ci.yml.
  { name: 'tests', cmd: 'bun', args: ['test', '--timeout', '30000'], required: true },
  { name: 'build-dist', cmd: 'bun', args: ['run', 'build:dist'], required: true },
  { name: 'dashboard-build', cmd: 'bun', args: ['run', 'dashboard:build'], required: true },
  { name: 'publish-dry-run', cmd: 'bun', args: ['run', 'publish:dry-run'], required: true },
  { name: 'release-check', cmd: 'bun', args: ['run', 'release:check'], required: false },
  { name: 'install-smoke-test', cmd: 'bun', args: ['run', 'release:smoke-test'], required: false },
  // Node compatibility audit. Always runs as a non-blocking warning gate so we
  // surface Bun.* regressions in production source without breaking the
  // release. Pass --with-node-compat to additionally probe the built dist
  // under node (still non-blocking).
  { name: 'compat-node', cmd: 'bun', args: ['run', 'compat:node'], required: false },
  ...(withNodeCompat
    ? [
        {
          name: 'compat-node-runtime',
          cmd: 'bun',
          args: ['run', 'scripts/compat-node.ts', '--runtime', '--cli'] as readonly string[],
          required: false,
        },
      ]
    : []),
  // Playwright dashboard E2E. Opt-in via --with-e2e because the suite
  // requires `bun run e2e:install` (downloads Chromium) and adds ~30s to
  // the run. Treated as non-blocking by design until proven stable in CI.
  ...(withE2E
    ? [
        {
          name: 'dashboard-e2e',
          cmd: 'bun',
          args: ['run', 'test:e2e:dashboard'] as readonly string[],
          required: false,
        },
      ]
    : []),
];

const results: IStepResult[] = [];
let aborted = false;

for (const step of STEPS) {
  if (aborted) {
    results.push({ step, status: 'skipped', durationMs: 0, exitCode: null });
    continue;
  }
  process.stdout.write(`\n=== ${step.name} ===\n`);
  const start = Date.now();
  const res = spawnSync(step.cmd, [...step.args], { stdio: 'inherit' });
  const durationMs = Date.now() - start;
  if (res.status === 0) {
    results.push({ step, status: 'ok', durationMs, exitCode: 0 });
    continue;
  }
  results.push({ step, status: 'failed', durationMs, exitCode: res.status ?? -1 });
  if (step.required) {
    aborted = true;
  }
}

process.stdout.write('\n=== Preflight summary ===\n');
let failed = 0;
let skipped = 0;
for (const r of results) {
  const tag =
    r.status === 'ok'
      ? 'OK     '
      : r.status === 'failed'
        ? 'FAILED '
        : 'SKIPPED';
  process.stdout.write(
    `  ${tag} ${r.step.name.padEnd(22)} ${`${r.durationMs}ms`.padStart(8)}` +
      (r.exitCode !== null && r.status !== 'ok' ? `  (exit ${r.exitCode})` : '') +
      '\n',
  );
  if (r.status === 'failed') failed += 1;
  if (r.status === 'skipped') skipped += 1;
}

if (failed > 0) {
  process.stdout.write(
    `\n[release-preflight] ${failed} step(s) failed, ${skipped} skipped — NOT ready to tag.\n`,
  );
  process.exit(1);
}
process.stdout.write('\n[release-preflight] all required steps passed ✓ — ready to tag\n');
