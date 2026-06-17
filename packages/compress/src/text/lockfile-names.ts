/**
 * Basenames of dependency lockfiles. A lockfile diff is almost pure churn —
 * thousands of integrity hashes and resolved versions an agent never reads —
 * so the diff compressor elides its body to a one-line marker (recoverable via
 * CCR). Matched by exact basename (case-insensitive), never by extension, so a
 * hand-written `versions.lock` config isn't swept up by accident.
 */
const LOCKFILE_BASENAMES: ReadonlySet<string> = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'packages.lock.json',
  'cargo.lock',
  'go.sum',
  'composer.lock',
  'gemfile.lock',
  'poetry.lock',
  'pipfile.lock',
  'pdm.lock',
  'gradle.lockfile',
  'mix.lock',
  'flake.lock',
  'pubspec.lock',
  'packwiz.lock',
  'deno.lock',
]);

/** True when `basename` is a known dependency lockfile (case-insensitive). */
export function isLockfileName(basename: string): boolean {
  return LOCKFILE_BASENAMES.has(basename.toLowerCase());
}
