/**
 * Knowledge-stale apply splicer.
 *
 * Removes a single stale / missing reference from a knowledge entry's
 * `references[]` array. Pure-text mutation; preview-first under the
 * hood (callers compute the patch with `write: false` for every target
 * before writing).
 *
 * Supports both "drop the reference" and "rename in place" paths;
 * the latter activates when the caller supplies a `renameTo` payload.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IKnowledgeReference } from '@shrkcrft/knowledge';
import { findEntryRange, removeArrayEntries } from './entry-mutator.ts';

/**
 * Optional rename payload. When present, the apply rewrites the
 * matching reference's identifying field (`path` / `id` / `symbol`)
 * rather than removing the whole element. Migration is strictly safer
 * than drop when the engine can identify the new location.
 */
export interface IKnowledgeStaleRename {
  readonly path?: string;
  readonly id?: string;
  readonly symbol?: string;
}

export interface IKnowledgeStaleFixInput {
  readonly cwd: string;
  readonly targetPath: string;
  readonly entryId: string;
  readonly reference: IKnowledgeReference;
  readonly write: boolean;
  /** When present, rename in place instead of dropping. */
  readonly renameTo?: IKnowledgeStaleRename;
}

export interface IKnowledgeStaleFixResult {
  readonly ok: boolean;
  readonly refusal?: string;
  readonly targetAbs: string;
  readonly entryId: string;
  readonly originalLength: number;
  readonly nextLength: number;
  /** Number of references dropped (only meaningful in `drop` mode). */
  readonly removedCount: number;
  /** Mode the splicer actually applied. */
  readonly mode: 'drop' | 'rename';
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

/**
 * Match a `references[]` element string against an `IKnowledgeReference`
 * by `kind` and every identifying field the reference carries (`id`,
 * `path`, `symbol`). When the reference has multiple identifying fields
 * (e.g. symbol refs typically have both `symbol` and `path`), the
 * element must match ALL of them — otherwise we risk matching the
 * wrong neighbor.
 */
function elementMatchesReference(element: string, ref: IKnowledgeReference): boolean {
  const escapedKind = ref.kind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const kindRe = new RegExp(`\\bkind\\s*:\\s*['"]${escapedKind}['"]`);
  if (!kindRe.test(element)) return false;
  const id = (ref as { id?: string }).id;
  const path = (ref as { path?: string }).path;
  const symbol = (ref as { symbol?: string }).symbol;
  // Each present identifying field must match.
  const checks: Array<{ key: string; value: string }> = [];
  if (id !== undefined) checks.push({ key: 'id', value: id });
  if (path !== undefined) checks.push({ key: 'path', value: path });
  if (symbol !== undefined) checks.push({ key: 'symbol', value: symbol });
  if (checks.length === 0) return false;
  for (const c of checks) {
    const escapedValue = c.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${c.key}\\s*:\\s*['"]${escapedValue}['"]`);
    if (!re.test(element)) return false;
  }
  return true;
}

/**
 * Rewrite a matching reference element's identifying field
 * in place. Returns the new body and whether the rewrite landed.
 *
 * The rewrite is intentionally narrow: it operates on the single
 * element string identified by `elementMatchesReference` and swaps
 * the relevant field's quoted value. The rest of the entry (kind,
 * other fields, surrounding entries) is untouched.
 */
function renameReferenceInElement(
  element: string,
  ref: IKnowledgeReference,
  renameTo: IKnowledgeStaleRename,
): { next: string; renamed: boolean } {
  let next = element;
  let renamed = false;
  const rewrite = (key: 'path' | 'id' | 'symbol', oldValue: string | undefined, newValue: string | undefined): void => {
    if (!newValue || !oldValue) return;
    const escapedKey = key;
    const escapedOld = oldValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(\\b${escapedKey}\\s*:\\s*['"])${escapedOld}(['"])`);
    if (re.test(next)) {
      next = next.replace(re, (_m, head: string, tail: string) => head + newValue + tail);
      renamed = true;
    }
  };
  const id = (ref as { id?: string }).id;
  const path = (ref as { path?: string }).path;
  const symbol = (ref as { symbol?: string }).symbol;
  if (renameTo.path !== undefined) rewrite('path', path, renameTo.path);
  if (renameTo.id !== undefined) rewrite('id', id, renameTo.id);
  if (renameTo.symbol !== undefined) rewrite('symbol', symbol, renameTo.symbol);
  return { next, renamed };
}

/**
 * Replace the matching reference element inside an entry's
 * `references[]` array. The bracket-balanced scan is intentional —
 * the same parsing rules as `removeArrayEntries` so we don't break
 * on nested objects or strings containing commas.
 */
function replaceReferenceElement(
  body: string,
  open: number,
  close: number,
  ref: IKnowledgeReference,
  renameTo: IKnowledgeStaleRename,
): { body: string; renamed: boolean } {
  // Find `references: [` inside [open..close].
  const slice = body.slice(open, close + 1);
  const fm = /\breferences\s*:\s*\[/.exec(slice);
  if (!fm) return { body, renamed: false };
  const arrayOpenIdx = open + fm.index + fm[0].length - 1;
  // Walk to matching `]` with string + bracket awareness.
  let depth = 0;
  let arrayCloseIdx = -1;
  let inString: '"' | "'" | '`' | null = null;
  let escape = false;
  for (let i = arrayOpenIdx; i < body.length; i++) {
    const c = body[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === '\\') {
        escape = true;
        continue;
      }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c;
      continue;
    }
    if (c === '[' || c === '{' || c === '(') depth++;
    else if (c === ']' || c === '}' || c === ')') {
      depth--;
      if (depth === 0 && c === ']') {
        arrayCloseIdx = i;
        break;
      }
    }
  }
  if (arrayCloseIdx === -1) return { body, renamed: false };
  const inner = body.slice(arrayOpenIdx + 1, arrayCloseIdx);
  // Split at top-level commas (lightweight inline implementation —
  // keeps this module self-contained).
  const parts: string[] = [];
  {
    let d = 0;
    let s: '"' | "'" | '`' | null = null;
    let e = false;
    let start = 0;
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (e) {
        e = false;
        continue;
      }
      if (s) {
        if (c === '\\') {
          e = true;
          continue;
        }
        if (c === s) s = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        s = c;
        continue;
      }
      if (c === '[' || c === '{' || c === '(') d++;
      else if (c === ']' || c === '}' || c === ')') d--;
      else if (c === ',' && d === 0) {
        parts.push(inner.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(inner.slice(start));
  }
  let renamed = false;
  const next: string[] = [];
  for (const p of parts) {
    if (!renamed && elementMatchesReference(p, ref)) {
      const r = renameReferenceInElement(p, ref, renameTo);
      next.push(r.next);
      renamed = r.renamed;
    } else {
      next.push(p);
    }
  }
  if (!renamed) return { body, renamed: false };
  const newInner = next.join(',');
  return {
    body: body.slice(0, arrayOpenIdx + 1) + newInner + body.slice(arrayCloseIdx),
    renamed: true,
  };
}

export function applyKnowledgeStaleFix(
  input: IKnowledgeStaleFixInput,
): IKnowledgeStaleFixResult {
  const cwd = nodePath.resolve(input.cwd);
  const targetAbs = nodePath.resolve(cwd, input.targetPath);
  if (escapesCwd(cwd, targetAbs)) {
    return {
      ok: false,
      refusal: `Target path escapes the project root (cwd=${cwd}).`,
      targetAbs,
      entryId: input.entryId,
      originalLength: 0,
      nextLength: 0,
      removedCount: 0,
      mode: 'drop',
      wrote: false,
    };
  }
  if (!existsSync(targetAbs)) {
    return {
      ok: false,
      refusal: `Target file not found: ${targetAbs}`,
      targetAbs,
      entryId: input.entryId,
      originalLength: 0,
      nextLength: 0,
      removedCount: 0,
      mode: 'drop',
      wrote: false,
    };
  }
  const body = readFileSync(targetAbs, 'utf8');
  const range = findEntryRange(body, input.entryId);
  if (!range) {
    return {
      ok: false,
      refusal: `Entry "${input.entryId}" not found in ${nodePath.relative(cwd, targetAbs)}.`,
      targetAbs,
      entryId: input.entryId,
      originalLength: body.length,
      nextLength: body.length,
      removedCount: 0,
      mode: input.renameTo ? 'rename' : 'drop',
      wrote: false,
    };
  }
  // Rename path takes precedence when the caller supplied a
  // replacement. Migration is strictly safer than drop.
  if (input.renameTo) {
    const renameResult = replaceReferenceElement(
      body,
      range.open,
      range.close,
      input.reference,
      input.renameTo,
    );
    if (!renameResult.renamed) {
      return {
        ok: false,
        refusal: `Reference not found (or already at the new location) in entry "${input.entryId}".`,
        targetAbs,
        entryId: input.entryId,
        originalLength: body.length,
        nextLength: body.length,
        removedCount: 0,
        mode: 'rename',
        wrote: false,
      };
    }
    const nextBody = renameResult.body;
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
      entryId: input.entryId,
      originalLength: body.length,
      nextLength: nextBody.length,
      removedCount: 0,
      mode: 'rename',
      diff,
      wrote,
    };
  }
  // Default — drop the reference.
  const result = removeArrayEntries(body, range, 'references', (element) =>
    elementMatchesReference(element, input.reference),
  );
  if (!result) {
    return {
      ok: false,
      refusal: `Entry "${input.entryId}" has no \`references\` array (or it's not a simple bracket form).`,
      targetAbs,
      entryId: input.entryId,
      originalLength: body.length,
      nextLength: body.length,
      removedCount: 0,
      mode: 'drop',
      wrote: false,
    };
  }
  if (result.removedCount === 0) {
    return {
      ok: false,
      refusal: `Reference not found in entry "${input.entryId}" — already removed?`,
      targetAbs,
      entryId: input.entryId,
      originalLength: body.length,
      nextLength: body.length,
      removedCount: 0,
      mode: 'drop',
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
    entryId: input.entryId,
    originalLength: body.length,
    nextLength: nextBody.length,
    removedCount: result.removedCount,
    mode: 'drop',
    diff,
    wrote,
  };
}
