#!/usr/bin/env bun
// Lightweight build that runs `tsc --noEmit` per package so we surface type errors per package.
// SharkCraft ships source directly (Bun resolves .ts paths), so we don't emit .js by default.

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runWorkspaceLinkGate } from './lib/workspace-links.ts';

const root = process.cwd();

// Round 13 (13.2): tsc below resolves every @shrkcrft/* import through the
// base tsconfig's paths and never consults node_modules, so an unlinked or
// undeclared workspace dependency typechecks green here and dies under node at
// runtime. Refuse it first (exit 1, naming the dependency and the fix).
if (runWorkspaceLinkGate(root, '[build]') !== 0) process.exit(1);
const packagesDir = join(root, 'packages');
const packages = readdirSync(packagesDir).filter((d) =>
  statSync(join(packagesDir, d)).isDirectory(),
);

let failed = 0;
for (const pkg of packages) {
  const tsconfig = join(packagesDir, pkg, 'tsconfig.json');
  if (!existsSync(tsconfig)) continue;
  process.stdout.write(`[build] ${pkg}\n`);
  const res = spawnSync('bun', ['x', 'tsc', '--noEmit', '-p', tsconfig], {
    cwd: root,
    stdio: 'inherit',
  });
  if (res.status !== 0) {
    failed += 1;
  }
}

if (failed > 0) {
  process.stderr.write(`[build] ${failed} package(s) failed typecheck\n`);
  process.exit(1);
}
process.stdout.write('[build] ok\n');
