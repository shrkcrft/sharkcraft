/**
 * Minimal YAML-frontmatter parser for spec.md.
 *
 * Supports the subset used by `sharkcraft.spec/v1` frontmatter:
 *   - `key: scalar` (string / number / boolean / null)
 *   - `key:` followed by a block-scalar `|` body
 *   - `key:` followed by `  - item` (array of scalars)
 *   - `key:` followed by `  - id: x` blocks (array of objects with scalar fields)
 *   - `key:` followed by `  subkey: value` (one-level nested objects)
 *
 * Quoted strings: `'...'` and `"..."` (no escape sequences beyond
 * `\n`, `\\`, `\"`).
 * Comments: `# ...` on their own line are stripped.
 * Out-of-grammar input throws with a 1-based line number.
 *
 * Pure parser. No IO. Lives in `@shrkcrft/generator` so the spec
 * model + parser can be reused from the CLI without pulling in the
 * inspector.
 */

import { AppErrorImpl, ERROR_CODES, err, ok, type AppError, type Result } from '@shrkcrft/core';

export type FrontmatterScalar = string | number | boolean | null;
export type FrontmatterFieldValue =
  | FrontmatterScalar
  | readonly FrontmatterScalar[]
  | Readonly<Record<string, FrontmatterScalar>>;
export type FrontmatterValue =
  | FrontmatterScalar
  | readonly FrontmatterScalar[]
  | ReadonlyArray<Readonly<Record<string, FrontmatterFieldValue>>>
  | Readonly<Record<string, FrontmatterFieldValue>>;

export interface IFrontmatterDocument {
  readonly fields: Readonly<Record<string, FrontmatterValue>>;
  /** Original frontmatter text (between the `---` delimiters), for hashing. */
  readonly raw: string;
}

export interface IParsedSpecMd {
  readonly frontmatter: IFrontmatterDocument;
  /** Markdown body (everything after the closing `---`). */
  readonly body: string;
}

const FRONTMATTER_DELIMITER = '---';

export function splitSpecMd(source: string): Result<IParsedSpecMd, AppError> {
  const lines = source.split('\n');
  if (lines.length === 0 || lines[0]!.trim() !== FRONTMATTER_DELIMITER) {
    return err(
      new AppErrorImpl(
        ERROR_CODES.INVALID_INPUT,
        'spec.md must begin with `---` on its first line',
      ),
    );
  }
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === FRONTMATTER_DELIMITER) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    return err(
      new AppErrorImpl(
        ERROR_CODES.INVALID_INPUT,
        'spec.md frontmatter not terminated (missing closing `---`)',
      ),
    );
  }
  const frontmatterLines = lines.slice(1, closeIdx);
  const raw = frontmatterLines.join('\n');
  const parsed = parseFrontmatter(raw);
  if (!parsed.ok) return err(parsed.error);
  const body = lines.slice(closeIdx + 1).join('\n');
  return ok({
    frontmatter: { fields: parsed.value, raw },
    body,
  });
}

export function parseFrontmatter(
  raw: string,
): Result<Readonly<Record<string, FrontmatterValue>>, AppError> {
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
    if (line.length !== line.trimStart().length) {
      return err(
        new AppErrorImpl(
          ERROR_CODES.INVALID_INPUT,
          `Top-level key must start at column 0 (line ${i + 1})`,
        ),
      );
    }
    const colon = line.indexOf(':');
    if (colon === -1) {
      return err(
        new AppErrorImpl(
          ERROR_CODES.INVALID_INPUT,
          `Expected "<key>:" at line ${i + 1}`,
        ),
      );
    }
    const key = line.slice(0, colon).trim();
    if (!isValidKey(key)) {
      return err(
        new AppErrorImpl(
          ERROR_CODES.INVALID_INPUT,
          `Invalid key "${key}" at line ${i + 1}`,
        ),
      );
    }
    const remainder = line.slice(colon + 1);
    const inline = remainder.trim();

    if (inline === '|') {
      const block = readBlockScalar(lines, i + 1);
      if (!block.ok) return err(block.error);
      fields[key] = block.value.text;
      i = block.value.nextIndex;
      continue;
    }

    if (inline.length > 0) {
      const scalar = parseInlineScalar(inline, i + 1);
      if (!scalar.ok) return err(scalar.error);
      fields[key] = scalar.value;
      i++;
      continue;
    }

    // No inline value — look ahead for nested block.
    const peek = peekNonBlank(lines, i + 1);
    if (peek === null) {
      fields[key] = null;
      i++;
      continue;
    }
    const indent = peek.line.length - peek.line.trimStart().length;
    if (indent === 0) {
      fields[key] = null;
      i++;
      continue;
    }
    const trimmedPeek = peek.line.trim();
    if (trimmedPeek.startsWith('- ') || trimmedPeek === '-') {
      const arr = parseArrayBlock(lines, i + 1, indent);
      if (!arr.ok) return err(arr.error);
      fields[key] = arr.value.value;
      i = arr.value.nextIndex;
      continue;
    }
    // Nested object block.
    const obj = parseObjectBlock(lines, i + 1, indent);
    if (!obj.ok) return err(obj.error);
    fields[key] = obj.value.value;
    i = obj.value.nextIndex;
  }
  return ok(fields);
}

function isValidKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key);
}

interface IBlockScalarOk {
  text: string;
  nextIndex: number;
}

function readBlockScalar(
  lines: readonly string[],
  start: number,
): Result<IBlockScalarOk, AppError> {
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
    const indent = line.length - line.trimStart().length;
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
  return ok({ text: collected.join('\n'), nextIndex: i });
}

function peekNonBlank(
  lines: readonly string[],
  start: number,
): { line: string; index: number } | null {
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

function parseArrayBlock(
  lines: readonly string[],
  start: number,
  expectedIndent: number,
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
    const indent = line.length - line.trimStart().length;
    if (indent < expectedIndent) break;
    if (indent !== expectedIndent) {
      return err(
        new AppErrorImpl(
          ERROR_CODES.INVALID_INPUT,
          `Inconsistent indent at line ${i + 1} (expected ${expectedIndent}, got ${indent})`,
        ),
      );
    }
    if (!trimmed.startsWith('-')) {
      // Sibling at same indent — end of array.
      break;
    }
    const itemBody = trimmed.replace(/^-\s?/, '');
    if (itemBody.length === 0) {
      return err(
        new AppErrorImpl(
          ERROR_CODES.INVALID_INPUT,
          `Empty array item at line ${i + 1}`,
        ),
      );
    }
    // Object item iff it contains an unquoted `:`.
    const colonIdx = findUnquotedColon(itemBody);
    if (colonIdx === -1) {
      if (mode === 'object') {
        return err(
          new AppErrorImpl(
            ERROR_CODES.INVALID_INPUT,
            `Mixed array kinds at line ${i + 1}`,
          ),
        );
      }
      mode = 'scalar';
      const scalar = parseInlineScalar(itemBody, i + 1);
      if (!scalar.ok) return err(scalar.error);
      if (Array.isArray(scalar.value)) {
        return err(
          new AppErrorImpl(
            ERROR_CODES.INVALID_INPUT,
            `Nested array values are not supported (line ${i + 1})`,
          ),
        );
      }
      scalars.push(scalar.value as FrontmatterScalar);
      i++;
      continue;
    }
    if (mode === 'scalar') {
      return err(
        new AppErrorImpl(
          ERROR_CODES.INVALID_INPUT,
          `Mixed array kinds at line ${i + 1}`,
        ),
      );
    }
    mode = 'object';
    const obj: Record<string, FrontmatterFieldValue> = {};
    const firstKey = itemBody.slice(0, colonIdx).trim();
    const firstVal = itemBody.slice(colonIdx + 1).trim();
    if (!isValidKey(firstKey)) {
      return err(
        new AppErrorImpl(
          ERROR_CODES.INVALID_INPUT,
          `Invalid object key "${firstKey}" at line ${i + 1}`,
        ),
      );
    }
    if (firstVal.length > 0) {
      const scalar = parseInlineScalar(firstVal, i + 1);
      if (!scalar.ok) return err(scalar.error);
      obj[firstKey] = scalar.value as FrontmatterFieldValue;
    } else {
      obj[firstKey] = null;
    }
    i++;
    // Collect continuation lines: `  - id: x` was just consumed; further
    // lines for THIS object must be indented at `expectedIndent + 2`.
    const objIndent = expectedIndent + 2;
    while (i < lines.length) {
      const inner = lines[i]!;
      const innerTrim = inner.trim();
      if (innerTrim === '' || innerTrim.startsWith('#')) {
        i++;
        continue;
      }
      const innerIndent = inner.length - inner.trimStart().length;
      if (innerIndent < objIndent) break;
      if (innerIndent > objIndent) {
        return err(
          new AppErrorImpl(
            ERROR_CODES.INVALID_INPUT,
            `Object continuation must be indented to column ${objIndent} (line ${i + 1})`,
          ),
        );
      }
      const innerColon = findUnquotedColon(innerTrim);
      if (innerColon === -1) {
        return err(
          new AppErrorImpl(
            ERROR_CODES.INVALID_INPUT,
            `Expected "<key>: <value>" at line ${i + 1}`,
          ),
        );
      }
      const k = innerTrim.slice(0, innerColon).trim();
      const v = innerTrim.slice(innerColon + 1).trim();
      if (!isValidKey(k)) {
        return err(
          new AppErrorImpl(
            ERROR_CODES.INVALID_INPUT,
            `Invalid object key "${k}" at line ${i + 1}`,
          ),
        );
      }
      if (v.length === 0) {
        // Could be either a nested scalar array (e.g. `verifiedBy:`)
        // OR a nested scalar object (e.g. `variables:`). Peek and dispatch.
        const peek = peekNonBlank(lines, i + 1);
        if (peek) {
          const peekIndent = peek.line.length - peek.line.trimStart().length;
          const peekTrim = peek.line.trim();
          if (peekIndent > objIndent) {
            if (peekTrim.startsWith('- ') || peekTrim === '-') {
              const arr = parseArrayBlock(lines, i + 1, peekIndent);
              if (!arr.ok) return err(arr.error);
              if (Array.isArray(arr.value.value) && arr.value.value.every(isScalarLike)) {
                obj[k] = arr.value.value as readonly FrontmatterScalar[];
              } else {
                return err(
                  new AppErrorImpl(
                    ERROR_CODES.INVALID_INPUT,
                    `Nested object-arrays are not supported inside array-object items (line ${i + 1})`,
                  ),
                );
              }
              i = arr.value.nextIndex;
              continue;
            }
            // Nested object block (e.g. variables: { name: foo }).
            const sub = parseObjectBlock(lines, i + 1, peekIndent);
            if (!sub.ok) return err(sub.error);
            const flat: Record<string, FrontmatterScalar> = {};
            for (const [sk, sv] of Object.entries(sub.value.value)) {
              if (!isScalarLike(sv)) {
                return err(
                  new AppErrorImpl(
                    ERROR_CODES.INVALID_INPUT,
                    `Nested objects within array-object items must contain scalar values only (line ${i + 1})`,
                  ),
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
        const scalar = parseInlineScalar(v, i + 1);
        if (!scalar.ok) return err(scalar.error);
        obj[k] = scalar.value as FrontmatterFieldValue;
      }
      i++;
    }
    objects.push(obj);
  }
  if (mode === 'object') {
    return ok({ value: objects, nextIndex: i });
  }
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
    const indent = line.length - line.trimStart().length;
    if (indent < expectedIndent) break;
    if (indent !== expectedIndent) {
      return err(
        new AppErrorImpl(
          ERROR_CODES.INVALID_INPUT,
          `Inconsistent indent at line ${i + 1} (expected ${expectedIndent}, got ${indent})`,
        ),
      );
    }
    const colon = findUnquotedColon(trimmed);
    if (colon === -1) {
      return err(
        new AppErrorImpl(
          ERROR_CODES.INVALID_INPUT,
          `Expected "<key>: <value>" at line ${i + 1}`,
        ),
      );
    }
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (!isValidKey(key)) {
      return err(
        new AppErrorImpl(
          ERROR_CODES.INVALID_INPUT,
          `Invalid object key "${key}" at line ${i + 1}`,
        ),
      );
    }
    if (value.length === 0) {
      // Look ahead for an indented array (e.g. nested `packages:` with
      // a `  - foo` sub-list).
      const peek = peekNonBlank(lines, i + 1);
      if (peek) {
        const peekIndent = peek.line.length - peek.line.trimStart().length;
        const peekTrim = peek.line.trim();
        if (peekIndent > expectedIndent && (peekTrim.startsWith('- ') || peekTrim === '-')) {
          const arr = parseArrayBlock(lines, i + 1, peekIndent);
          if (!arr.ok) return err(arr.error);
          if (Array.isArray(arr.value.value) && arr.value.value.every(isScalarLike)) {
            obj[key] = arr.value.value as readonly FrontmatterScalar[];
          } else {
            return err(
              new AppErrorImpl(
                ERROR_CODES.INVALID_INPUT,
                `Nested object-arrays are not supported inside nested objects (line ${i + 1})`,
              ),
            );
          }
          i = arr.value.nextIndex;
          continue;
        }
      }
      obj[key] = null;
    } else {
      const scalar = parseInlineScalar(value, i + 1);
      if (!scalar.ok) return err(scalar.error);
      obj[key] = scalar.value as FrontmatterFieldValue;
    }
    i++;
  }
  return ok({ value: obj, nextIndex: i });
}

function isScalarLike(v: unknown): v is FrontmatterScalar {
  return (
    v === null ||
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean'
  );
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

export function parseInlineScalar(
  s: string,
  line: number,
): Result<FrontmatterScalar | readonly FrontmatterScalar[], AppError> {
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
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return parseInlineArray(trimmed, line);
  }
  if (/^-?\d+$/.test(trimmed)) {
    return ok(Number.parseInt(trimmed, 10));
  }
  if (/^-?\d+\.\d+$/.test(trimmed)) {
    return ok(Number.parseFloat(trimmed));
  }
  // Bare string (no quotes). Forbid embedded control characters.
  if (/[\x00-\x08\x0B-\x1F]/.test(trimmed)) {
    return err(
      new AppErrorImpl(
        ERROR_CODES.INVALID_INPUT,
        `Control character in bare string at line ${line}`,
      ),
    );
  }
  return ok(trimmed);
}

function parseInlineArray(s: string, line: number): Result<readonly FrontmatterScalar[], AppError> {
  const inner = s.slice(1, -1).trim();
  if (inner.length === 0) return ok([]);
  const parts = splitTopLevelCommas(inner);
  const out: FrontmatterScalar[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const scalar = parseInlineScalar(trimmed, line);
    if (!scalar.ok) return err(scalar.error);
    if (Array.isArray(scalar.value)) {
      return err(
        new AppErrorImpl(
          ERROR_CODES.INVALID_INPUT,
          `Nested inline arrays are not supported (line ${line})`,
        ),
      );
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
