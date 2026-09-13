import type { IBlankRunHazard } from './blank-run-hazard-finding.ts';

/**
 * Static lint: does this regex backtrack quadratically on a BLANKED buffer?
 *
 * A non-`all` `scan` zone blanks comments and strings into runs of spaces
 * (newlines kept, so line numbers stay true). A pattern that is fast on real
 * source becomes O(run²) on such a buffer when:
 *
 *   - (leading) an alternative's first mandatory construct — after only
 *     optional groups or non-restricting zero-width atoms — is a
 *     whitespace-consuming quantifier. Every offset of a run is a start, and
 *     each start re-scans the rest of the run. A start restricted to newlines
 *     (`(?:^|\n)`) is only a hazard when the quantifier also crosses newlines
 *     (`\s*`); `[ \t]*` then stops at the end of its line.
 *   - (adjacent) two whitespace-consuming quantifiers touch, separated only by
 *     optional items or whitespace-capable atoms — `\s*(?:<x>)?\s*=`, a lazy
 *     `[^;'"]*?` next to `\s*` — so the engine re-partitions each run between
 *     them.
 *
 * Measured: one such pattern took 3 ms on raw text and 5,402 ms on the
 * blanked buffer of the same file. This cannot be caught by tests over
 * ordinary source; it is caught here, from the pattern text, before it runs.
 *
 * Deterministic and advisory: a small tokenizer over the regex source, no
 * regex engine involved. It over-approximates (lookarounds are treated as
 * transparent; flags are ignored), which is the right direction for a hint.
 */
export function findBlankRunHazards(source: string): readonly IBlankRunHazard[] {
  const { alts } = parseAlternatives(source, 0);
  const found = new Map<string, IBlankRunHazard>();
  const report = (h: IBlankRunHazard): void => {
    const key = `${h.shape}@${h.index}`;
    const prev = found.get(key);
    // A repeated group is analysed twice; keep the WIDEST reach seen, so a
    // newline-crossing hazard is never under-reported as line-bounded.
    if (!prev || (h.crossesNewline && !prev.crossesNewline)) found.set(key, h);
  };
  for (const alt of alts) analyzeSeq(source, alt, { start: START_ANYWHERE, pending: null }, report);
  return [...found.values()].sort((a, b) => a.index - b.index || a.shape.localeCompare(b.shape));
}

/** Which blank-run characters (spaces, newlines) something can consume. */
interface IChars {
  readonly space: boolean;
  readonly newline: boolean;
}

const NONE: IChars = { space: false, newline: false };
const BOTH: IChars = { space: true, newline: true };
/** A quantifier whose upper bound exceeds this is treated as unbounded. */
const UNBOUNDED_ABOVE = 256;

interface IAtom {
  readonly t: 'atom';
  readonly chars: IChars;
  readonly start: number;
  readonly end: number;
  readonly min: number;
  readonly max: number;
}
interface IAnchor {
  readonly t: 'anchor';
  /** `^` / `$` / `\b` restrict where a match can start inside a blank run; `\B` does not. */
  readonly restricting: boolean;
  readonly start: number;
  readonly end: number;
}
interface ILook {
  readonly t: 'look';
  readonly alts: readonly RegexNode[][];
  readonly start: number;
  readonly end: number;
}
interface IGroup {
  readonly t: 'group';
  readonly alts: readonly RegexNode[][];
  readonly start: number;
  readonly end: number;
  readonly min: number;
  readonly max: number;
}
type RegexNode = IAtom | IAnchor | ILook | IGroup;

/** Where a match may still START inside a blank run, given what the pattern consumed so far. */
const START_RESTRICTED = 0;
const START_LINE = 1;
const START_ANYWHERE = 2;

interface IPending {
  readonly chars: IChars;
  /** Source offset of the earliest quantifier still "open" for adjacency. */
  readonly at: number;
}

interface IState {
  readonly start: number;
  /** The whitespace quantifier(s) nothing mandatory has separated from what follows. */
  readonly pending: IPending | null;
}

// ── parser ──────────────────────────────────────────────────────────────────

function parseAlternatives(src: string, from: number): { alts: RegexNode[][]; i: number } {
  const alts: RegexNode[][] = [[]];
  let i = from;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ')') break;
    if (ch === '|') {
      alts.push([]);
      i += 1;
      continue;
    }
    const item = parseItem(src, i);
    i = item.i;
    let node = item.node;
    const q = parseQuantifier(src, i);
    if (q) {
      i = q.i;
      if (node.t === 'atom' || node.t === 'group') node = { ...node, min: q.min, max: q.max, end: i };
    }
    alts[alts.length - 1]!.push(node);
  }
  return { alts, i };
}

function parseQuantifier(src: string, i: number): { min: number; max: number; i: number } | undefined {
  const ch = src[i];
  let min: number;
  let max: number;
  let j: number;
  if (ch === '*') [min, max, j] = [0, Infinity, i + 1];
  else if (ch === '+') [min, max, j] = [1, Infinity, i + 1];
  else if (ch === '?') [min, max, j] = [0, 1, i + 1];
  else if (ch === '{') {
    const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(src.slice(i));
    if (!m) return undefined; // a literal `{`
    min = Number(m[1]);
    max = m[2] === undefined ? min : m[3] === '' || m[3] === undefined ? Infinity : Number(m[3]);
    j = i + m[0].length;
  } else return undefined;
  if (src[j] === '?') j += 1; // lazy — same set of partitions, different order
  return { min, max, i: j };
}

function parseItem(src: string, i: number): { node: RegexNode; i: number } {
  const ch = src[i]!;
  if (ch === '(') return parseGroup(src, i);
  if (ch === '[') {
    const cls = parseClass(src, i);
    return { node: atom(cls.chars, i, cls.i), i: cls.i };
  }
  if (ch === '\\') {
    const esc = parseEscape(src, i, false);
    if (esc.anchor !== undefined) {
      return { node: { t: 'anchor', restricting: esc.anchor, start: i, end: esc.i }, i: esc.i };
    }
    return { node: atom(esc.chars, i, esc.i), i: esc.i };
  }
  if (ch === '^' || ch === '$') return { node: { t: 'anchor', restricting: true, start: i, end: i + 1 }, i: i + 1 };
  if (ch === '.') return { node: atom({ space: true, newline: false }, i, i + 1), i: i + 1 };
  return { node: atom(charOf(ch.charCodeAt(0)), i, i + 1), i: i + 1 };
}

function atom(chars: IChars, start: number, end: number): IAtom {
  return { t: 'atom', chars, start, end, min: 1, max: 1 };
}

function parseGroup(src: string, i: number): { node: RegexNode; i: number } {
  let j = i + 1;
  let look = false;
  if (src[j] === '?') {
    const next = src[j + 1];
    if (next === ':') j += 2;
    else if (next === '=' || next === '!') {
      look = true;
      j += 2;
    } else if (next === '<' && (src[j + 2] === '=' || src[j + 2] === '!')) {
      look = true;
      j += 3;
    } else if (next === '<') {
      const close = src.indexOf('>', j + 2);
      j = close === -1 ? src.length : close + 1;
    } else j += 1;
  }
  const inner = parseAlternatives(src, j);
  const end = inner.i < src.length ? inner.i + 1 : inner.i;
  if (look) return { node: { t: 'look', alts: inner.alts, start: i, end }, i: end };
  return { node: { t: 'group', alts: inner.alts, start: i, end, min: 1, max: 1 }, i: end };
}

/** A character class: which blank-run characters it matches. */
function parseClass(src: string, i: number): { chars: IChars; i: number } {
  let j = i + 1;
  const negated = src[j] === '^';
  if (negated) j += 1;
  let space = false;
  let newline = false;
  let first = true;
  let prevCode: number | undefined;
  while (j < src.length) {
    const ch = src[j]!;
    if (ch === ']' && !(first && false)) break;
    first = false;
    if (ch === '-' && prevCode !== undefined && src[j + 1] !== undefined && src[j + 1] !== ']') {
      // A range `a-b`: covers a blank char when it spans it.
      const hi = src[j + 1] === '\\' ? parseEscape(src, j + 1, true) : undefined;
      const hiCode = hi?.code ?? src.charCodeAt(j + 1);
      if (prevCode <= 0x20 && hiCode >= 0x20) space = true;
      if (prevCode <= 0x0a && hiCode >= 0x0a) newline = true;
      j = hi ? hi.i : j + 2;
      prevCode = undefined;
      continue;
    }
    if (ch === '\\') {
      const esc = parseEscape(src, j, true);
      if (esc.chars.space) space = true;
      if (esc.chars.newline) newline = true;
      prevCode = esc.code;
      j = esc.i;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code === 0x20) space = true;
    if (code === 0x0a) newline = true;
    prevCode = code;
    j += 1;
  }
  const end = j < src.length ? j + 1 : j;
  // `[]` matches nothing; `[^]` matches everything — both fall out of the rule.
  return { chars: negated ? { space: !space, newline: !newline } : { space, newline }, i: end };
}

/**
 * One escape. `anchor` is set for `\b` (restricting) / `\B` (not) outside a
 * class; `code` for a single-character escape (so a class range can use it).
 */
function parseEscape(
  src: string,
  i: number,
  inClass: boolean,
): { chars: IChars; i: number; anchor?: boolean; code?: number } {
  const c = src[i + 1];
  if (c === undefined) return { chars: NONE, i: i + 1 };
  const j = i + 2;
  switch (c) {
    case 's':
    case 'D':
    case 'W':
      return { chars: BOTH, i: j };
    case 'S':
    case 'd':
    case 'w':
      return { chars: NONE, i: j };
    case 'b':
      return inClass ? { chars: NONE, i: j, code: 8 } : { chars: NONE, i: j, anchor: true };
    case 'B':
      return { chars: NONE, i: j, anchor: false };
    case 'n':
      return { chars: charOf(0x0a), i: j, code: 0x0a };
    case 'r':
      return { chars: NONE, i: j, code: 0x0d };
    case 't':
      return { chars: NONE, i: j, code: 0x09 };
    case 'f':
      return { chars: NONE, i: j, code: 0x0c };
    case 'v':
      return { chars: NONE, i: j, code: 0x0b };
    case '0':
      return { chars: NONE, i: j, code: 0 };
    case 'x': {
      const m = /^[0-9a-fA-F]{2}/.exec(src.slice(j));
      if (!m) return { chars: NONE, i: j };
      const code = parseInt(m[0], 16);
      return { chars: charOf(code), i: j + 2, code };
    }
    case 'u': {
      const braced = /^\{([0-9a-fA-F]+)\}/.exec(src.slice(j));
      const plain = /^[0-9a-fA-F]{4}/.exec(src.slice(j));
      const hex = braced?.[1] ?? plain?.[0];
      if (hex === undefined) return { chars: NONE, i: j };
      const code = parseInt(hex, 16);
      return { chars: charOf(code), i: j + (braced ? braced[0].length : 4), code };
    }
    case 'c':
      return { chars: NONE, i: j + 1 };
    case 'k': {
      const close = src.indexOf('>', j);
      return { chars: NONE, i: close === -1 ? src.length : close + 1 };
    }
    case 'p':
    case 'P': {
      const m = /^\{([^}]*)\}/.exec(src.slice(j));
      const name = m?.[1] ?? '';
      const end = m ? j + m[0].length : j;
      if (c === 'P') return { chars: BOTH, i: end };
      if (/^(White_Space|space)$/i.test(name)) return { chars: BOTH, i: end };
      if (/^(Z|Zs|Separator|Space_Separator)$/i.test(name)) return { chars: { space: true, newline: false }, i: end };
      return { chars: NONE, i: end };
    }
    default:
      if (c >= '1' && c <= '9' && !inClass) {
        // A backreference — what it matches is not known statically.
        let k = j;
        while (k < src.length && src[k]! >= '0' && src[k]! <= '9') k += 1;
        return { chars: NONE, i: k };
      }
      return { chars: charOf(c.charCodeAt(0)), i: j, code: c.charCodeAt(0) };
  }
}

function charOf(code: number): IChars {
  return { space: code === 0x20, newline: code === 0x0a };
}

// ── analysis ────────────────────────────────────────────────────────────────

function wsCapable(c: IChars): boolean {
  return c.space || c.newline;
}

function overlaps(a: IChars, b: IChars): boolean {
  return (a.space && b.space) || (a.newline && b.newline);
}

function unionChars(a: IChars, b: IChars): IChars {
  return { space: a.space || b.space, newline: a.newline || b.newline };
}

function joinPending(a: IPending | null, b: IPending | null): IPending | null {
  if (a === null) return b;
  if (b === null) return a;
  return { chars: unionChars(a.chars, b.chars), at: Math.min(a.at, b.at) };
}

function join(a: IState, b: IState): IState {
  return { start: Math.max(a.start, b.start), pending: joinPending(a.pending, b.pending) };
}

/** State after consuming ONE mandatory character-matching item that is not an unbounded ws quantifier. */
function afterConsume(entry: IState, chars: IChars): IState {
  const start =
    entry.start === START_RESTRICTED
      ? START_RESTRICTED
      : chars.space
        ? entry.start
        : chars.newline
          ? START_LINE
          : START_RESTRICTED;
  // A mandatory character that can itself be blank does NOT separate two
  // whitespace quantifiers (`\s*\n\s*` still re-partitions the run).
  return { start, pending: wsCapable(chars) ? entry.pending : null };
}

/**
 * The blank chars a repeated group can consume when its body is made only of
 * whitespace-capable atoms (and optional / non-restricting items) — i.e. when
 * `(?:\s)+` behaves exactly like `\s+`. `undefined` otherwise.
 */
function groupWsChars(alts: readonly RegexNode[][]): IChars | undefined {
  let acc: IChars | undefined;
  for (const alt of alts) {
    let sawWs = false;
    let pure = true;
    let chars: IChars = NONE;
    for (const n of alt) {
      if (n.t === 'anchor') {
        if (n.restricting) pure = false;
        continue;
      }
      if (n.t === 'look') continue;
      if (n.t === 'atom') {
        if (wsCapable(n.chars)) {
          sawWs = true;
          chars = unionChars(chars, n.chars);
        } else if (n.min > 0) pure = false;
        continue;
      }
      const inner = groupWsChars(n.alts);
      if (inner) {
        sawWs = true;
        chars = unionChars(chars, inner);
      } else if (n.min > 0) pure = false;
    }
    if (pure && sawWs) acc = acc ? unionChars(acc, chars) : chars;
  }
  return acc;
}

function describe(src: string, start: number, end: number): string {
  return src.slice(start, end);
}

/** A whitespace-consuming unbounded quantifier — the construct every hazard is made of. */
function onWsQuantifier(
  src: string,
  chars: IChars,
  start: number,
  end: number,
  min: number,
  entry: IState,
  report: (h: IBlankRunHazard) => void,
): IState {
  const frag = describe(src, start, end);
  let startMode = entry.start;
  if (entry.start === START_ANYWHERE || (entry.start === START_LINE && chars.newline)) {
    report({
      shape: 'leading',
      index: start,
      fragment: frag,
      message:
        entry.start !== START_ANYWHERE
          ? `\`${frag}\` runs from every line start of a blank run across the lines below it — O(lines × run) per blanked comment`
          : chars.newline
            ? `\`${frag}\` can start a match at every offset of a blank run and re-scan the rest of it — O(run²) per blanked comment or string`
            : `\`${frag}\` can start a match at every offset of a blanked line and re-scan the rest of that line — O(line²) per blanked line`,
      // Reach: a quantifier that cannot consume `\n` stops at the end of its
      // line, so its cost on a blanked buffer is per LINE, not per run.
      crossesNewline: chars.newline,
      ...(entry.start === START_LINE ? { fromLineStart: true } : {}),
    });
    // One leading finding per alternative is enough — later constructs are
    // reached only through it.
    startMode = START_RESTRICTED;
  }
  if (entry.pending && overlaps(entry.pending.chars, chars)) {
    const pairFrag = describe(src, entry.pending.at, end);
    report({
      shape: 'adjacent',
      index: entry.pending.at,
      fragment: pairFrag,
      message: `\`${pairFrag}\` puts two whitespace-consuming quantifiers side by side with nothing mandatory between them — the engine re-partitions every blank run between them, O(run²)`,
      // The re-partitioning spans lines only when BOTH sides can take `\n`;
      // overlapping on spaces alone, it is bounded by each line.
      crossesNewline: entry.pending.chars.newline && chars.newline,
    });
  }
  const mine: IPending = { chars, at: start };
  // A skippable quantifier leaves the previous one still "open" as well.
  const pending = min === 0 ? joinPending(entry.pending, mine) : mine;
  const nextStart = startMode === START_RESTRICTED ? START_RESTRICTED : min === 0 ? startMode : startMode;
  return { start: nextStart, pending };
}

function analyzeNode(src: string, node: RegexNode, entry: IState, report: (h: IBlankRunHazard) => void): IState {
  switch (node.t) {
    case 'anchor':
      return node.restricting ? { start: START_RESTRICTED, pending: null } : entry;
    case 'look':
      // Hazards INSIDE a lookaround still cost time; the lookaround itself
      // consumes nothing, so it is transparent to its neighbours.
      for (const alt of node.alts) analyzeSeq(src, alt, { start: START_RESTRICTED, pending: null }, report);
      return entry;
    case 'atom': {
      if (node.max > UNBOUNDED_ABOVE && wsCapable(node.chars)) {
        return onWsQuantifier(src, node.chars, node.start, node.end, node.min, entry, report);
      }
      const after = afterConsume(entry, node.chars);
      return node.min === 0 ? join(entry, after) : after;
    }
    case 'group': {
      const repeatedWs = node.max > UNBOUNDED_ABOVE ? groupWsChars(node.alts) : undefined;
      if (repeatedWs) {
        // `(?:\s)+` is `\s+` — judge it as one quantifier.
        for (const alt of node.alts) analyzeSeq(src, alt, { start: START_RESTRICTED, pending: null }, report);
        return onWsQuantifier(src, repeatedWs, node.start, node.end, node.min, entry, report);
      }
      let exit = analyzeAlternatives(src, node.alts, entry, report);
      if (node.max > 1) {
        // A repeated group feeds its own entry: catch a body adjacent to itself.
        exit = analyzeAlternatives(src, node.alts, join(entry, exit), report);
      }
      return node.min === 0 ? join(entry, exit) : exit;
    }
  }
}

function analyzeAlternatives(
  src: string,
  alts: readonly RegexNode[][],
  entry: IState,
  report: (h: IBlankRunHazard) => void,
): IState {
  let exit: IState | undefined;
  for (const alt of alts) {
    const out = analyzeSeq(src, alt, entry, report);
    exit = exit ? join(exit, out) : out;
  }
  return exit ?? entry;
}

function analyzeSeq(
  src: string,
  seq: readonly RegexNode[],
  entry: IState,
  report: (h: IBlankRunHazard) => void,
): IState {
  let state = entry;
  for (const node of seq) state = analyzeNode(src, node, state, report);
  return state;
}
