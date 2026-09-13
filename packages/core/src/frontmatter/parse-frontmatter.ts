/**
 * THE frontmatter parser — an indentation-aware, `Result`-returning reader of
 * the YAML subset SharkCraft's Markdown documents use. Round 15 moved it down
 * from `@shrkcrft/generator` (where it read `spec.md`) so the Markdown
 * knowledge loader reads frontmatter through the SAME authority; the generator
 * re-exports it. The round-15 follow-up (F6) moved the last two ad-hoc readers
 * onto it — decision records (`sharkcraft/decisions/*.md`, `docs/adr/*.md`) and
 * Cursor `.mdc` rules — through {@link splitFrontmatter} and the `Text` scalar
 * mode; there is no other frontmatter parser in `packages/*\/src`.
 *
 * Supports:
 *   - `key: scalar` (string / number / boolean / null), `# comments`;
 *   - `key: [a, "b"]` inline scalar lists;
 *   - `key: |` (also `|-` / `|+`) literal block scalars, and `key: >` (also
 *     `>-` / `>+`) folded ones (lines joined by a space, a blank line kept);
 *   - `key:` + `  - item` — a list of scalars — or `- item` at the key's own
 *     column (YAML's compact sequence);
 *   - `key:` + `  - k: v` blocks — a list of maps with scalar, scalar-list or
 *     one-level-map values;
 *   - `key:` + `  subkey: value` — a one-level nested map.
 *
 * An indented line only ever belongs to the key above it — it can never set a
 * top-level field (the Markdown loader's old line splitter let `  id: x` under
 * any block overwrite the entry's id). Quoted strings: `'…'` and `"…"` (`\n`,
 * `\t`, `\\`, `\"` escapes). Out-of-grammar input is an `INVALID_INPUT` error
 * naming the 1-based line (plus {@link IParseFrontmatterOptions.lineOffset}).
 *
 * {@link IParseFrontmatterOptions.scalars} picks how an UNQUOTED value reads:
 * `Typed` (default — YAML numbers / booleans / null, a ` # …` tail is a
 * comment) or `Text` (verbatim: `0001`, `true`, `Fix #12` stay as written; only
 * a value wholly enclosed in one pair of quotes is unquoted, and only one whose
 * opening `[` closes at its end is a flow list — `[RFC] Adopt [Bun]` is text).
 * The grammar — keys, lists, maps, block scalars — is the same in both.
 *
 * {@link IParseFrontmatterOptions.keys} names the top-level keys a reader
 * reads: every other key's block is skipped unparsed, so YAML the parser does
 * not speak under a key nobody reads can never fail the read.
 *
 * {@link IParseFrontmatterOptions.listKeys} names the top-level keys a reader
 * reads as lists: an inline `[…]` under any other key is that key's one value
 * (`title: [WIP]` reads `[WIP]`), never a flow list.
 *
 * One quirk is deliberate (kept from the spec parser): a list item holding an
 * unquoted `:` is a MAP — `- file:src/a.ts` reads `{ file: 'src/a.ts' }` — and
 * a list holds plain values or maps, never both.
 *
 * Pure. No IO.
 */
import { AppErrorImpl, ERROR_CODES, type AppError } from '../result/errors.ts';
import { err, ok, type Result, type ResultErr } from '../result/result.ts';
import type { FrontmatterFieldValue } from './frontmatter-field-value.ts';
import type { FrontmatterScalar } from './frontmatter-scalar.ts';
import { FrontmatterScalarMode } from './frontmatter-scalar-mode.ts';
import type { FrontmatterValue } from './frontmatter-value.ts';
import type { IParseFrontmatterOptions } from './i-parse-frontmatter-options.ts';

/** `|`, `|-`, `|+`, `>`, `>-`, `>+` — a block scalar header (chomping indicators accepted). */
const BLOCK_SCALAR_HEADER = /^([|>])[-+]?$/;

function invalid(message: string): ResultErr<AppError> {
  return err(new AppErrorImpl(ERROR_CODES.INVALID_INPUT, message));
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isListItem(trimmed: string): boolean {
  return trimmed.startsWith('- ') || trimmed === '-';
}

export function parseFrontmatter(
  raw: string,
  options: IParseFrontmatterOptions = {},
): Result<Readonly<Record<string, FrontmatterValue>>, AppError> {
  const off = options.lineOffset ?? 0;
  const lines = raw.split('\n');
  const fields: Record<string, FrontmatterValue> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      i++;
      continue;
    }
    if (indentOf(line) !== 0) {
      return invalid(`Top-level key must start at column 0 (line ${i + 1 + off})`);
    }
    const colon = line.indexOf(':');
    if (colon === -1) return invalid(`Expected "<key>:" at line ${i + 1 + off}`);
    const key = line.slice(0, colon).trim();
    if (options.keys !== undefined && !options.keys.includes(key)) {
      // A key the caller never reads: its whole block is skipped unparsed.
      i = endOfBlock(lines, i + 1);
      continue;
    }
    if (!isValidKey(key)) return invalid(`Invalid key "${key}" at line ${i + 1 + off}`);
    const inline = line.slice(colon + 1).trim();

    const header = BLOCK_SCALAR_HEADER.exec(stripTrailingComment(inline).trim());
    if (header) {
      const block = readBlockScalar(lines, i + 1, header[1] === '>');
      fields[key] = block.text;
      i = block.nextIndex;
      continue;
    }

    if (inline.length > 0) {
      // A key the caller reads as ONE value (`listKeys` set, the key not in it):
      // an inline `[…]` is its text, never a flow list.
      const flowList = options.listKeys === undefined || options.listKeys.includes(key);
      const scalar = readInlineValue(inline, i + 1 + off, options, flowList);
      if (!scalar.ok) return err(scalar.error);
      fields[key] = scalar.value;
      i++;
      continue;
    }

    // No inline value — look ahead for a nested block.
    const peek = peekNonBlank(lines, i + 1);
    if (peek === null) {
      fields[key] = null;
      i++;
      continue;
    }
    const indent = indentOf(peek.line);
    if (isListItem(peek.line.trim())) {
      // Indented under the key, or at the key's own column (a compact sequence).
      const arr = parseArrayBlock(lines, i + 1, indent, off, options);
      if (!arr.ok) return err(arr.error);
      fields[key] = arr.value.value;
      i = arr.value.nextIndex;
      continue;
    }
    if (indent === 0) {
      fields[key] = null;
      i++;
      continue;
    }
    // Nested object block.
    const obj = parseObjectBlock(lines, i + 1, indent, off, options);
    if (!obj.ok) return err(obj.error);
    fields[key] = obj.value.value;
    i = obj.value.nextIndex;
  }
  return ok(fields);
}

function isValidKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key);
}

/**
 * One past the last line of the block whose top-level key line sits just
 * before `start`: the indented lines, column-0 list items (a compact
 * sequence), blank lines and comments under it. What
 * {@link IParseFrontmatterOptions.keys} skips for a key the caller never reads.
 */
function endOfBlock(lines: readonly string[], start: number): number {
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#') || indentOf(line) > 0 || isListItem(trimmed)) i++;
    else break;
  }
  return i;
}

interface IBlockScalarRead {
  readonly text: string;
  readonly nextIndex: number;
}

function readBlockScalar(lines: readonly string[], start: number, folded: boolean): IBlockScalarRead {
  let i = start;
  let baseIndent = -1;
  const collected: string[] = [];
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      collected.push('');
      i++;
      continue;
    }
    const indent = indentOf(line);
    if (baseIndent === -1) {
      if (indent === 0) break;
      baseIndent = indent;
    }
    if (indent < baseIndent) break;
    collected.push(line.slice(baseIndent));
    i++;
  }
  while (collected.length > 0 && collected[collected.length - 1] === '') {
    collected.pop();
  }
  if (!folded) return { text: collected.join('\n'), nextIndex: i };
  // Folded: consecutive lines join with a space; a blank line is a line break.
  let text = '';
  let afterBreak = true;
  for (const l of collected) {
    if (l === '') {
      text += '\n';
      afterBreak = true;
      continue;
    }
    text += (afterBreak ? '' : ' ') + l;
    afterBreak = false;
  }
  return { text, nextIndex: i };
}

function peekNonBlank(lines: readonly string[], start: number): { line: string; index: number } | null {
  for (let i = start; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    return { line: lines[i]!, index: i };
  }
  return null;
}

interface IArrayParseOk {
  value: FrontmatterValue;
  nextIndex: number;
}

const MIXED_LIST =
  'a list holds plain values or `key: value` maps, not both (an unquoted ":" makes an item a map)';

function parseArrayBlock(
  lines: readonly string[],
  start: number,
  expectedIndent: number,
  off: number,
  options: IParseFrontmatterOptions,
): Result<IArrayParseOk, AppError> {
  let i = start;
  const scalars: FrontmatterScalar[] = [];
  const objects: Record<string, FrontmatterFieldValue>[] = [];
  let mode: 'scalar' | 'object' | 'unknown' = 'unknown';
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      i++;
      continue;
    }
    const indent = indentOf(line);
    if (indent < expectedIndent) break;
    if (indent !== expectedIndent) {
      return invalid(`Inconsistent indent at line ${i + 1 + off} (expected ${expectedIndent}, got ${indent})`);
    }
    if (!trimmed.startsWith('-')) {
      // Sibling at same indent — end of array.
      break;
    }
    const itemBody = trimmed.replace(/^-\s?/, '');
    if (itemBody.length === 0) return invalid(`Empty array item at line ${i + 1 + off}`);
    // Object item iff it contains an unquoted `:`.
    const colonIdx = findUnquotedColon(itemBody);
    if (colonIdx === -1) {
      if (mode === 'object') return invalid(`Mixed array kinds at line ${i + 1 + off} — ${MIXED_LIST}`);
      mode = 'scalar';
      const scalar = parseInlineScalar(itemBody, i + 1 + off, options);
      if (!scalar.ok) return err(scalar.error);
      if (Array.isArray(scalar.value)) {
        return invalid(`Nested array values are not supported (line ${i + 1 + off})`);
      }
      scalars.push(scalar.value as FrontmatterScalar);
      i++;
      continue;
    }
    if (mode === 'scalar') return invalid(`Mixed array kinds at line ${i + 1 + off} — ${MIXED_LIST}`);
    mode = 'object';
    const obj: Record<string, FrontmatterFieldValue> = {};
    const firstKey = itemBody.slice(0, colonIdx).trim();
    const firstVal = itemBody.slice(colonIdx + 1).trim();
    if (!isValidKey(firstKey)) return invalid(`Invalid object key "${firstKey}" at line ${i + 1 + off}`);
    if (firstVal.length > 0) {
      const scalar = parseInlineScalar(firstVal, i + 1 + off, options);
      if (!scalar.ok) return err(scalar.error);
      obj[firstKey] = scalar.value as FrontmatterFieldValue;
    } else {
      obj[firstKey] = null;
    }
    i++;
    // Continuation lines: `  - id: x` was just consumed; further lines for
    // THIS object must be indented at `expectedIndent + 2`.
    const objIndent = expectedIndent + 2;
    while (i < lines.length) {
      const inner = lines[i]!;
      const innerTrim = inner.trim();
      if (innerTrim === '' || innerTrim.startsWith('#')) {
        i++;
        continue;
      }
      const innerIndent = indentOf(inner);
      if (innerIndent < objIndent) break;
      if (innerIndent > objIndent) {
        return invalid(`Object continuation must be indented to column ${objIndent} (line ${i + 1 + off})`);
      }
      const innerColon = findUnquotedColon(innerTrim);
      if (innerColon === -1) return invalid(`Expected "<key>: <value>" at line ${i + 1 + off}`);
      const k = innerTrim.slice(0, innerColon).trim();
      const v = innerTrim.slice(innerColon + 1).trim();
      if (!isValidKey(k)) return invalid(`Invalid object key "${k}" at line ${i + 1 + off}`);
      if (v.length === 0) {
        // Could be either a nested scalar array (e.g. `verifiedBy:`)
        // OR a nested scalar object (e.g. `variables:`). Peek and dispatch.
        const peek = peekNonBlank(lines, i + 1);
        if (peek) {
          const peekIndent = indentOf(peek.line);
          const peekTrim = peek.line.trim();
          if (peekIndent > objIndent) {
            if (isListItem(peekTrim)) {
              const arr = parseArrayBlock(lines, i + 1, peekIndent, off, options);
              if (!arr.ok) return err(arr.error);
              if (Array.isArray(arr.value.value) && arr.value.value.every(isScalarLike)) {
                obj[k] = arr.value.value as readonly FrontmatterScalar[];
              } else {
                return invalid(
                  `Nested object-arrays are not supported inside array-object items (line ${i + 1 + off})`,
                );
              }
              i = arr.value.nextIndex;
              continue;
            }
            // Nested object block (e.g. variables: { name: foo }).
            const sub = parseObjectBlock(lines, i + 1, peekIndent, off, options);
            if (!sub.ok) return err(sub.error);
            const flat: Record<string, FrontmatterScalar> = {};
            for (const [sk, sv] of Object.entries(sub.value.value)) {
              if (!isScalarLike(sv)) {
                return invalid(
                  `Nested objects within array-object items must contain scalar values only (line ${i + 1 + off})`,
                );
              }
              flat[sk] = sv as FrontmatterScalar;
            }
            obj[k] = flat;
            i = sub.value.nextIndex;
            continue;
          }
        }
        obj[k] = null;
      } else {
        const scalar = parseInlineScalar(v, i + 1 + off, options);
        if (!scalar.ok) return err(scalar.error);
        obj[k] = scalar.value as FrontmatterFieldValue;
      }
      i++;
    }
    objects.push(obj);
  }
  if (mode === 'object') return ok({ value: objects, nextIndex: i });
  return ok({ value: scalars, nextIndex: i });
}

interface IObjectParseOk {
  value: Readonly<Record<string, FrontmatterFieldValue>>;
  nextIndex: number;
}

function parseObjectBlock(
  lines: readonly string[],
  start: number,
  expectedIndent: number,
  off: number,
  options: IParseFrontmatterOptions,
): Result<IObjectParseOk, AppError> {
  const obj: Record<string, FrontmatterFieldValue> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      i++;
      continue;
    }
    const indent = indentOf(line);
    if (indent < expectedIndent) break;
    if (indent !== expectedIndent) {
      return invalid(`Inconsistent indent at line ${i + 1 + off} (expected ${expectedIndent}, got ${indent})`);
    }
    const colon = findUnquotedColon(trimmed);
    if (colon === -1) return invalid(`Expected "<key>: <value>" at line ${i + 1 + off}`);
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (!isValidKey(key)) return invalid(`Invalid object key "${key}" at line ${i + 1 + off}`);
    if (value.length === 0) {
      // Look ahead for an indented array (e.g. nested `packages:` with
      // a `  - foo` sub-list).
      const peek = peekNonBlank(lines, i + 1);
      if (peek) {
        const peekIndent = indentOf(peek.line);
        if (peekIndent > expectedIndent && isListItem(peek.line.trim())) {
          const arr = parseArrayBlock(lines, i + 1, peekIndent, off, options);
          if (!arr.ok) return err(arr.error);
          if (Array.isArray(arr.value.value) && arr.value.value.every(isScalarLike)) {
            obj[key] = arr.value.value as readonly FrontmatterScalar[];
          } else {
            return invalid(`Nested object-arrays are not supported inside nested objects (line ${i + 1 + off})`);
          }
          i = arr.value.nextIndex;
          continue;
        }
      }
      obj[key] = null;
    } else {
      const scalar = parseInlineScalar(value, i + 1 + off, options);
      if (!scalar.ok) return err(scalar.error);
      obj[key] = scalar.value as FrontmatterFieldValue;
    }
    i++;
  }
  return ok({ value: obj, nextIndex: i });
}

function isScalarLike(v: unknown): v is FrontmatterScalar {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function findUnquotedColon(s: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === ':' && !inSingle && !inDouble) return i;
  }
  return -1;
}

/**
 * Where the quoted scalar opening at `s[0]` closes — `\` escapes the next
 * character inside `"…"`, `''` is a quote inside `'…'` — or `-1`.
 */
function closingQuoteIndex(s: string): number {
  const quote = s[0];
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (quote === '"' && c === '\\') {
      i++;
      continue;
    }
    if (c !== quote) continue;
    if (quote === "'" && s[i + 1] === "'") {
      i++;
      continue;
    }
    return i;
  }
  return -1;
}

/**
 * Parse one inline value (`42`, `true`, `"a: b"`, `[a, b]`, a bare string).
 * `line` names it in an error; `options.scalars` picks the scalar reading
 * ({@link FrontmatterScalarMode}).
 */
export function parseInlineScalar(
  s: string,
  line: number,
  options: IParseFrontmatterOptions = {},
): Result<FrontmatterScalar | readonly FrontmatterScalar[], AppError> {
  return readInlineValue(s, line, options, true);
}

/**
 * {@link parseInlineScalar}, with `flowList` saying whether a `[…]` value may
 * be a flow list at all — `false` under a top-level key the caller reads as one
 * value ({@link IParseFrontmatterOptions.listKeys}).
 */
function readInlineValue(
  s: string,
  line: number,
  options: IParseFrontmatterOptions,
  flowList: boolean,
): Result<FrontmatterScalar | readonly FrontmatterScalar[], AppError> {
  if (options.scalars === FrontmatterScalarMode.Text) return parseTextScalar(s, line, options, flowList);
  const trimmed = stripTrailingComment(s).trim();
  if (trimmed.length === 0) return ok(null);
  if (trimmed === 'null' || trimmed === '~') return ok(null);
  if (trimmed === 'true') return ok(true);
  if (trimmed === 'false') return ok(false);
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return ok(unescapeDoubleQuoted(trimmed.slice(1, -1)));
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return ok(trimmed.slice(1, -1));
  }
  if (flowList && trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return parseInlineArray(trimmed, line, options);
  }
  if (/^-?\d+$/.test(trimmed)) {
    return ok(Number.parseInt(trimmed, 10));
  }
  if (/^-?\d+\.\d+$/.test(trimmed)) {
    return ok(Number.parseFloat(trimmed));
  }
  // Bare string (no quotes). Forbid embedded control characters.
  if (/[\x00-\x08\x0B-\x1F]/.test(trimmed)) {
    return invalid(`Control character in bare string at line ${line}`);
  }
  return ok(trimmed);
}

/** {@link FrontmatterScalarMode.Text}: verbatim text; only a wholly quoted value is unquoted. */
function parseTextScalar(
  s: string,
  line: number,
  options: IParseFrontmatterOptions,
  flowList: boolean,
): Result<FrontmatterScalar | readonly FrontmatterScalar[], AppError> {
  const trimmed = s.trim();
  if (trimmed.length === 0) return ok(null);
  if ((trimmed[0] === '"' || trimmed[0] === "'") && trimmed.length >= 2 && closingQuoteIndex(trimmed) === trimmed.length - 1) {
    const inner = trimmed.slice(1, -1);
    return ok(trimmed[0] === '"' ? unescapeDoubleQuoted(inner) : inner);
  }
  // A flow list only when its opening `[` closes at the very end — in
  // `[RFC] Adopt [Bun]` it closes after `[RFC]`, so the value is text (as the
  // old splitters read it), just as `"a" and "b"` is text, not a quoted scalar.
  if (flowList && trimmed.startsWith('[') && trimmed.endsWith(']') && !bracketClosesEarly(trimmed)) {
    return parseInlineArray(trimmed, line, options);
  }
  if (/[\x00-\x08\x0B-\x1F]/.test(trimmed)) {
    return invalid(`Control character in bare string at line ${line}`);
  }
  return ok(trimmed);
}

/**
 * Does the `[` opening `s` close BEFORE its last character (`[RFC] Adopt
 * [Bun]`)? Then `s` is not one flow list. Quote- and nesting-aware, as
 * {@link splitTopLevelCommas} is; a `[` that never closes is not "early".
 */
function bracketClosesEarly(s: string): boolean {
  let inSingle = false;
  let inDouble = false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (c === '[') depth++;
      else if (c === ']') {
        depth--;
        if (depth === 0) return i < s.length - 1;
      }
    }
  }
  return false;
}

function parseInlineArray(
  s: string,
  line: number,
  options: IParseFrontmatterOptions,
): Result<readonly FrontmatterScalar[], AppError> {
  const inner = s.slice(1, -1).trim();
  if (inner.length === 0) return ok([]);
  const parts = splitTopLevelCommas(inner);
  const out: FrontmatterScalar[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const scalar = parseInlineScalar(trimmed, line, options);
    if (!scalar.ok) return err(scalar.error);
    if (Array.isArray(scalar.value)) {
      return invalid(`Nested inline arrays are not supported (line ${line})`);
    }
    out.push(scalar.value as FrontmatterScalar);
  }
  return ok(out);
}

function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') depth--;
      else if (c === ',' && depth === 0) {
        out.push(cur);
        cur = '';
        continue;
      }
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function stripTrailingComment(s: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === '#' && !inSingle && !inDouble) {
      const prev = s[i - 1];
      if (prev === undefined || prev === ' ' || prev === '\t') return s.slice(0, i);
    }
  }
  return s;
}

function unescapeDoubleQuoted(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\' && i + 1 < s.length) {
      const next = s[i + 1]!;
      if (next === 'n') out += '\n';
      else if (next === 't') out += '\t';
      else if (next === '\\') out += '\\';
      else if (next === '"') out += '"';
      else out += next;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}
