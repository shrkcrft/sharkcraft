import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';

export interface IPathsAdvisory {
  missingPaths: readonly string[];
  existingPaths: readonly string[];
  /** True when an advisory comment was prepended to the file. */
  annotated: boolean;
  pathsFile: string;
}

const ADVISORY_MARKER = '// ⚠️ Workspace-shape advisory (added by `shrk init`):';

/**
 * Scan the generated `sharkcraft/paths.ts` for `path: '<x>'` references
 * and check each `<x>` against the live workspace. When any path is
 * missing, prepend a clearly-labeled comment block listing the missing
 * paths so the user knows which defaults to adjust.
 *
 * Idempotent — if the file already starts with the advisory marker,
 * it is left untouched. Non-destructive — never edits, comments, or
 * removes the original entries. The user is expected to revise them
 * based on the advisory + `shrk onboard --dry-run` output.
 */
export function annotatePathsAgainstDisk(
  cwd: string,
  sharkcraftDir: string,
): IPathsAdvisory {
  const pathsFile = nodePath.join(sharkcraftDir, 'paths.ts');
  if (!existsSync(pathsFile)) {
    return { missingPaths: [], existingPaths: [], annotated: false, pathsFile };
  }
  const original = readFileSync(pathsFile, 'utf8');
  if (original.startsWith(ADVISORY_MARKER)) {
    // Already annotated. Re-derive sets for caller diagnostics.
    return classifyOnly(cwd, pathsFile, original);
  }

  const { existing, missing } = classifyPathReferences(cwd, original);
  if (missing.length === 0) {
    return {
      missingPaths: [],
      existingPaths: existing,
      annotated: false,
      pathsFile,
    };
  }

  const lines: string[] = [
    ADVISORY_MARKER,
    '//',
    '// The following paths referenced below do NOT exist in this repository:',
    ...missing.map((p) => `//   - ${p}`),
    '//',
    '// They are conservative defaults from the chosen preset. Adjust them to',
    '// match your actual layout. Run `shrk onboard --dry-run` to see what',
    '// the inference engine detects from your workspace.',
    '//',
    '',
  ];
  writeFileSync(pathsFile, lines.join('\n') + original, 'utf8');
  return {
    missingPaths: missing,
    existingPaths: existing,
    annotated: true,
    pathsFile,
  };
}

function classifyOnly(
  cwd: string,
  pathsFile: string,
  original: string,
): IPathsAdvisory {
  const { existing, missing } = classifyPathReferences(cwd, original);
  return {
    missingPaths: missing,
    existingPaths: existing,
    annotated: false,
    pathsFile,
  };
}

function classifyPathReferences(
  cwd: string,
  source: string,
): { existing: string[]; missing: string[] } {
  // Match `path: '<x>'` / `path: "<x>"`. Ignore obvious code-context
  // references (e.g. inside template literals); we only consume the
  // first plain-string occurrence per entry.
  const re = /\bpath\s*:\s*['"]([^'"\n]+)['"]/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (m[1]) seen.add(m[1]);
  }
  const existing: string[] = [];
  const missing: string[] = [];
  for (const p of [...seen].sort()) {
    if (isReachable(cwd, p)) existing.push(p);
    else missing.push(p);
  }
  return { existing, missing };
}

function isReachable(cwd: string, p: string): boolean {
  // Absolute or rooted-relative — resolve as-is.
  const full = nodePath.isAbsolute(p) ? p : nodePath.resolve(cwd, p);
  return existsSync(full);
}
