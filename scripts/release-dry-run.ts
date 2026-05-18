#!/usr/bin/env bun
// release-dry-run: runs the full release validation chain.
//   1. tsc --noEmit
//   2. bun test
//   3. build-dist
//   4. publish-dry-run
//   5. check-publish-readiness
//
// Stops at the first failing step. Does NOT publish anything.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = process.cwd();

interface IStep {
  name: string;
  cmd: string;
  args: readonly string[];
}

const STEPS: readonly IStep[] = [
  { name: 'typecheck', cmd: 'bun', args: ['x', 'tsc', '-p', 'tsconfig.base.json', '--noEmit'] },
  { name: 'tests', cmd: 'bun', args: ['test'] },
  { name: 'build-dist', cmd: 'bun', args: ['run', 'scripts/build-dist.ts'] },
  { name: 'publish-dry-run', cmd: 'bun', args: ['run', 'scripts/publish-dry-run.ts'] },
  { name: 'check-publish-readiness', cmd: 'bun', args: ['run', 'scripts/check-publish-readiness.ts'] },
];

let failedAt: string | null = null;
const stepResults: Array<{ name: string; ok: boolean; durationMs: number }> = [];

for (const step of STEPS) {
  const t0 = Date.now();
  process.stdout.write(`\n[release-dry-run] ▶ ${step.name}\n`);
  const res = spawnSync(step.cmd, step.args, { cwd: ROOT, stdio: 'inherit' });
  const durationMs = Date.now() - t0;
  const ok = res.status === 0;
  stepResults.push({ name: step.name, ok, durationMs });
  if (!ok) {
    failedAt = step.name;
    break;
  }
}

process.stdout.write('\n[release-dry-run] summary\n---\n');
for (const r of stepResults) {
  const label = r.ok ? 'OK' : 'FAIL';
  process.stdout.write(`  ${label.padEnd(4)} ${r.name.padEnd(28)} ${r.durationMs}ms\n`);
}
if (failedAt) {
  process.stdout.write(`---\n[release-dry-run] FAILED at "${failedAt}"\n`);
  process.exit(1);
}
process.stdout.write('---\n[release-dry-run] ready for release ✓\n');
process.stdout.write('No tarballs were published; rerun the publish step manually when ready.\n');
