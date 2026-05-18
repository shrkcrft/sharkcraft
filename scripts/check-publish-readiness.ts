#!/usr/bin/env bun
// check-publish-readiness: verifies each public package meets minimum
// publish-time requirements. Does NOT swap main/types/exports — that lives in
// publish-dry-run.ts.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

interface IPkgJson {
  name?: string;
  version?: string;
  description?: string;
  license?: string;
  repository?: unknown;
  main?: string;
  types?: string;
  exports?: unknown;
  bin?: unknown;
  files?: string[];
  private?: boolean;
  publishConfig?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface IIssue {
  severity: 'error' | 'warning';
  pkg: string;
  message: string;
}

const ROOT = process.cwd();
const PACKAGES_DIR = join(ROOT, 'packages');

const packages = readdirSync(PACKAGES_DIR).filter((d) =>
  statSync(join(PACKAGES_DIR, d)).isDirectory(),
);

const issues: IIssue[] = [];

function check(short: string): void {
  const pkgPath = join(PACKAGES_DIR, short, 'package.json');
  if (!existsSync(pkgPath)) return;
  let pkg: IPkgJson;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as IPkgJson;
  } catch (e) {
    issues.push({ severity: 'error', pkg: short, message: `package.json parse error: ${(e as Error).message}` });
    return;
  }
  const name = pkg.name ?? short;

  // Private packages opt out of publishing entirely — skip all checks.
  if (pkg.private === true) return;

  if (!pkg.description) issues.push({ severity: 'error', pkg: name, message: 'description missing' });
  if (!pkg.license) issues.push({ severity: 'error', pkg: name, message: 'license missing' });
  if (!pkg.repository) issues.push({ severity: 'error', pkg: name, message: 'repository missing' });
  if (!pkg.exports && !pkg.main) {
    issues.push({ severity: 'error', pkg: name, message: 'neither exports nor main' });
  }
  if (!pkg.files || pkg.files.length === 0) {
    issues.push({ severity: 'warning', pkg: name, message: 'files[] missing (will publish entire dir)' });
  } else if (!pkg.files.includes('dist') && !pkg.files.includes('src')) {
    issues.push({
      severity: 'warning',
      pkg: name,
      message: 'files[] should include "dist" (publish mode) or "src" (dev mode)',
    });
  }
  if (pkg.private === true) {
    // Private packages can opt out of publishing; that's fine.
    return;
  }
  if (!pkg.publishConfig) {
    issues.push({ severity: 'warning', pkg: name, message: 'publishConfig missing (recommend access:"public" for @scope/* packages)' });
  } else if (
    pkg.publishConfig.access !== 'public' &&
    pkg.name?.startsWith('@')
  ) {
    issues.push({
      severity: 'warning',
      pkg: name,
      message: 'scoped package without publishConfig.access:"public" will fail npm publish',
    });
  }

  // Internal pin sanity: workspace:* is the dev default. After bumping
  // versions for a real release, those should be replaced with ^<version>.
  const allDeps: Record<string, string> = {
    ...(pkg.dependencies),
    ...(pkg.peerDependencies),
  };
  for (const [dep, pin] of Object.entries(allDeps)) {
    if (!dep.startsWith('@shrkcrft/')) continue;
    if (pin === 'workspace:*' || pin === 'workspace:^') {
      issues.push({
        severity: 'warning',
        pkg: name,
        message: `internal pin "${dep}: ${pin}" is dev-only — run \`bun run bump-versions <v> --write\` before publishing`,
      });
    }
  }

  // Recommend that the CLI/MCP packages publish dist (bin should point to dist/main.js).
  const bin = pkg.bin;
  if (bin) {
    const binEntries: Record<string, string> = typeof bin === 'string' ? { [name]: bin } : (bin as Record<string, string>);
    for (const [binName, binTarget] of Object.entries(binEntries)) {
      if (typeof binTarget !== 'string') continue;
      if (binTarget.startsWith('./src/') || binTarget.endsWith('.ts')) {
        issues.push({
          severity: 'warning',
          pkg: name,
          message: `bin "${binName}" points to source (${binTarget}); flip to dist/<file>.js before publish`,
        });
      }
    }
  }
}

for (const short of packages) check(short);

const errors = issues.filter((i) => i.severity === 'error');
const warnings = issues.filter((i) => i.severity === 'warning');

if (errors.length === 0 && warnings.length === 0) {
  process.stdout.write('[check-publish-readiness] all clear ✓\n');
  process.exit(0);
}

process.stdout.write(
  `[check-publish-readiness] ${errors.length} error(s), ${warnings.length} warning(s)\n`,
);
for (const i of issues) {
  process.stdout.write(`  ${i.severity.toUpperCase().padEnd(8)} ${i.pkg.padEnd(40)} ${i.message}\n`);
}
process.exit(errors.length > 0 ? 1 : 0);
