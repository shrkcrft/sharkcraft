/**
 * Template-drift apply splicer.
 *
 * Scope: the `related-id-unresolved` code only.
 * Most template-drift findings (`forbidden-legacy-path`,
 * `missing-anchor`, `missing-produced-anchor`, `missing-barrel`, etc.)
 * are template *body* issues — the `files()` / `changes()` resolver
 * functions need to be edited. Those stay preview-only.
 *
 * For `related-id-unresolved`, the fix is mechanical: drop the
 * unresolved id from the template's `related[]` array.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { findEntryRange, removeStringFromArray } from './entry-mutator.ts';

export interface ITemplateDriftFixInput {
  readonly cwd: string;
  readonly targetPath: string;
  readonly templateId: string;
  /** Which `related[]` id to drop. */
  readonly droppedRelatedId: string;
  readonly write: boolean;
}

export interface ITemplateDriftFixResult {
  readonly ok: boolean;
  readonly refusal?: string;
  readonly targetAbs: string;
  readonly templateId: string;
  readonly originalLength: number;
  readonly nextLength: number;
  readonly removedCount: number;
  readonly diff?: string;
  readonly wrote: boolean;
}

function escapesCwd(cwd: string, absPath: string): boolean {
  const rel = nodePath.relative(cwd, absPath);
  return rel.startsWith('..') || nodePath.isAbsolute(rel);
}

function buildUnifiedDiff(rel: string, a: string, b: string): string {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  let prefix = 0;
  while (prefix < aLines.length && prefix < bLines.length && aLines[prefix] === bLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < aLines.length - prefix &&
    suffix < bLines.length - prefix &&
    aLines[aLines.length - 1 - suffix] === bLines[bLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const aMid = aLines.slice(prefix, aLines.length - suffix);
  const bMid = bLines.slice(prefix, bLines.length - suffix);
  const head = `--- ${rel}\n+++ ${rel}\n@@ -${prefix + 1},${aMid.length} +${prefix + 1},${bMid.length} @@\n`;
  return (
    head +
    aMid.map((l) => `-${l}`).join('\n') +
    (aMid.length ? '\n' : '') +
    bMid.map((l) => `+${l}`).join('\n')
  );
}

export function applyTemplateDriftFix(
  input: ITemplateDriftFixInput,
): ITemplateDriftFixResult {
  const cwd = nodePath.resolve(input.cwd);
  const targetAbs = nodePath.resolve(cwd, input.targetPath);
  if (escapesCwd(cwd, targetAbs)) {
    return {
      ok: false,
      refusal: `Target path escapes the project root (cwd=${cwd}).`,
      targetAbs,
      templateId: input.templateId,
      originalLength: 0,
      nextLength: 0,
      removedCount: 0,
      wrote: false,
    };
  }
  if (!existsSync(targetAbs)) {
    return {
      ok: false,
      refusal: `Target file not found: ${targetAbs}`,
      targetAbs,
      templateId: input.templateId,
      originalLength: 0,
      nextLength: 0,
      removedCount: 0,
      wrote: false,
    };
  }
  const body = readFileSync(targetAbs, 'utf8');
  const range = findEntryRange(body, input.templateId);
  if (!range) {
    return {
      ok: false,
      refusal: `Template "${input.templateId}" not found in ${nodePath.relative(cwd, targetAbs)}.`,
      targetAbs,
      templateId: input.templateId,
      originalLength: body.length,
      nextLength: body.length,
      removedCount: 0,
      wrote: false,
    };
  }
  const result = removeStringFromArray(body, range, 'related', input.droppedRelatedId);
  if (!result) {
    return {
      ok: false,
      refusal: `Template "${input.templateId}" has no \`related\` array (or it's not a simple bracket form).`,
      targetAbs,
      templateId: input.templateId,
      originalLength: body.length,
      nextLength: body.length,
      removedCount: 0,
      wrote: false,
    };
  }
  if (result.removedCount === 0) {
    return {
      ok: false,
      refusal: `Related id "${input.droppedRelatedId}" not present in "${input.templateId}" — already removed?`,
      targetAbs,
      templateId: input.templateId,
      originalLength: body.length,
      nextLength: body.length,
      removedCount: 0,
      wrote: false,
    };
  }
  const nextBody = result.body;
  let wrote = false;
  if (input.write && nextBody !== body) {
    writeFileSync(targetAbs, nextBody, 'utf8');
    wrote = true;
  }
  const rel = nodePath.relative(cwd, targetAbs) || nodePath.basename(targetAbs);
  const diff = buildUnifiedDiff(rel, body, nextBody);
  return {
    ok: true,
    targetAbs,
    templateId: input.templateId,
    originalLength: body.length,
    nextLength: nextBody.length,
    removedCount: result.removedCount,
    diff,
    wrote,
  };
}
