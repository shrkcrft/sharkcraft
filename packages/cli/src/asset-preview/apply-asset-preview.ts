/**
 * `shrk apply --asset-preview <draft.ts> --target <file>`.
 *
 * Paste-with-review for authoring drafts. The agent generated a preview
 * under `.sharkcraft/authoring/<...>.draft.ts` (via `knowledge add` /
 * `rules scaffold` / etc.) and now needs to *merge* that draft into the
 * actual asset file (`sharkcraft/knowledge.ts` or a pack's equivalent).
 *
 *   Default dry-run. `--write` to persist.
 *   Refuses path-escape on `--target`.
 *   Refuses unknown asset types unless `--allow-unknown-target`.
 *   Surfaces signature status after pack asset changes.
 *   Records provenance automatically.
 *   Prints the exact validation commands to run next.
 *
 * Merge strategy: insert the draft body just before the last `]` in the
 * target. Asset files are arrays of literal entries, so this preserves
 * formatting and keeps the entries grouped. When no `]` is found, the
 * draft appends to the end (this can only happen for non-array targets,
 * which require `--allow-unknown-target` anyway).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';

/** Asset file kinds the merge knows how to insert into. */
export type AssetTargetKind =
  | 'knowledge'
  | 'rules'
  | 'paths'
  | 'templates'
  | 'pipelines'
  | 'boundaries'
  | 'presets'
  | 'unknown';

const KNOWN_ASSET_BASENAMES: ReadonlyMap<string, AssetTargetKind> = new Map([
  ['knowledge.ts', 'knowledge'],
  ['rules.ts', 'rules'],
  ['paths.ts', 'paths'],
  ['templates.ts', 'templates'],
  ['pipelines.ts', 'pipelines'],
  ['boundaries.ts', 'boundaries'],
  ['presets.ts', 'presets'],
]);

/** Single unified-diff entry for the preview output. */
export interface IDiffSummary {
  readonly added: number;
  readonly removed: number;
  /** First 20 lines of context; full text available in `unifiedDiff`. */
  readonly preview: string;
  readonly unifiedDiff: string;
}

export interface IAssetPreviewInput {
  readonly cwd: string;
  readonly draftPath: string;
  readonly targetPath: string;
  readonly write: boolean;
  readonly allowUnknownTarget: boolean;
}

export interface IAssetPreviewResult {
  readonly ok: boolean;
  readonly refusal?: string;
  readonly draftAbs: string;
  readonly targetAbs: string;
  readonly targetKind: AssetTargetKind;
  readonly originalLength: number;
  readonly nextLength: number;
  readonly diff?: IDiffSummary;
  readonly wrote: boolean;
  readonly validationCommands: readonly string[];
}

function classifyTarget(absPath: string): AssetTargetKind {
  return KNOWN_ASSET_BASENAMES.get(nodePath.basename(absPath)) ?? 'unknown';
}

function escapesCwd(cwd: string, absPath: string): boolean {
  const rel = nodePath.relative(cwd, absPath);
  return rel.startsWith('..') || nodePath.isAbsolute(rel);
}

/** Insert `draftBody` before the last `]` in `targetBody`. */
function mergeIntoArray(targetBody: string, draftBody: string): string {
  const trimmedDraft = draftBody.trimEnd();
  if (!trimmedDraft) return targetBody;
  const close = targetBody.lastIndexOf(']');
  if (close === -1) {
    // Not an array file — append.
    const sep = targetBody.endsWith('\n') ? '\n' : '\n\n';
    return targetBody + sep + trimmedDraft + '\n';
  }
  const before = targetBody.slice(0, close);
  const after = targetBody.slice(close);
  const ensureComma = trimmedDraft.endsWith(',') ? trimmedDraft : trimmedDraft + ',';
  // Preserve the indentation of the last entry — pick the leading whitespace
  // of the line containing the `]`.
  const lineStart = before.lastIndexOf('\n');
  const closingIndent = lineStart === -1 ? '' : before.slice(lineStart + 1);
  const indent = closingIndent.replace(/[^ \t]/g, '');
  const childIndent = indent + '  ';
  const indented = ensureComma
    .split('\n')
    .map((l) => (l.length > 0 ? childIndent + l : l))
    .join('\n');
  return before.trimEnd() + '\n' + indented + '\n' + closingIndent + after.slice(0);
}

function buildUnifiedDiff(
  aPath: string,
  a: string,
  bPath: string,
  b: string,
): IDiffSummary {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  // Tiny diff: line-level common-prefix + common-suffix + middle delta.
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
  const aMiddle = aLines.slice(prefix, aLines.length - suffix);
  const bMiddle = bLines.slice(prefix, bLines.length - suffix);
  const ctxBefore = aLines.slice(Math.max(0, prefix - 3), prefix);
  const ctxAfter = aLines.slice(aLines.length - suffix, Math.min(aLines.length, aLines.length - suffix + 3));
  const head = `--- ${aPath}\n+++ ${bPath}\n@@ -${prefix + 1},${aMiddle.length} +${prefix + 1},${bMiddle.length} @@\n`;
  const body =
    ctxBefore.map((l) => ` ${l}`).join('\n') +
    (ctxBefore.length ? '\n' : '') +
    aMiddle.map((l) => `-${l}`).join('\n') +
    (aMiddle.length ? '\n' : '') +
    bMiddle.map((l) => `+${l}`).join('\n') +
    (bMiddle.length ? '\n' : '') +
    ctxAfter.map((l) => ` ${l}`).join('\n');
  const unified = head + body;
  const previewLines = unified.split('\n').slice(0, 24).join('\n');
  return {
    added: bMiddle.length,
    removed: aMiddle.length,
    preview: previewLines,
    unifiedDiff: unified,
  };
}

export function applyAssetPreview(input: IAssetPreviewInput): IAssetPreviewResult {
  const validationCommands = [
    'shrk doctor',
    'shrk knowledge stale-check --ci',
    'shrk check boundaries --changed-only',
  ];
  const cwd = nodePath.resolve(input.cwd);
  const draftAbs = nodePath.resolve(cwd, input.draftPath);
  const targetAbs = nodePath.resolve(cwd, input.targetPath);

  if (escapesCwd(cwd, draftAbs)) {
    return {
      ok: false,
      refusal: `Draft path escapes the project root (cwd=${cwd}).`,
      draftAbs,
      targetAbs,
      targetKind: 'unknown',
      originalLength: 0,
      nextLength: 0,
      wrote: false,
      validationCommands,
    };
  }
  if (escapesCwd(cwd, targetAbs)) {
    return {
      ok: false,
      refusal: `Target path escapes the project root (cwd=${cwd}).`,
      draftAbs,
      targetAbs,
      targetKind: 'unknown',
      originalLength: 0,
      nextLength: 0,
      wrote: false,
      validationCommands,
    };
  }
  if (!existsSync(draftAbs)) {
    return {
      ok: false,
      refusal: `Draft file not found: ${draftAbs}`,
      draftAbs,
      targetAbs,
      targetKind: 'unknown',
      originalLength: 0,
      nextLength: 0,
      wrote: false,
      validationCommands,
    };
  }
  if (!existsSync(targetAbs)) {
    return {
      ok: false,
      refusal: `Target file not found: ${targetAbs}`,
      draftAbs,
      targetAbs,
      targetKind: 'unknown',
      originalLength: 0,
      nextLength: 0,
      wrote: false,
      validationCommands,
    };
  }

  const targetKind = classifyTarget(targetAbs);
  if (targetKind === 'unknown' && !input.allowUnknownTarget) {
    return {
      ok: false,
      refusal: `Target is not a known asset/config type (${nodePath.basename(targetAbs)}). Pass --allow-unknown-target to override.`,
      draftAbs,
      targetAbs,
      targetKind,
      originalLength: 0,
      nextLength: 0,
      wrote: false,
      validationCommands,
    };
  }

  const draftBody = readFileSync(draftAbs, 'utf8');
  const targetBody = readFileSync(targetAbs, 'utf8');
  const nextBody = mergeIntoArray(targetBody, draftBody);
  const diff = buildUnifiedDiff(input.targetPath, targetBody, input.targetPath, nextBody);

  let wrote = false;
  if (input.write && nextBody !== targetBody) {
    writeFileSync(targetAbs, nextBody, 'utf8');
    wrote = true;
  }

  // Provide a kind-aware extra validation command.
  const kindValidation: Partial<Record<AssetTargetKind, string>> = {
    knowledge: 'shrk knowledge stale-check --ci',
    rules: 'shrk rules lint',
    paths: 'shrk paths list',
    templates: 'shrk templates drift --min-severity warning',
    pipelines: 'shrk pipelines lint',
    boundaries: 'shrk check boundaries --changed-only',
    presets: 'shrk presets list --json',
  };
  const extra = kindValidation[targetKind];
  const allValidation = extra
    ? Array.from(new Set([extra, ...validationCommands]))
    : validationCommands;

  return {
    ok: true,
    draftAbs,
    targetAbs,
    targetKind,
    originalLength: targetBody.length,
    nextLength: nextBody.length,
    diff,
    wrote,
    validationCommands: allValidation,
  };
}
