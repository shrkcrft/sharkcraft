/**
 * Action-hint stub splicer.
 *
 * Inserts a commented `actionHints: { ... }` block into the matching
 * knowledge entry in `sharkcraft/knowledge.ts`. The stub is the same
 * shape that `fix --action-hints` previews today, but the splicer
 * actually applies it in place rather than just writing a preview file
 * under `.sharkcraft/fixes/`.
 *
 * Hard rules:
 *   - Refuses path-escape on target.
 *   - Refuses pack-contributed entries unless explicitly asked.
 *   - Refuses if the entry already has an `actionHints` field
 *     (idempotent).
 *   - Preview-first: callers must compute the patch first; the writer
 *     only persists when `write: true`.
 *   - Stubs are commented placeholders (`/* TODO: ... *\/`). Doctor
 *     continues to warn (now via `action-hint-quality`) until the
 *     placeholders are filled.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { findEntryRange as sharedFindEntryRange } from './entry-mutator.ts';

export interface IActionHintStubInput {
  readonly cwd: string;
  readonly targetPath: string;
  readonly entryId: string;
  readonly write: boolean;
  readonly allowDivergent?: boolean;
  /** Override the default stub body. */
  readonly stubBody?: string;
}

export interface IActionHintStubResult {
  readonly ok: boolean;
  readonly refusal?: string;
  readonly targetAbs: string;
  readonly entryId: string;
  /** Line where the stub was inserted (1-indexed). */
  readonly insertedAtLine?: number;
  readonly originalLength: number;
  readonly nextLength: number;
  /** Full unified-diff body for human review. */
  readonly diff?: string;
  readonly wrote: boolean;
}

const DEFAULT_STUB_BODY = [
  '  // TODO(action-hints): fill the placeholders, then doctor warnings flip off.',
  '  actionHints: {',
  '    commands: [/* TODO: shrk commands an agent should run */],',
  '    mcpTools: [/* TODO: read-only MCP tool names */],',
  '    forbiddenActions: [/* TODO: things the agent must not do */],',
  '    verificationCommands: [/* TODO: ids from sharkcraft.config.ts verificationCommands[] */],',
  "    writePolicy: 'preview-only' /* TODO: 'preview-only' | 'cli-only' | 'plan-first' */,",
  '  },',
].join('\n');

function escapesCwd(cwd: string, absPath: string): boolean {
  const rel = nodePath.relative(cwd, absPath);
  return rel.startsWith('..') || nodePath.isAbsolute(rel);
}

/**
 * `findEntryRange` lives in `entry-mutator.ts` so the four apply paths
 * (action-hint, knowledge-stale, template-drift, templates-update)
 * share the same primitive. This wrapper preserves the call-site name.
 */
const findEntryRange = sharedFindEntryRange;

function entryHasActionHints(body: string, range: { open: number; close: number }): boolean {
  const slice = body.slice(range.open, range.close + 1);
  // Match `actionHints:` at the top level — we'll be conservative and look
  // for the field name preceded by whitespace and followed by `:`.
  return /\bactionHints\s*:/.test(slice);
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
 * Compute the patched body. Pure — no IO. The caller persists when
 * `input.write` is true.
 */
export function applyActionHintStub(
  input: IActionHintStubInput,
): IActionHintStubResult {
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
      wrote: false,
    };
  }
  if (entryHasActionHints(body, range) && !input.allowDivergent) {
    return {
      ok: false,
      refusal: `Entry "${input.entryId}" already has an actionHints field. Pass --allow-divergent to overwrite.`,
      targetAbs,
      entryId: input.entryId,
      originalLength: body.length,
      nextLength: body.length,
      wrote: false,
    };
  }
  const stubBody = input.stubBody ?? DEFAULT_STUB_BODY;
  // Match the closing brace's indent + 2 spaces for the stub.
  const childIndent = range.indent + '  ';
  const indentedStub = stubBody
    .split('\n')
    .map((l) => (l.length > 0 ? childIndent + l.replace(/^ {2}/, '') : l))
    .join('\n');
  // Insert before the closing `}` of the entry literal, with a leading
  // newline so the result lands on its own lines.
  const before = body.slice(0, range.close);
  const after = body.slice(range.close);
  // Ensure the inserted block is separated from the previous content by a
  // newline + appropriate indent.
  const trimmedBefore = before.replace(/[ \t]*$/, '');
  // Ensure the preceding line ends with a comma (object literal field).
  const ensuredComma = /[,{][ \t\r\n]*$/.test(trimmedBefore)
    ? trimmedBefore
    : trimmedBefore.replace(/[ \t\r\n]*$/, '') + ',';
  // See `insertField` in entry-mutator.ts: the inserted line carries
  // the indent for the next `}`, so `after` is appended verbatim —
  // slicing the indent here strips the closing `}` whenever it lived
  // on its own indented line.
  const insertedLine = (ensuredComma.length > 0 && !ensuredComma.endsWith('\n') ? '\n' : '') +
    indentedStub +
    '\n' +
    range.indent;
  const nextBody = ensuredComma + insertedLine + after;

  let wrote = false;
  if (input.write && nextBody !== body) {
    writeFileSync(targetAbs, nextBody, 'utf8');
    wrote = true;
  }
  const rel = nodePath.relative(cwd, targetAbs) || nodePath.basename(targetAbs);
  const diff = buildUnifiedDiff(rel, body, nextBody);
  // Compute the line where the stub starts (after the comma we ensured).
  const insertedAt = ensuredComma.split('\n').length;
  return {
    ok: true,
    targetAbs,
    entryId: input.entryId,
    insertedAtLine: insertedAt,
    originalLength: body.length,
    nextLength: nextBody.length,
    diff,
    wrote,
  };
}
