#!/usr/bin/env bun
// bump-versions: update every packages/<name>/package.json to a new version.
// Also updates internal "@shrkcrft/*" workspace pins (only if they were not
// already "workspace:*", which is the dev default).
//
// Usage:
//   bun run scripts/bump-versions.ts <version> [--dry-run] [--write]
//
// One of --dry-run or --write must be passed. --dry-run is the default.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const PACKAGES_DIR = join(ROOT, 'packages');

function isSemverish(input: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.\-]+)?$/.test(input);
}

interface Args {
  version: string;
  write: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0]?.startsWith('-')) {
    process.stderr.write('Usage: bump-versions <version> [--dry-run|--write]\n');
    process.exit(2);
  }
  const version = argv[0]!;
  if (!isSemverish(version)) {
    process.stderr.write(`Invalid version: "${version}". Use e.g. 0.1.0-alpha.2\n`);
    process.exit(2);
  }
  const write = argv.includes('--write');
  const dry = argv.includes('--dry-run');
  if (write && dry) {
    process.stderr.write('Pass either --write or --dry-run (not both).\n');
    process.exit(2);
  }
  // Default to dry-run when neither flag is given.
  return { version, write };
}

interface IPkgUpdate {
  short: string;
  name: string;
  oldVersion: string;
  newVersion: string;
  pinUpdates: { dep: string; oldPin: string; newPin: string }[];
}

function bumpFile(pkgPath: string, version: string, write: boolean): IPkgUpdate | null {
  const raw = readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(raw) as {
    name: string;
    version: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };

  const short = pkg.name.startsWith('@shrkcrft/')
    ? pkg.name.slice('@shrkcrft/'.length)
    : pkg.name;
  const pinUpdates: IPkgUpdate['pinUpdates'] = [];

  // Update internal workspace deps only if the user already pinned a version
  // (e.g. "^0.1.0"). Leave "workspace:*" alone — that's the dev default.
  for (const block of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
    const deps = pkg[block];
    if (!deps) continue;
    for (const dep of Object.keys(deps)) {
      if (!dep.startsWith('@shrkcrft/')) continue;
      const oldPin = deps[dep]!;
      if (oldPin === 'workspace:*' || oldPin === 'workspace:^') continue;
      const newPin = `^${version}`;
      if (oldPin === newPin) continue;
      pinUpdates.push({ dep, oldPin, newPin });
      if (write) deps[dep] = newPin;
    }
  }

  if (pkg.version === version && pinUpdates.length === 0) return null;

  const update: IPkgUpdate = {
    short,
    name: pkg.name,
    oldVersion: pkg.version,
    newVersion: version,
    pinUpdates,
  };

  if (write) {
    pkg.version = version;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  }
  return update;
}

const { version, write } = parseArgs();

const packages = readdirSync(PACKAGES_DIR).filter((d) =>
  statSync(join(PACKAGES_DIR, d)).isDirectory(),
);

const updates: IPkgUpdate[] = [];
for (const short of packages) {
  const pkgPath = join(PACKAGES_DIR, short, 'package.json');
  try {
    statSync(pkgPath);
  } catch {
    continue;
  }
  const u = bumpFile(pkgPath, version, write);
  if (u) updates.push(u);
}

// Keep @shrkcrft/shared SHARKCRAFT_VERSION in sync — it powers `shrk version`.
function syncSharedVersionConstant(targetVersion: string, write: boolean): boolean {
  const p = join(PACKAGES_DIR, 'shared', 'src', 'index.ts');
  try {
    const raw = readFileSync(p, 'utf8');
    const re = /export const SHARKCRAFT_VERSION\s*=\s*'([^']+)';/;
    const match = raw.match(re);
    if (!match) return false;
    if (match[1] === targetVersion) return false;
    const next = raw.replace(re, `export const SHARKCRAFT_VERSION = '${targetVersion}';`);
    if (write) writeFileSync(p, next, 'utf8');
    process.stdout.write(
      `  shared/src/index.ts SHARKCRAFT_VERSION  ${match[1]}  →  ${targetVersion}\n`,
    );
    return true;
  } catch {
    return false;
  }
}
syncSharedVersionConstant(version, write);

if (updates.length === 0) {
  process.stdout.write(`No package needed an update (target version ${version}).\n`);
  process.exit(0);
}

const mode = write ? 'WRITE' : 'DRY-RUN';
process.stdout.write(`[${mode}] target version: ${version}\n`);
process.stdout.write(`${'package'.padEnd(15)}  ${'old'.padEnd(18)}  →  new\n---\n`);
for (const u of updates) {
  process.stdout.write(
    `  ${u.short.padEnd(15)}  ${u.oldVersion.padEnd(18)}  →  ${u.newVersion}\n`,
  );
  for (const p of u.pinUpdates) {
    process.stdout.write(
      `    pin ${p.dep.padEnd(28)} ${p.oldPin.padEnd(15)} → ${p.newPin}\n`,
    );
  }
}
process.stdout.write('---\n');
if (!write) {
  process.stdout.write('Re-run with --write to apply.\n');
}
