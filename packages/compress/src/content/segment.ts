import { EContentType } from './content-type.ts';
import { detectContentType } from './detect-content-type.ts';
import { splitLines } from '../text/line-utils.ts';

/**
 * A typed run of a mixed blob. {@link segmentContent} splits a heterogeneous
 * dump — prose interleaved with a JSON block and a stack trace, say — into
 * contiguous runs so each can be compressed by its own strategy instead of
 * forcing the whole blob through one. (P4.3)
 */
export interface IContentSegment {
  type: EContentType;
  text: string;
}

/** Coarse per-line class used to group adjacent non-JSON lines. */
function coarseClass(line: string): 'log' | 'search' | 'diff' | 'prose' {
  if (/^(?:diff --git |@@ |--- |\+\+\+ )/.test(line)) return 'diff';
  if (/^(?:[A-Za-z]:)?[^\s:]+:\d+:/.test(line)) return 'search';
  if (
    /^\s*\[?\d{4}-\d{2}-\d{2}[T ]/.test(line) ||
    /^\s*\[?(?:ERROR|FATAL|FAIL(?:ED|URE)?|WARN(?:ING)?|INFO|DEBUG|NOTICE|TRACE)\b/.test(line) ||
    /^\s+at\s+\S/.test(line) ||
    /^\s*Traceback\b/.test(line) ||
    /^[\w.$]*(?:Error|Exception):/.test(line)
  ) {
    return 'log';
  }
  return 'prose';
}

/**
 * If a JSON value opens at `start` (a line beginning `{`/`[`), return the index
 * of the line where it closes balanced and parses — multi-line only. Otherwise
 * null. String/escape aware so braces inside strings don't unbalance it.
 */
function findJsonBlock(lines: readonly string[], start: number): number | null {
  const open = (lines[start] ?? '').trimStart()[0];
  if (open !== '{' && open !== '[') return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let started = false;
  const limit = Math.min(lines.length, start + 2000);
  for (let j = start; j < limit; j += 1) {
    for (const ch of lines[j] ?? '') {
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{' || ch === '[') {
        depth += 1;
        started = true;
      } else if (ch === '}' || ch === ']') depth -= 1;
    }
    if (started && depth <= 0) {
      if (j === start) return null; // single-line JSON stays inline with prose
      try {
        JSON.parse(lines.slice(start, j + 1).join('\n').trim());
        return j;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Split `text` into typed segments. Contiguous multi-line JSON blocks are
 * isolated; the remaining lines are grouped into runs of one coarse class
 * (blank lines extend the current run), and each run's real type is detected.
 * A single-type blob yields exactly one segment.
 */
export function segmentContent(text: string): IContentSegment[] {
  const lines = splitLines(text);
  const n = lines.length;
  const cls: string[] = new Array(n).fill('');

  let i = 0;
  while (i < n) {
    const trimmed = (lines[i] ?? '').trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const end = findJsonBlock(lines, i);
      if (end !== null) {
        for (let k = i; k <= end; k += 1) cls[k] = 'json';
        i = end + 1;
        continue;
      }
    }
    cls[i] = coarseClass(lines[i] ?? '');
    i += 1;
  }

  // Group consecutive same-class lines; blank lines extend the current group.
  const groups: Array<{ start: number; end: number }> = [];
  for (let idx = 0; idx < n; idx += 1) {
    const blank = (lines[idx] ?? '').trim().length === 0;
    const last = groups[groups.length - 1];
    if (last && (blank || cls[idx] === cls[last.start])) {
      last.end = idx + 1;
    } else {
      groups.push({ start: idx, end: idx + 1 });
    }
  }

  return groups.map(({ start, end }) => {
    const segText = lines.slice(start, end).join('\n');
    return { type: detectContentType(segText), text: segText };
  });
}

/** Content classes that have a dedicated, materially-better compressor. */
export function isRichSegmentType(type: EContentType): boolean {
  return (
    type === EContentType.Json ||
    type === EContentType.JsonArray ||
    type === EContentType.BuildLog ||
    type === EContentType.GitDiff ||
    type === EContentType.SearchResults ||
    type === EContentType.SourceCode
  );
}
