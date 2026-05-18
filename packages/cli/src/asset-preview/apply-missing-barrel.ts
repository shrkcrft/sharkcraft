/**
 * Missing-barrel auto-create.
 *
 * When `templates drift` flags `missing-barrel` (template's `changes`
 * list has an `export` op pointing at a non-existent index file), the
 * fix is mechanical: create the missing file with a placeholder
 * `export {};` body. The drift warning flips off because the file
 * exists; the human still has to populate the re-exports.
 *
 * Hard rules:
 *   - Refuses path-escape on the barrel target.
 *   - Refuses pack targets (`node_modules/` or `dist/`).
 *   - Idempotent — refuses if the file already exists.
 *   - Creates parent directories as needed.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';

export interface IMissingBarrelInput {
  readonly cwd: string;
  /** Project-relative path of the barrel to create. */
  readonly barrelPath: string;
  readonly write: boolean;
}

export interface IMissingBarrelResult {
  readonly ok: boolean;
  readonly refusal?: string;
  readonly barrelAbs: string;
  readonly bodyWritten?: string;
  readonly wrote: boolean;
}

const PLACEHOLDER_BODY =
  '// AUTO-CREATED by `shrk fix --template-drift --apply`.\n' +
  '// Populate with the expected re-exports before the next drift run.\n' +
  'export {};\n';

function escapesCwd(cwd: string, absPath: string): boolean {
  const rel = nodePath.relative(cwd, absPath);
  return rel.startsWith('..') || nodePath.isAbsolute(rel);
}

export function applyMissingBarrelFix(
  input: IMissingBarrelInput,
): IMissingBarrelResult {
  const cwd = nodePath.resolve(input.cwd);
  const barrelAbs = nodePath.resolve(cwd, input.barrelPath);
  if (escapesCwd(cwd, barrelAbs)) {
    return {
      ok: false,
      refusal: `Barrel path escapes the project root (cwd=${cwd}).`,
      barrelAbs,
      wrote: false,
    };
  }
  const rel = nodePath.relative(cwd, barrelAbs);
  if (rel.startsWith('node_modules' + nodePath.sep) || /\bdist\b/.test(rel)) {
    return {
      ok: false,
      refusal: `Barrel target lives in a pack / build artifact (${rel}) — edit the source pack and re-sign instead.`,
      barrelAbs,
      wrote: false,
    };
  }
  if (existsSync(barrelAbs)) {
    return {
      ok: false,
      refusal: `Barrel already exists at ${rel} — nothing to create.`,
      barrelAbs,
      wrote: false,
    };
  }
  let wrote = false;
  if (input.write) {
    mkdirSync(nodePath.dirname(barrelAbs), { recursive: true });
    writeFileSync(barrelAbs, PLACEHOLDER_BODY, 'utf8');
    wrote = true;
  }
  return {
    ok: true,
    barrelAbs,
    bodyWritten: PLACEHOLDER_BODY,
    wrote,
  };
}
