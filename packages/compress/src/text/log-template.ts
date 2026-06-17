/**
 * Drain-style log-template mining — a LOSSLESS pre-pass for {@link compressLog}.
 *
 * Repeated structured log lines (`worker-3 processing batch 17 ok` × N) carry
 * almost no new information per line: the fixed words repeat and only a few
 * variable tokens move. This miner tokenizes each line, replaces its variable
 * tokens (numbers, hex, UUIDs, ISO timestamps, quoted strings) with a `{}`
 * placeholder to form a *template*, groups consecutive lines sharing a
 * template, and collapses each run to one template plus a compact per-column
 * encoding of the captured variables.
 *
 * It is **lossless by construction**: a template is exactly the original line
 * with its variable matches replaced by `{}`, so `template ⋈ variables` rebuilds
 * every original line, in order — no CCR needed. {@link reconstructLogTemplates}
 * is the inverse and is exercised by the round-trip tests.
 *
 * Only runs with ≥1 variable column collapse; pure-identical repeats are left
 * for the downstream signal-selector's de-duplication so its behaviour (and the
 * `… N omitted …` markers callers rely on) is preserved.
 */

// Block sentinels. Chosen to never occur in real logs; if the input contains
// either, mining is skipped wholesale so a collision can't corrupt round-trip.
const BLOCK_OPEN = '⟦';
const BLOCK_CLOSE = '⟧';
const PLACEHOLDER = '{}';

/** Minimum consecutive same-template lines before a run is worth collapsing. */
const MIN_RUN = 3;

// Variable token classes, specific → general. Correctness of the round-trip
// does NOT depend on this list (template+matches always rebuild the line); it
// only governs how MUCH collapses.
const VAR_RE = new RegExp(
  [
    '\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?', // ISO timestamp
    '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', // UUID
    '0x[0-9a-fA-F]+', // hex literal
    '\\b[0-9a-fA-F]{12,}\\b', // long hash
    '"(?:[^"\\\\]|\\\\.)*"', // double-quoted string
    "'(?:[^'\\\\]|\\\\.)*'", // single-quoted string
    '\\d+(?:\\.\\d+)?', // integer / decimal
  ].join('|'),
  'g',
);

// High-signal lines the downstream selector keeps individually — never folded
// into a template, so an error / crash / stack frame always stays verbatim.
const SIGNAL_RE =
  /\b(?:ERROR|FATAL|FAIL(?:ED|URE)?|EXCEPTION|panic|segmentation fault|segfault|core dumped|bus error|out of memory|oom|traceback|undefined reference|undefined symbol|assertion (?:failed)|SIG(?:SEGV|ABRT|KILL|BUS|FPE|ILL))\b/i;
const STACK_RE = /^\s+(?:at\s+\S+|File ".*", line \d+)/;

export interface IMinedLog {
  /** The transformed line list with collapsible runs replaced by blocks. */
  lines: string[];
  /** True when at least one run collapsed. */
  reduced: boolean;
}

/** Collapse consecutive same-template runs. Lossless; reversible via {@link reconstructLogTemplates}. */
export function mineLogTemplates(lines: readonly string[]): IMinedLog {
  // A sentinel anywhere means we can't guarantee a clean round-trip — bail.
  for (const l of lines) {
    if (l.includes(BLOCK_OPEN) || l.includes(BLOCK_CLOSE)) {
      return { lines: [...lines], reduced: false };
    }
  }

  const templateOf = (line: string): string | null => {
    if (line.includes(PLACEHOLDER) || SIGNAL_RE.test(line) || STACK_RE.test(line)) return null;
    return line.replace(VAR_RE, PLACEHOLDER);
  };
  const templates = lines.map(templateOf);

  const out: string[] = [];
  let reduced = false;

  let i = 0;
  while (i < lines.length) {
    const tpl = templates[i];
    if (tpl === null || tpl === undefined) {
      out.push(lines[i] ?? '');
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < lines.length && templates[j] === tpl) j += 1;
    const run = lines.slice(i, j);
    const block = run.length >= MIN_RUN ? encodeBlock(tpl, run) : null;
    if (block) {
      out.push(...block);
      reduced = true;
    } else {
      out.push(...run);
    }
    i = j;
  }

  return { lines: out, reduced };
}

/**
 * Encode one run as a template block, or null when it isn't worth it (no
 * variable columns: pure-identical repeats are left for the selector's dedup).
 */
function encodeBlock(template: string, run: readonly string[]): string[] | null {
  const parts = template.split(PLACEHOLDER);
  const cols = parts.length - 1;
  const valuesPerLine = run.map((l) => l.match(VAR_RE) ?? []);

  // Fold constant columns into the template; collect the variable columns.
  let folded = parts[0] ?? '';
  const varColumns: string[][] = [];
  for (let c = 0; c < cols; c += 1) {
    const column = valuesPerLine.map((v) => v[c] ?? '');
    const allEqual = column.every((v) => v === column[0]);
    if (allEqual) {
      folded += column[0] ?? '';
    } else {
      folded += PLACEHOLDER;
      varColumns.push(column);
    }
    folded += parts[c + 1] ?? '';
  }

  // No moving parts → leave it for the selector's identical-line dedup.
  if (varColumns.length === 0) return null;

  const block = [`${BLOCK_OPEN}×${run.length}${BLOCK_CLOSE} ${folded}`];
  for (const column of varColumns) {
    block.push(`${BLOCK_OPEN}c${BLOCK_CLOSE} ${encodeColumn(column)}`);
  }
  block.push(`${BLOCK_OPEN}/${BLOCK_CLOSE}`);
  return block;
}

/** Encode one variable column as the tightest lossless form: seq | cyc | lit. */
function encodeColumn(values: readonly string[]): string {
  const seq = asArithmetic(values);
  if (seq) return `seq ${seq.start} ${seq.step}`;
  const cyc = asCycle(values);
  if (cyc) return `cyc ${cyc.map(escapeValue).join('|')}`;
  return `lit ${values.map(escapeValue).join('|')}`;
}

/** Decode a column encoding into its N values. */
function decodeColumn(enc: string, n: number): string[] {
  const sp = enc.indexOf(' ');
  const kind = sp < 0 ? enc : enc.slice(0, sp);
  const rest = sp < 0 ? '' : enc.slice(sp + 1);
  if (kind === 'seq') {
    const [start, step] = rest.split(' ').map((x) => Number(x));
    return Array.from({ length: n }, (_, k) => String((start ?? 0) + k * (step ?? 0)));
  }
  if (kind === 'cyc') {
    const pat = splitEscaped(rest);
    return Array.from({ length: n }, (_, k) => pat[k % pat.length] ?? '');
  }
  // lit
  return splitEscaped(rest);
}

/** An integer arithmetic progression that reconstructs every value canonically, else null. */
function asArithmetic(values: readonly string[]): { start: number; step: number } | null {
  if (values.length < 2) return null;
  const nums: number[] = [];
  for (const v of values) {
    // Canonical non-negative integer only (no leading zeros, fits exactly).
    if (!/^\d+$/.test(v) || (v.length > 1 && v[0] === '0') || v.length > 15) return null;
    nums.push(Number(v));
  }
  const step = nums[1]! - nums[0]!;
  for (let k = 0; k < nums.length; k += 1) {
    if (String(nums[0]! + k * step) !== values[k]) return null;
  }
  return { start: nums[0]!, step };
}

/** A short repeating pattern (period 2..8) that covers the whole column, else null. */
function asCycle(values: readonly string[]): string[] | null {
  const n = values.length;
  const maxPeriod = Math.min(8, Math.floor(n / 2));
  for (let p = 2; p <= maxPeriod; p += 1) {
    let ok = true;
    for (let k = 0; k < n; k += 1) {
      if (values[k] !== values[k % p]) {
        ok = false;
        break;
      }
    }
    if (ok) return values.slice(0, p);
  }
  return null;
}

function escapeValue(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

/** Split on unescaped `|` and unescape each field. Inverse of {@link escapeValue}. */
function splitEscaped(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      cur += s[i + 1];
      i += 1;
    } else if (ch === '|') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

const HEADER_RE = new RegExp(`^${BLOCK_OPEN}×(\\d+)${BLOCK_CLOSE} (.*)$`);
const COL_RE = new RegExp(`^${BLOCK_OPEN}c${BLOCK_CLOSE} (.*)$`);
const CLOSE = `${BLOCK_OPEN}/${BLOCK_CLOSE}`;

/** Inverse of {@link mineLogTemplates}: expand every block back to its original lines. */
export function reconstructLogTemplates(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const header = HEADER_RE.exec(lines[i] ?? '');
    if (!header) {
      out.push(lines[i] ?? '');
      i += 1;
      continue;
    }
    const n = Number(header[1]);
    const folded = header[2] ?? '';
    i += 1;
    const encodings: string[] = [];
    while (i < lines.length && lines[i] !== CLOSE) {
      const col = COL_RE.exec(lines[i] ?? '');
      if (col) encodings.push(col[1] ?? '');
      i += 1;
    }
    i += 1; // skip CLOSE
    const columns = encodings.map((enc) => decodeColumn(enc, n));
    const parts = folded.split(PLACEHOLDER);
    for (let k = 0; k < n; k += 1) {
      let line = parts[0] ?? '';
      for (let c = 0; c < columns.length; c += 1) {
        line += (columns[c]?.[k] ?? '') + (parts[c + 1] ?? '');
      }
      out.push(line);
    }
  }
  return out.join('\n');
}
