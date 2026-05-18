/**
 * `.gitignore` safety for SharkCraft local state.
 *
 * `init` (any preset path) and `doctor --check-gitignore` rely on this to
 * make sure the directories SharkCraft writes locally — sessions, reports,
 * fixes, authoring drafts, memory snapshots, tmp, cache — never land in
 * commits by accident. Project-config under `sharkcraft/` (the
 * deterministic input the engine consumes) stays committed.
 *
 *   Idempotent: running the patch twice is a no-op.
 *   Preview-first: callers pass `dryRun: true` to inspect the diff.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';

/** Patterns SharkCraft needs ignored. Order is stable for diff output. */
export const SHARKCRAFT_GITIGNORE_PATTERNS: readonly string[] = [
  '.sharkcraft/sessions/',
  '.sharkcraft/reports/',
  '.sharkcraft/fixes/',
  '.sharkcraft/authoring/',
  '.sharkcraft/memory/',
  '.sharkcraft/tmp/',
  '.sharkcraft/cache/',
  // Local-only command usage log (writes only; no exfiltration).
  '.sharkcraft/usage/',
  // Cached project-shape detection.
  '.sharkcraft/shape.json',
];

const MARKER_START = '# >>> sharkcraft local state (managed by `shrk init`)';
const MARKER_END = '# <<< sharkcraft local state';

export interface IGitignorePatch {
  /** Absolute path of the .gitignore file (created or updated). */
  readonly path: string;
  /** True if the file did not exist before this call. */
  readonly created: boolean;
  /** Patterns that were already present before this call. */
  readonly alreadyPresent: readonly string[];
  /** Patterns that this patch adds. Empty when nothing to do. */
  readonly added: readonly string[];
  /** New file body the patch would write (or wrote, when `dryRun: false`). */
  readonly nextBody: string;
  /** True if `dryRun: false` actually wrote. */
  readonly wrote: boolean;
}

export interface IGitignorePatchOptions {
  /** Project root that owns the `.gitignore`. */
  readonly cwd: string;
  /** When true, compute the patch without writing. Default true. */
  readonly dryRun?: boolean;
}

/**
 * Computes (and optionally applies) the gitignore patch that ensures all
 * SharkCraft local-state directories are ignored. Idempotent.
 */
export function ensureSharkcraftGitignore(
  options: IGitignorePatchOptions,
): IGitignorePatch {
  const cwd = options.cwd;
  const dryRun = options.dryRun !== false;
  const filePath = nodePath.join(cwd, '.gitignore');

  const existingBody = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  const created = existingBody.length === 0;
  const existingLines = existingBody.split(/\r?\n/);

  const presentSet = new Set<string>();
  for (const line of existingLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    presentSet.add(trimmed);
  }

  const alreadyPresent: string[] = [];
  const toAdd: string[] = [];
  for (const pattern of SHARKCRAFT_GITIGNORE_PATTERNS) {
    if (presentSet.has(pattern)) alreadyPresent.push(pattern);
    else toAdd.push(pattern);
  }

  if (toAdd.length === 0) {
    return {
      path: filePath,
      created: false,
      alreadyPresent,
      added: [],
      nextBody: existingBody,
      wrote: false,
    };
  }

  const block = [
    MARKER_START,
    ...toAdd,
    MARKER_END,
  ].join('\n');

  // Append the managed block; preserve trailing newline behaviour.
  let nextBody: string;
  if (existingBody.length === 0) {
    nextBody = block + '\n';
  } else {
    const needsLeadingNewline = !existingBody.endsWith('\n');
    nextBody = existingBody + (needsLeadingNewline ? '\n\n' : '\n') + block + '\n';
  }

  let wrote = false;
  if (!dryRun) {
    writeFileSync(filePath, nextBody, 'utf8');
    wrote = true;
  }

  return {
    path: filePath,
    created,
    alreadyPresent,
    added: toAdd,
    nextBody,
    wrote,
  };
}

/** Render a short human summary of the patch. */
export function renderGitignorePatch(patch: IGitignorePatch, dryRun: boolean): string {
  const lines: string[] = [];
  lines.push(`.gitignore — ${dryRun ? 'preview' : 'updated'}`);
  lines.push(`  file:           ${patch.path}`);
  lines.push(`  created file:   ${patch.created ? 'yes' : 'no'}`);
  lines.push(`  patterns kept:  ${patch.alreadyPresent.length}`);
  lines.push(`  patterns added: ${patch.added.length}`);
  if (patch.added.length > 0) {
    lines.push('');
    lines.push('  Would add:');
    for (const p of patch.added) lines.push(`    + ${p}`);
  }
  return lines.join('\n') + '\n';
}
