/**
 * Shared entry-aware mutation primitives.
 *
 * Three apply paths (knowledge-stale, template-drift, templates-update)
 * all need the same primitive: find an object literal by `id`, walk to
 * its `{...}` range, then replace / insert / remove fields inside.
 *
 * Pure functions over file text. No IO. No inspector imports — operates
 * on raw TS source.
 */

export interface IEntryRange {
  /** Position of the opening `{` of the entry literal. */
  readonly open: number;
  /** Position of the matching closing `}`. */
  readonly close: number;
  /** Leading whitespace of the line containing the closing `}`. */
  readonly indent: string;
}

/**
 * Locate `{...}` range for an entry whose `id: '<id>'` appears in body.
 * Returns null when not found.
 *
 * Heuristic: locate the `id: 'entryId'` line (single or double quotes),
 * walk backwards to the nearest `{`, then walk forwards counting `{`/`}`
 * with string-literal awareness so braces inside strings don't unbalance
 * the count.
 */
export function findEntryRange(body: string, entryId: string): IEntryRange | null {
  const escaped = entryId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const idLineRe = new RegExp(`\\bid\\s*:\\s*['"]${escaped}['"]`);
  const m = idLineRe.exec(body);
  if (!m) return null;
  const idIdx = m.index;
  // Walk back to find the nearest `{`.
  let openIdx = -1;
  for (let i = idIdx; i >= 0; i--) {
    if (body[i] === '{') {
      openIdx = i;
      break;
    }
  }
  if (openIdx === -1) return null;
  // Walk forward to find the matching `}` accounting for nesting.
  let depth = 0;
  let closeIdx = -1;
  let inString: '"' | "'" | '`' | null = null;
  let escape = false;
  for (let i = openIdx; i < body.length; i++) {
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
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx === -1) return null;
  const lineStart = body.lastIndexOf('\n', closeIdx);
  const closingIndent = body.slice(lineStart + 1, closeIdx);
  return {
    open: openIdx,
    close: closeIdx,
    indent: closingIndent.replace(/[^ \t]/g, ''),
  };
}

/** True if the entry literal already declares a top-level field. */
export function entryHasField(body: string, range: IEntryRange, fieldName: string): boolean {
  const slice = body.slice(range.open, range.close + 1);
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\s*:`).test(slice);
}

/**
 * Insert a top-level field (TS source fragment) just before the closing
 * `}` of the entry literal. Indents the fragment to match the entry.
 *
 * The caller is responsible for ensuring `body[range.close] === '}'`.
 *
 * The inserted line ends with `\n + range.indent` so the closing `}`
 * re-lands on a properly indented line. `after` is preserved
 * verbatim — slicing the indent off here would strip the closing
 * `}` whenever it lived on its own indented line.
 */
export function insertField(
  body: string,
  range: IEntryRange,
  fieldFragment: string,
): string {
  const childIndent = range.indent + '  ';
  const indented = fieldFragment
    .split('\n')
    .map((l) => (l.length > 0 ? childIndent + l.replace(/^ {2}/, '') : l))
    .join('\n');
  const before = body.slice(0, range.close);
  const after = body.slice(range.close);
  const trimmedBefore = before.replace(/[ \t]*$/, '');
  const ensuredComma = /[,{][ \t\r\n]*$/.test(trimmedBefore)
    ? trimmedBefore
    : trimmedBefore.replace(/[ \t\r\n]*$/, '') + ',';
  const insertedLine =
    (ensuredComma.length > 0 && !ensuredComma.endsWith('\n') ? '\n' : '') +
    indented +
    '\n' +
    range.indent;
  return ensuredComma + insertedLine + after;
}

/**
 * Replace the value of a top-level scalar field inside the entry.
 * Matches `<fieldName>: <value>,` (single-line) and replaces the value.
 *
 * Returns `null` when the field isn't present or isn't single-line.
 */
export function replaceScalarField(
  body: string,
  range: IEntryRange,
  fieldName: string,
  newLiteral: string,
): string | null {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match `<indent><fieldName>: <value>,` on one line within the range.
  const slice = body.slice(range.open, range.close + 1);
  const re = new RegExp(`(\\n[ \\t]*${escaped}\\s*:\\s*)([^\\n]+?)(,?)(?=\\n)`, 'm');
  const m = re.exec(slice);
  if (!m) return null;
  const start = range.open + m.index;
  const end = start + m[0].length;
  const head = m[1] ?? '';
  const trailingComma = m[3] ?? ',';
  const replacement = head + newLiteral + (trailingComma || ',');
  return body.slice(0, start) + replacement + body.slice(end);
}

/**
 * Upsert: replace the field if present (single-line scalar), insert
 * otherwise. `fragmentForInsert` is the full `fieldName: value,` line
 * used when the field is absent. `newLiteralForReplace` is the value
 * portion used when the field is present.
 */
export function upsertScalarField(
  body: string,
  range: IEntryRange,
  fieldName: string,
  newLiteralForReplace: string,
  fragmentForInsert: string,
): { body: string; mode: 'replace' | 'insert' } {
  if (entryHasField(body, range, fieldName)) {
    const next = replaceScalarField(body, range, fieldName, newLiteralForReplace);
    if (next !== null) return { body: next, mode: 'replace' };
    // Field is present but multi-line — fall through to insert (caller
    // can decide whether to refuse). Conservative: insert anyway and let
    // the human review the duplicate.
  }
  return { body: insertField(body, range, fragmentForInsert), mode: 'insert' };
}

/**
 * Remove an element from a top-level array field by predicate on the
 * raw element text. The array is parsed shallowly — elements are split
 * at top-level commas (not inside nested `{}` / `[]` / strings).
 *
 * Returns `{ body, removedCount }`. Refuses (returns null) if the field
 * isn't a single-line OR brace-delimited array. Idempotent — calling
 * twice removes nothing on the second pass.
 */
export function removeArrayEntries(
  body: string,
  range: IEntryRange,
  fieldName: string,
  predicate: (element: string) => boolean,
): { body: string; removedCount: number } | null {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Find `<fieldName>: [` inside the entry.
  const slice = body.slice(range.open, range.close + 1);
  const fieldRe = new RegExp(`\\b${escaped}\\s*:\\s*\\[`);
  const fm = fieldRe.exec(slice);
  if (!fm) return null;
  const arrayOpenIdxInSlice = fm.index + fm[0].length - 1;
  const arrayOpenIdx = range.open + arrayOpenIdxInSlice;
  // Walk to the matching `]`, accounting for strings and nested
  // brackets.
  let depth = 0;
  let arrayCloseIdx = -1;
  let inString: '"' | "'" | '`' | null = null;
  let escapeFlag = false;
  for (let i = arrayOpenIdx; i < body.length; i++) {
    const c = body[i];
    if (escapeFlag) {
      escapeFlag = false;
      continue;
    }
    if (inString) {
      if (c === '\\') {
        escapeFlag = true;
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
  if (arrayCloseIdx === -1) return null;
  const inner = body.slice(arrayOpenIdx + 1, arrayCloseIdx);
  const elements = splitTopLevelCommas(inner);
  let removed = 0;
  const kept: string[] = [];
  for (const e of elements) {
    const trimmed = e.trim();
    if (trimmed.length === 0) {
      // Preserve trailing-comma-only segments verbatim.
      kept.push(e);
      continue;
    }
    if (predicate(trimmed)) {
      removed++;
    } else {
      kept.push(e);
    }
  }
  if (removed === 0) return { body, removedCount: 0 };
  // Recompose. Strip leading/trailing empty kept segments so we don't
  // double up commas.
  const trimmedKept = kept.map((k) => k).filter((k) => k.trim().length > 0);
  // If the original had a trailing newline + indent before `]`, preserve
  // it; otherwise collapse to a single line.
  const closingLineStart = body.lastIndexOf('\n', arrayCloseIdx);
  const closingIndent =
    closingLineStart === -1 ? '' : body.slice(closingLineStart + 1, arrayCloseIdx);
  const openLineEnd = body.indexOf('\n', arrayOpenIdx);
  const wasMultiline =
    openLineEnd !== -1 && openLineEnd < arrayCloseIdx && /^\s*$/.test(closingIndent);
  const newInner = wasMultiline
    ? '\n' + trimmedKept.map((e) => e.trim()).map((e) => closingIndent + '  ' + e).join(',\n') +
      (trimmedKept.length > 0 ? ',\n' + closingIndent : closingIndent)
    : trimmedKept.map((e) => e.trim()).join(', ');
  const nextBody =
    body.slice(0, arrayOpenIdx + 1) + newInner + body.slice(arrayCloseIdx);
  return { body: nextBody, removedCount: removed };
}

/**
 * Remove an element from a top-level array of strings by exact value.
 * Convenience wrapper over `removeArrayEntries`.
 */
export function removeStringFromArray(
  body: string,
  range: IEntryRange,
  fieldName: string,
  value: string,
): { body: string; removedCount: number } | null {
  return removeArrayEntries(body, range, fieldName, (el) => {
    const trimmed = el.trim().replace(/[,]$/, '').trim();
    // Strip quotes.
    const m = /^['"`](.*)['"`]$/.exec(trimmed);
    if (!m) return trimmed === value;
    return m[1] === value;
  });
}

/**
 * Find the `{...}` range of a nested object literal addressed by
 * `<fieldName>: {` within the enclosing entry range. Returns null when
 * the field is missing OR is not an object literal.
 *
 * Used by templates-update --apply to merge into `metadata.*` without
 * touching the surrounding entry.
 */
export function findNestedObjectRange(
  body: string,
  parentRange: IEntryRange,
  fieldName: string,
): IEntryRange | null {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const slice = body.slice(parentRange.open, parentRange.close + 1);
  const fieldRe = new RegExp(`\\b${escaped}\\s*:\\s*\\{`);
  const m = fieldRe.exec(slice);
  if (!m) return null;
  const openInSlice = m.index + m[0].length - 1;
  const openIdx = parentRange.open + openInSlice;
  let depth = 0;
  let closeIdx = -1;
  let inString: '"' | "'" | '`' | null = null;
  let escape = false;
  for (let i = openIdx; i < body.length; i++) {
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
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx === -1) return null;
  const lineStart = body.lastIndexOf('\n', closeIdx);
  const closingIndent = body.slice(lineStart + 1, closeIdx);
  return {
    open: openIdx,
    close: closeIdx,
    indent: closingIndent.replace(/[^ \t]/g, ''),
  };
}

/**
 * Read a top-level string array field's current values from the
 * entry literal. Returns the unquoted string values in source order, or
 * null when the field isn't a single-line OR brace-delimited array.
 *
 * Tolerates nested string-quoted commas and surrounding whitespace.
 * Used by templates-update --apply for `--add-tag` / `--remove-tag`
 * merge math.
 */
export function readStringArrayField(
  body: string,
  range: IEntryRange,
  fieldName: string,
): readonly string[] | null {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const slice = body.slice(range.open, range.close + 1);
  const fieldRe = new RegExp(`\\b${escaped}\\s*:\\s*\\[`);
  const m = fieldRe.exec(slice);
  if (!m) return null;
  const arrayOpenIdxInSlice = m.index + m[0].length - 1;
  const arrayOpenIdx = range.open + arrayOpenIdxInSlice;
  let depth = 0;
  let arrayCloseIdx = -1;
  let inString: '"' | "'" | '`' | null = null;
  let escapeFlag = false;
  for (let i = arrayOpenIdx; i < body.length; i++) {
    const c = body[i];
    if (escapeFlag) {
      escapeFlag = false;
      continue;
    }
    if (inString) {
      if (c === '\\') {
        escapeFlag = true;
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
  if (arrayCloseIdx === -1) return null;
  const inner = body.slice(arrayOpenIdx + 1, arrayCloseIdx);
  const elements = splitTopLevelCommas(inner);
  const out: string[] = [];
  for (const e of elements) {
    const trimmed = e.trim().replace(/,$/, '').trim();
    if (trimmed.length === 0) continue;
    const sm = /^['"`](.*)['"`]$/.exec(trimmed);
    if (!sm) return null;
    out.push(sm[1] ?? '');
  }
  return out;
}

/**
 * Split a comma-separated string at top-level commas (not inside
 * strings or nested brackets). Preserves the original spacing inside
 * each element so the caller can decide how to re-render.
 */
export function splitTopLevelCommas(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString: '"' | "'" | '`' | null = null;
  let escape = false;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
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
    else if (c === ']' || c === '}' || c === ')') depth--;
    else if (c === ',' && depth === 0) {
      out.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  out.push(inner.slice(start));
  return out;
}
