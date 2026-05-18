#!/usr/bin/env bun
// publish-dry-run: build each public package's dist, switch its package.json
// to publish mode, run `npm pack --dry-run`, then restore the dev package.json.
// Reports the tarball contents + size per package. Does NOT publish.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  discoverPackages,
  versionsByName,
  withPublishMode,
} from './lib/publish-mode.ts';

const ROOT = process.cwd();
const PACKAGES_DIR = join(ROOT, 'packages');

interface IPackResult {
  short: string;
  ok: boolean;
  tarball: string;
  size: number;
  unpackedSize: number;
  files: number;
  error?: string;
}

async function packPackage(
  short: string,
  dir: string,
  versionByName: ReadonlyMap<string, string>,
): Promise<IPackResult> {
  return withPublishMode(dir, versionByName, () => {
    const res = spawnSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = res.stdout?.toString('utf8') ?? '';
    const stderr = res.stderr?.toString('utf8') ?? '';
    if (res.status !== 0) {
      return {
        short,
        ok: false,
        tarball: '',
        size: 0,
        unpackedSize: 0,
        files: 0,
        error: stderr.trim() || 'npm pack failed',
      };
    }
    let parsed: any = null;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return {
        short,
        ok: false,
        tarball: '',
        size: 0,
        unpackedSize: 0,
        files: 0,
        error: 'unparseable pack output',
      };
    }
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    return {
      short,
      ok: true,
      tarball: entry.filename ?? '',
      size: entry.size ?? 0,
      unpackedSize: entry.unpackedSize ?? 0,
      files: Array.isArray(entry.files) ? entry.files.length : 0,
    };
  });
}

const packages = discoverPackages(PACKAGES_DIR).filter((p) => !p.private);

// Verify dist exists for all of them (build was run first). Packages that
// publish a browser bundle (e.g. dashboard) ship index.html instead of
// index.js — accept either.
import { existsSync } from 'node:fs';
const missing = packages.filter((p) => {
  const dist = join(p.dir, 'dist');
  return !existsSync(join(dist, 'index.js')) && !existsSync(join(dist, 'index.html'));
});
if (missing.length > 0) {
  process.stderr.write(
    `[publish-dry-run] missing dist for: ${missing.map((p) => p.short).join(', ')}\n` +
      'Run `bun run scripts/build-dist.ts` first.\n',
  );
  process.exit(1);
}

const versionByName = versionsByName(packages);
const results: IPackResult[] = [];
for (const p of packages) {
  process.stdout.write(`[pack] ${p.short}\n`);
  results.push(await packPackage(p.short, p.dir, versionByName));
}

process.stdout.write('\n[publish-dry-run] summary\n---\n');
process.stdout.write(
  `${'package'.padEnd(15)}  ${'tarball'.padEnd(28)}  ${'files'.padStart(5)}  ${'tar'.padStart(8)}  unpacked\n`,
);
let totalTar = 0;
let totalUnpacked = 0;
let failed = 0;
for (const r of results) {
  if (!r.ok) {
    process.stderr.write(`  ${r.short.padEnd(15)} FAILED — ${r.error ?? ''}\n`);
    failed += 1;
    continue;
  }
  totalTar += r.size;
  totalUnpacked += r.unpackedSize;
  process.stdout.write(
    `  ${r.short.padEnd(15)}  ${r.tarball.padEnd(28)}  ${String(r.files).padStart(5)}  ${formatBytes(r.size).padStart(8)}  ${formatBytes(r.unpackedSize)}\n`,
  );
}
process.stdout.write('---\n');
process.stdout.write(
  `${'TOTAL'.padEnd(15)}  ${''.padEnd(28)}  ${''.padStart(5)}  ${formatBytes(totalTar).padStart(8)}  ${formatBytes(totalUnpacked)}\n`,
);
if (failed > 0) {
  process.stderr.write(`\n[publish-dry-run] ${failed} package(s) failed.\n`);
  process.exit(1);
}
process.stdout.write('\n[publish-dry-run] ok (no tarballs written; no publishing happened)\n');

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(2)}M`;
}
