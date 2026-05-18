#!/usr/bin/env bun
// Placeholder lint: ensures every library package has a src/index.ts and package.json.
// Bundle-style packages (Vite apps, etc.) are skipped via the "bundle" mark in package.json.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const packagesDir = join(root, 'packages');
const packages = readdirSync(packagesDir).filter((d) =>
  statSync(join(packagesDir, d)).isDirectory(),
);

let issues = 0;
for (const pkg of packages) {
  const pkgJson = join(packagesDir, pkg, 'package.json');
  if (!existsSync(pkgJson)) {
    process.stderr.write(`[lint] missing package.json: packages/${pkg}\n`);
    issues += 1;
    continue;
  }
  const manifest = JSON.parse(readFileSync(pkgJson, 'utf8')) as {
    main?: string;
    sharkcraft?: { bundle?: boolean };
  };
  // Skip bundle-style packages (Vite apps) — they don't ship a library entry.
  const isBundle = manifest.sharkcraft?.bundle === true || manifest.main?.endsWith('.html');
  if (isBundle) continue;
  const index = join(packagesDir, pkg, 'src/index.ts');
  if (!existsSync(index)) {
    process.stderr.write(`[lint] missing src/index.ts: packages/${pkg}\n`);
    issues += 1;
  }
}
if (issues > 0) process.exit(1);
process.stdout.write('[lint] ok\n');
