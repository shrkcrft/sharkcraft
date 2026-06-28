import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { matchesAny } from '../scan/glob.ts';

/** Vendor / build / VCS dirs never scanned. */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.sharkcraft',
  '.next',
  '.turbo',
  '.cache',
]);

/** Files larger than this are skipped (regex token extraction over multi-MB blobs is pointless). */
export const MAX_SCAN_FILE_BYTES = 1_000_000;

/**
 * Walk `root`, returning project-relative POSIX paths that match any glob.
 * `excludeDirs` is a set of project-relative POSIX directory paths to prune
 * entirely (e.g. the SharkCraft asset/config dir).
 */
export function walkMatching(
  root: string,
  globs: readonly string[],
  excludeDirs: ReadonlySet<string> = new Set(),
): string[] {
  const out: string[] = [];
  const visit = (abs: string): void => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childAbs = nodePath.join(abs, e.name);
      const rel = nodePath.relative(root, childAbs).split(nodePath.sep).join('/');
      if (e.isDirectory()) {
        // Skip vendor/build/VCS dirs AND every dot-directory (`.yarn`, `.pnp`,
        // `.venv`, `.gradle`, …) — matching the established scan-imports walker,
        // so neither policy-lint nor wiring scans tooling/vendored sources.
        // (Dirent.isDirectory() is false for symlinks, so symlinked dirs are
        // never descended — no loop risk.)
        if (e.name.startsWith('.') || SKIP_DIRS.has(e.name) || excludeDirs.has(rel)) continue;
        visit(childAbs);
      } else if (e.isFile()) {
        if (matchesAny(rel, globs)) out.push(rel);
      }
    }
  };
  visit(root);
  return out;
}

/** Walk + read every file matching `globs`, skipping oversized/unreadable files. */
export function readMatchingFiles(
  root: string,
  globs: readonly string[],
  excludeDirs: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of walkMatching(root, globs, excludeDirs)) {
    const abs = nodePath.join(root, rel);
    let size = -1;
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
      size = st.size;
    } catch {
      continue;
    }
    if (size > MAX_SCAN_FILE_BYTES) continue;
    try {
      out.set(rel, readFileSync(abs, 'utf8'));
    } catch {
      // unreadable — skip
    }
  }
  return out;
}
