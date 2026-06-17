import { EContentType } from '../content/content-type.ts';
import { ECompressionStrategy } from '../result/compression-strategy.ts';
import type { ICompressionResult } from '../result/compression-result.ts';
import type { ICompressOptions } from '../result/compress-options.ts';
import { splitLines, queryTokens, queryOverlap, elide } from './line-utils.ts';
import { finalizeLossy, passthroughResult } from './finalize.ts';
import { formatCcrMarker } from '../ccr/ccr-marker.ts';
import { isLockfileName } from './lockfile-names.ts';

// Header tokens that are unambiguous at column 0 (a hunk body line starts with
// ` `/`+`/`-`, never these). `--- `/`+++ ` are handled separately because they
// collide with deleted/added content lines.
const SAFE_HEADER_RE = /^(?:diff --git |index |new file|deleted file|old mode|new mode|similarity |rename |copy )/;
const HUNK_HEADER_RE = /^@@ /;

interface IHunk {
  file: number;
  header: number;
  body: number[];
  changeCount: number;
  score: number;
}

function isChangeLine(line: string): boolean {
  if (line.startsWith('+') && !line.startsWith('+++')) return true;
  if (line.startsWith('-') && !line.startsWith('---')) return true;
  return false;
}

/**
 * Reduce a unified diff to its highest-signal lines. Two passes compose:
 *
 *  1. **Diff-noise offload** (this wrapper): lockfile sections
 *     (`package-lock.json` & friends) collapse to a one-line marker, and
 *     whitespace-only hunks (pure reindentation) collapse to a marker — the
 *     single largest sources of useless diff tokens. Both are CCR-recoverable.
 *  2. **Core hunk compression** ({@link compressDiffCore}): the remaining real
 *     changes keep their changed lines plus a tight context window, capped per
 *     file.
 *
 * The offload pass only engages when a `diff --git` section is actually a
 * lockfile or contains a whitespace-only hunk; every other diff routes straight
 * to the core compressor, byte-identical to before. Recoverable via CCR; output
 * favours LLM readability over `git apply` fidelity.
 */
export function compressDiff(text: string, opts: ICompressOptions = {}): ICompressionResult {
  const lines = splitLines(text);
  const sections = segmentDiffSections(lines);
  // Only take the offload path when the diff cleanly segments into `diff --git`
  // sections AND at least one is noise. Anything else stays on the core path.
  const hasNoise =
    sections !== null &&
    sections.some((s) => s.isLockfile || s.hunks.some((h) => h.whitespaceOnly));
  if (!sections || !hasNoise) return compressDiffCore(text, opts);

  const out: string[] = [];
  let lockfileCount = 0;
  let wsHunkCount = 0;

  for (const s of sections) {
    if (s.isLockfile) {
      lockfileCount += 1;
      const sectionText = s.lines.join('\n');
      const elided = s.lines.length - s.headerLines.length;
      const key = opts.store ? opts.store.put(sectionText) : undefined;
      const marker = `[lockfile ${s.basename}: ${plural(elided, 'line')} elided${
        key ? ` ${formatCcrMarker(key)}` : ''
      }]`;
      out.push([...s.headerLines, marker].join('\n'));
      continue;
    }

    const wsHunks = s.hunks.filter((h) => h.whitespaceOnly);
    const normalHunks = s.hunks.filter((h) => !h.whitespaceOnly);

    if (wsHunks.length === 0) {
      // No noise in this section — compress it with the core pass (per-section
      // CCR is handled once over the whole diff by finalizeLossy below).
      out.push(compressDiffCore(s.lines.join('\n'), { ...opts, store: undefined }).compressed);
      continue;
    }

    wsHunkCount += wsHunks.length;
    const normalSection = [...s.headerLines, ...normalHunks.flatMap((h) => h.lines)];
    const compressedNormal =
      normalHunks.length > 0
        ? compressDiffCore(normalSection.join('\n'), { ...opts, store: undefined }).compressed
        : s.headerLines.join('\n');
    const wsText = wsHunks.flatMap((h) => h.lines).join('\n');
    const wsLines = wsHunks.reduce((n, h) => n + h.lines.length, 0);
    const key = opts.store ? opts.store.put(wsText) : undefined;
    const wsMarker = `[whitespace-only: ${plural(wsHunks.length, 'hunk')}, ${plural(
      wsLines,
      'line',
    )} elided${key ? ` ${formatCcrMarker(key)}` : ''}]`;
    out.push([compressedNormal, wsMarker].join('\n'));
  }

  const note = `full diff: ${plural(lockfileCount, 'lockfile')} + ${plural(
    wsHunkCount,
    'whitespace hunk',
  )} offloaded`;
  return finalizeLossy({
    original: text,
    body: out.join('\n'),
    contentType: EContentType.GitDiff,
    strategy: ECompressionStrategy.Diff,
    opts,
    note,
  });
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

interface IHunkRange {
  /** Every line of the hunk: the `@@` header plus its body. */
  lines: string[];
  whitespaceOnly: boolean;
}

interface IDiffSection {
  /** All lines of the section, including its `diff --git` header. */
  lines: string[];
  /** Lines before the first `@@` hunk header (kept verbatim for lockfiles). */
  headerLines: string[];
  hunks: IHunkRange[];
  basename: string;
  isLockfile: boolean;
}

/**
 * Split a diff into per-file sections at `diff --git` boundaries. Returns null
 * when the diff doesn't cleanly start with a `diff --git` section (preamble,
 * headerless `diff -u`, etc.) so the caller falls back to the core path rather
 * than risk a fragile segmentation.
 */
function segmentDiffSections(lines: readonly string[]): IDiffSection[] | null {
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if ((lines[i] ?? '').startsWith('diff --git ')) starts.push(i);
  }
  if (starts.length === 0 || starts[0] !== 0) return null;

  const sections: IDiffSection[] = [];
  for (let k = 0; k < starts.length; k += 1) {
    const begin = starts[k]!;
    const end = k + 1 < starts.length ? starts[k + 1]! : lines.length;
    const sectionLines = lines.slice(begin, end);
    sections.push(buildSection(sectionLines));
  }
  return sections;
}

function buildSection(sectionLines: string[]): IDiffSection {
  let firstHunk = sectionLines.findIndex((l) => HUNK_HEADER_RE.test(l));
  if (firstHunk < 0) firstHunk = sectionLines.length;
  const headerLines = sectionLines.slice(0, firstHunk);

  const hunks: IHunkRange[] = [];
  let cur: string[] | null = null;
  for (let i = firstHunk; i < sectionLines.length; i += 1) {
    const line = sectionLines[i] ?? '';
    if (HUNK_HEADER_RE.test(line)) {
      if (cur) hunks.push({ lines: cur, whitespaceOnly: isWhitespaceOnlyHunk(cur) });
      cur = [line];
    } else if (cur) {
      cur.push(line);
    }
  }
  if (cur) hunks.push({ lines: cur, whitespaceOnly: isWhitespaceOnlyHunk(cur) });

  const basename = sectionPath(headerLines);
  return {
    lines: sectionLines,
    headerLines,
    hunks,
    basename,
    isLockfile: basename.length > 0 && isLockfileName(basename),
  };
}

/** The changed file's basename, parsed from `+++ b/<path>` or the git header. */
function sectionPath(headerLines: readonly string[]): string {
  let path = '';
  for (const line of headerLines) {
    const plus = /^\+\+\+ b\/(.*)$/.exec(line);
    if (plus) {
      path = plus[1] ?? '';
      break;
    }
  }
  if (!path) {
    const git = /^diff --git a\/.+ b\/(.+)$/.exec(headerLines[0] ?? '');
    if (git) path = git[1] ?? '';
  }
  // `+++ b/path` is clean inside a `diff --git` section, but guard a stray tab.
  path = (path.split('\t')[0] ?? '').trim();
  return path.split('/').pop() ?? '';
}

/**
 * True when a hunk's only real change is whitespace: the normalized contents of
 * its removed lines and added lines are identical multisets (so each `-x` is
 * answered by a `+x` differing only in leading/trailing/internal whitespace).
 * Pure-context hunks (no changes) are NOT whitespace-only — they're left for the
 * core pass.
 */
function isWhitespaceOnlyHunk(hunkLines: readonly string[]): boolean {
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
  const removed: string[] = [];
  const added: string[] = [];
  for (const line of hunkLines) {
    if (line.startsWith('-') && !line.startsWith('---')) removed.push(norm(line.slice(1)));
    else if (line.startsWith('+') && !line.startsWith('+++')) added.push(norm(line.slice(1)));
  }
  if (removed.length === 0 || removed.length !== added.length) return false;
  const a = [...removed].sort();
  const b = [...added].sort();
  return a.every((v, i) => v === b[i]);
}

/**
 * Reduce a unified diff to the changed lines plus a tight context window,
 * capping hunks per file (first + last + highest-scoring kept). File headers
 * are preserved so the diff stays attributable; trimmed context and dropped
 * hunks are elided. Recoverable via CCR. Output favours LLM readability over
 * `git apply` fidelity.
 */
function compressDiffCore(text: string, opts: ICompressOptions = {}): ICompressionResult {
  const lines = splitLines(text);
  const minLines = opts.minLines ?? 12;
  if (lines.length < minLines) return passthroughResult(text, EContentType.GitDiff);

  const tokens = queryTokens(opts.query);
  const maxContext = 3;
  const maxHunks = opts.maxItems ?? 12;

  const fileHeaderLines = new Map<number, number[]>();
  const hunks: IHunk[] = [];
  let currentFile = -1;
  let current: IHunk | null = null;
  let sawGitHeader = false; // a `diff --git` just opened the current file
  let expectPlusHeader = false; // a `--- ` file header was just seen; its `+++ ` partner is next

  const registerHeader = (i: number): void => {
    if (currentFile < 0) {
      currentFile = 0;
      if (!fileHeaderLines.has(0)) fileHeaderLines.set(0, []);
    }
    const list = fileHeaderLines.get(currentFile) ?? [];
    list.push(i);
    fileHeaderLines.set(currentFile, list);
    current = null; // header lines sit between hunks
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.startsWith('diff --git ')) {
      currentFile += 1;
      fileHeaderLines.set(currentFile, [i]);
      current = null;
      sawGitHeader = true;
      expectPlusHeader = false;
      continue;
    }
    if (HUNK_HEADER_RE.test(line)) {
      if (currentFile < 0) {
        currentFile = 0;
        if (!fileHeaderLines.has(0)) fileHeaderLines.set(0, []);
      }
      current = { file: currentFile, header: i, body: [], changeCount: 0, score: 0 };
      hunks.push(current);
      sawGitHeader = false;
      expectPlusHeader = false;
      continue;
    }
    // A `--- ` line is a file header only when its `+++ ` partner follows AND a
    // hunk header comes next — a real header is immediately followed by `@@`.
    // This rejects an in-hunk deleted/added content pair (`--- foo` / `+++ bar`)
    // that would otherwise be mistaken for a new file. It begins a NEW file
    // unless a `diff --git` already opened this one (headerless `diff -u`).
    if (
      line.startsWith('--- ') &&
      (lines[i + 1] ?? '').startsWith('+++ ') &&
      (lines[i + 2] ?? '').startsWith('@@')
    ) {
      if (!sawGitHeader) {
        currentFile += 1;
        fileHeaderLines.set(currentFile, []);
      }
      registerHeader(i);
      sawGitHeader = false;
      expectPlusHeader = true;
      continue;
    }
    if (expectPlusHeader && line.startsWith('+++ ')) {
      registerHeader(i);
      expectPlusHeader = false;
      continue;
    }
    if (SAFE_HEADER_RE.test(line)) {
      registerHeader(i);
      continue;
    }
    if (current) {
      current.body.push(i);
      if (isChangeLine(line)) {
        current.changeCount += 1;
        current.score += queryOverlap(line, tokens) * 0.3;
      }
    }
  }

  if (hunks.length === 0) return passthroughResult(text, EContentType.GitDiff);

  // Per-file hunk cap: always keep first + last, fill remainder by score.
  const keptHunks = new Set<IHunk>();
  const byFile = new Map<number, IHunk[]>();
  for (const h of hunks) {
    const list = byFile.get(h.file) ?? [];
    list.push(h);
    byFile.set(h.file, list);
  }
  for (const list of byFile.values()) {
    if (list.length <= maxHunks) {
      for (const h of list) keptHunks.add(h);
      continue;
    }
    // Select per file so the cap is honoured exactly: the first hunk, the last
    // (only if the cap allows two), then the highest-scoring until full. A
    // per-file set is the source of truth — a global counter has cross-file
    // slack and lets one file overflow by one.
    const fileKept = new Set<IHunk>();
    fileKept.add(list[0]!);
    if (maxHunks >= 2) fileKept.add(list[list.length - 1]!);
    const ranked = [...list].sort(
      (a, b) => (b.score - a.score) || (b.changeCount - a.changeCount) || (a.header - b.header),
    );
    for (const h of ranked) {
      if (fileKept.size >= maxHunks) break;
      fileKept.add(h);
    }
    for (const h of fileKept) keptHunks.add(h);
  }

  const keep = new Set<number>();
  const filesWithKeptHunk = new Set<number>();
  for (const h of keptHunks) filesWithKeptHunk.add(h.file);
  for (const [file, headerLines] of fileHeaderLines) {
    if (filesWithKeptHunk.has(file)) for (const i of headerLines) keep.add(i);
  }
  for (const h of keptHunks) {
    keep.add(h.header);
    // Mark change-line positions, then keep context within ±maxContext.
    const changePos = new Set<number>();
    for (let p = 0; p < h.body.length; p += 1) {
      const li = h.body[p]!;
      if (isChangeLine(lines[li] ?? '')) changePos.add(p);
    }
    for (let p = 0; p < h.body.length; p += 1) {
      const li = h.body[p]!;
      let near = changePos.has(p);
      if (!near) {
        for (let d = 1; d <= maxContext && !near; d += 1) {
          if (changePos.has(p - d) || changePos.has(p + d)) near = true;
        }
      }
      if (near) keep.add(li);
    }
  }

  const body = elide(lines, keep);
  return finalizeLossy({
    original: text,
    body,
    contentType: EContentType.GitDiff,
    strategy: ECompressionStrategy.Diff,
    opts,
    note: `full diff: ${hunks.length} hunks across ${byFile.size} files`,
  });
}
