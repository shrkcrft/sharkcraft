/**
 * Planned change model — v2.
 *
 * v1 templates emit CREATE-only entries via `files() → ITemplateFile[]`. The
 * v2 model lets templates declare explicit UPDATE-style operations (append,
 * insert-after, insert-before, replace, export) alongside CREATE entries.
 *
 * Each operation:
 *   - is declared by the template as a small structured intent;
 *   - is evaluated at plan time against the live file system;
 *   - resolves to a concrete `IFileChange` with precomputed final contents,
 *     a kind ("append" / "insert-after" / ... / "skip" / "conflict"),
 *     and a reason that explains what the engine decided.
 *
 * Hard rules preserved by this module:
 *   - No arbitrary code execution. Operations are data, not closures.
 *   - No hidden post-apply hooks. Every byte written ends up in `contents` and
 *     is shown in dry-run / plan review.
 *   - Same write path as v1: `generator-engine.generate()` writes the
 *     precomputed `contents`. Apply does not re-interpret the operation.
 *   - MCP stays read-only — this module is pure logic.
 */

import { FileChangeType, type IFileChange } from './file-change.ts';
import {
  type IPlannedOperation,
  type ICreateOperation,
  type IAppendOperation,
  type IInsertAfterOperation,
  type IInsertBeforeOperation,
  type IReplaceOperation,
  type IExportOperation,
} from './operations.ts';

// The operation model lives in ./operations.ts. Re-export it from here — this
// module is the public face of the planned-change pipeline, and its consumers
// (dry-run, saved-plan, synthetic-plan, and the @shrkcrft/generator barrel)
// import the operation types from this path.
export * from './operations.ts';

// ─────────────────────────────────────────────────────────────────────────────

export interface IPlannedChange {
  /** Final file path relative to project root. */
  targetPath: string;
  /** Operation intent. */
  operation: IPlannedOperation;
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation — converts an IPlannedChange + existing file state into IFileChange
// ─────────────────────────────────────────────────────────────────────────────

export interface IEvaluateInput {
  change: IPlannedChange;
  absolutePath: string;
  relativePath: string;
  /** Contents of the existing target file, or `null` if the file is absent. */
  existing: string | null;
}

export function evaluatePlannedChange(input: IEvaluateInput): IFileChange {
  const { change, absolutePath, relativePath, existing } = input;
  const op = change.operation;

  switch (op.kind) {
    case 'create':
      return evaluateCreate(op, absolutePath, relativePath, existing);
    case 'append':
      return evaluateAppend(op, absolutePath, relativePath, existing);
    case 'insert-after':
      return evaluateInsertAt(op, 'after', absolutePath, relativePath, existing);
    case 'insert-before':
      return evaluateInsertAt(op, 'before', absolutePath, relativePath, existing);
    case 'replace':
      return evaluateReplace(op, absolutePath, relativePath, existing);
    case 'export':
      return evaluateExport(op, absolutePath, relativePath, existing);
    case 'ensure-import':
      return evaluateEnsureImport(op, absolutePath, relativePath, existing);
    case 'insert-enum-entry':
      return evaluateInsertEnumEntry(op, absolutePath, relativePath, existing);
    case 'insert-object-entry':
      return evaluateInsertObjectEntry(op, absolutePath, relativePath, existing);
    case 'insert-array-entry':
      return evaluateInsertArrayEntry(op, absolutePath, relativePath, existing);
    case 'insert-before-closing-brace':
      return evaluateInsertBeforeClosingBrace(op, absolutePath, relativePath, existing);
    case 'insert-between-anchors':
      return evaluateInsertBetweenAnchors(op, absolutePath, relativePath, existing);
  }
}

function evaluateCreate(
  op: ICreateOperation,
  absolutePath: string,
  relativePath: string,
  existing: string | null,
): IFileChange {
  if (existing !== null) {
    if (existing === op.content) {
      return mkChange(
        FileChangeType.Skip,
        absolutePath,
        relativePath,
        op.content,
        'No changes (identical contents)',
        op,
      );
    }
    return mkChange(
      FileChangeType.Conflict,
      absolutePath,
      relativePath,
      op.content,
      'overwrite strategy: never (file exists)',
      op,
    );
  }
  return mkChange(
    FileChangeType.Create,
    absolutePath,
    relativePath,
    op.content,
    'New file (does not exist)',
    op,
  );
}

function evaluateAppend(
  op: IAppendOperation,
  absolutePath: string,
  relativePath: string,
  existing: string | null,
): IFileChange {
  if (existing === null) {
    return mkChange(
      FileChangeType.Conflict,
      absolutePath,
      relativePath,
      op.snippet,
      'append: target file does not exist',
      op,
    );
  }
  const marker = op.ifMissing ?? op.snippet;
  if (marker.length > 0 && existing.includes(marker)) {
    return mkChange(
      FileChangeType.Skip,
      absolutePath,
      relativePath,
      existing,
      'append: snippet already present (idempotent)',
      op,
    );
  }
  const next = existing.endsWith('\n') ? existing + op.snippet : existing + '\n' + op.snippet;
  return mkChange(
    FileChangeType.Append,
    absolutePath,
    relativePath,
    next,
    `append +${byteLen(op.snippet)}B`,
    op,
  );
}

function evaluateInsertAt(
  op: IInsertAfterOperation | IInsertBeforeOperation,
  position: 'after' | 'before',
  absolutePath: string,
  relativePath: string,
  existing: string | null,
): IFileChange {
  if (existing === null) {
    return mkChange(
      FileChangeType.Conflict,
      absolutePath,
      relativePath,
      op.snippet,
      `insert-${position}: target file does not exist`,
      op,
    );
  }
  const marker = op.ifMissing ?? op.snippet;
  if (marker.length > 0 && existing.includes(marker)) {
    return mkChange(
      FileChangeType.Skip,
      absolutePath,
      relativePath,
      existing,
      `insert-${position}: snippet already present (idempotent)`,
      op,
    );
  }
  const idx = existing.indexOf(op.anchor);
  if (idx < 0) {
    return mkChange(
      FileChangeType.Conflict,
      absolutePath,
      relativePath,
      existing,
      `insert-${position}: anchor not found`,
      op,
    );
  }
  // Ambiguity: multiple anchors → conflict (caller must be explicit).
  if (existing.indexOf(op.anchor, idx + op.anchor.length) >= 0) {
    return mkChange(
      FileChangeType.Conflict,
      absolutePath,
      relativePath,
      existing,
      `insert-${position}: anchor matches multiple sites (ambiguous)`,
      op,
    );
  }
  const cut = position === 'after' ? idx + op.anchor.length : idx;
  const next = existing.slice(0, cut) + op.snippet + existing.slice(cut);
  const type =
    position === 'after' ? FileChangeType.InsertAfter : FileChangeType.InsertBefore;
  return mkChange(
    type,
    absolutePath,
    relativePath,
    next,
    `insert-${position} +${byteLen(op.snippet)}B`,
    op,
  );
}

function evaluateReplace(
  op: IReplaceOperation,
  absolutePath: string,
  relativePath: string,
  existing: string | null,
): IFileChange {
  if (existing === null) {
    return mkChange(
      FileChangeType.Conflict,
      absolutePath,
      relativePath,
      op.replaceWith,
      'replace: target file does not exist',
      op,
    );
  }
  // Already-applied detection: if the file already contains the replacement
  // and not the original `find`, we treat as Skip (idempotent).
  const findCount = countOccurrences(existing, op.find);
  const replaceCount = countOccurrences(existing, op.replaceWith);
  if (findCount === 0 && replaceCount > 0) {
    return mkChange(
      FileChangeType.Skip,
      absolutePath,
      relativePath,
      existing,
      'replace: already applied',
      op,
    );
  }
  if (findCount === 0) {
    return mkChange(
      FileChangeType.Conflict,
      absolutePath,
      relativePath,
      existing,
      'replace: find text not found',
      op,
    );
  }
  const expected = op.expectMatches ?? 1;
  if (findCount !== expected) {
    return mkChange(
      FileChangeType.Conflict,
      absolutePath,
      relativePath,
      existing,
      `replace: expected ${expected} match(es), found ${findCount}`,
      op,
    );
  }
  const next = replaceAllLiteral(existing, op.find, op.replaceWith);
  return mkChange(
    FileChangeType.Replace,
    absolutePath,
    relativePath,
    next,
    `replace ${findCount}×`,
    op,
  );
}

function evaluateExport(
  op: IExportOperation,
  absolutePath: string,
  relativePath: string,
  existing: string | null,
): IFileChange {
  if (existing === null) {
    return mkChange(
      FileChangeType.Conflict,
      absolutePath,
      relativePath,
      buildExportLine(op),
      'export: target barrel file does not exist',
      op,
    );
  }
  const line = buildExportLine(op);
  const marker = op.ifMissing ?? line;
  if (existing.includes(marker)) {
    return mkChange(
      FileChangeType.Skip,
      absolutePath,
      relativePath,
      existing,
      'export: already present (idempotent)',
      op,
    );
  }
  const next = existing.endsWith('\n') ? existing + line + '\n' : existing + '\n' + line + '\n';
  return mkChange(
    FileChangeType.Export,
    absolutePath,
    relativePath,
    next,
    `export +1 line`,
    op,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function mkChange(
  type: FileChangeType,
  absolutePath: string,
  relativePath: string,
  contents: string,
  reason: string,
  operation: IPlannedOperation,
): IFileChange {
  return {
    type,
    absolutePath,
    relativePath,
    contents,
    reason,
    sizeBytes: byteLen(contents),
    operation,
  };
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) return count;
    count += 1;
    from = i + needle.length;
  }
}

function replaceAllLiteral(haystack: string, find: string, replaceWith: string): string {
  if (find.length === 0) return haystack;
  let out = '';
  let from = 0;
  while (true) {
    const i = haystack.indexOf(find, from);
    if (i < 0) {
      out += haystack.slice(from);
      return out;
    }
    out += haystack.slice(from, i) + replaceWith;
    from = i + find.length;
  }
}

function buildExportLine(op: IExportOperation): string {
  if (op.symbols && op.symbols.length > 0) {
    return `export { ${op.symbols.join(', ')} } from '${op.from}';`;
  }
  return `export * from '${op.from}';`;
}

/**
 * True if a change kind is an UPDATE-like operation (writes to an existing
 * file via a structural mutation). CREATE/Skip/Conflict/legacy-Update are not
 * update-like in the v2 sense.
 */
export function isUpdateLike(type: FileChangeType): boolean {
  return (
    type === FileChangeType.Append ||
    type === FileChangeType.InsertAfter ||
    type === FileChangeType.InsertBefore ||
    type === FileChangeType.Replace ||
    type === FileChangeType.Export
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Higher-level primitive evaluators
// ─────────────────────────────────────────────────────────────────────────────

function evaluateEnsureImport(
  op: Extract<IPlannedOperation, { kind: 'ensure-import' }>,
  absolutePath: string,
  relativePath: string,
  existing: string | null,
): IFileChange {
  if (existing === null) {
    return mkChange(
      FileChangeType.Conflict,
      absolutePath,
      relativePath,
      '',
      'ensure-import: target file does not exist',
      op,
    );
  }
  const desiredSymbols = [...(op.symbols ?? [])].filter((s) => s.length > 0);
  const fromSpec = op.from;
  const importRegex = buildImportRegex(fromSpec, op.typeOnly ?? false);
  const existingMatches = matchAll(existing, importRegex);
  const knownSymbols = new Set<string>();
  let knownDefault: string | null = null;
  let knownNamespace: string | null = null;
  for (const m of existingMatches) {
    const defBinding = m.groups?.['def'];
    const nsBinding = m.groups?.['ns'];
    const named = m.groups?.['named'];
    if (defBinding) knownDefault = defBinding;
    if (nsBinding) knownNamespace = nsBinding;
    if (named) {
      for (const piece of named.split(',')) {
        const sym = piece.replace(/^\s*(?:type\s+)?/, '').replace(/\s+as\s+.*$/, '').trim();
        if (sym.length > 0) knownSymbols.add(sym);
      }
    }
  }

  const wantsDefault = op.defaultBinding && op.defaultBinding.length > 0
    ? op.defaultBinding
    : null;
  const wantsNamespace = op.namespaceBinding && op.namespaceBinding.length > 0
    ? op.namespaceBinding
    : null;
  const missingSymbols = desiredSymbols.filter((s) => !knownSymbols.has(s));
  const needsDefault = wantsDefault !== null && knownDefault !== wantsDefault;
  const needsNamespace = wantsNamespace !== null && knownNamespace !== wantsNamespace;

  if (
    missingSymbols.length === 0 &&
    !needsDefault &&
    !needsNamespace
  ) {
    return mkChange(
      FileChangeType.Skip,
      absolutePath,
      relativePath,
      existing,
      'ensure-import: already present (idempotent)',
      op,
    );
  }

  // Compose a new import line. If there is an existing line we can merge into,
  // append the missing symbols to it; otherwise insert a fresh import at the
  // top of the file (after the leading comment block / shebang if any).
  if (existingMatches.length === 1 && wantsDefault === null && wantsNamespace === null) {
    const m = existingMatches[0]!;
    const namedGroup = m.groups?.['named'] ?? '';
    const merged = mergeNamedSymbols(namedGroup, missingSymbols);
    const newLine = m[0].replace(/\{[^}]*\}/, `{ ${merged} }`);
    const next = existing.slice(0, m.index!) + newLine + existing.slice(m.index! + m[0].length);
    return mkChange(
      FileChangeType.InsertAfter,
      absolutePath,
      relativePath,
      next,
      `ensure-import: merged ${missingSymbols.length} symbol(s) into existing import`,
      op,
    );
  }

  if (existingMatches.length > 1) {
    return mkChange(
      FileChangeType.Conflict,
      absolutePath,
      relativePath,
      existing,
      `ensure-import: ${existingMatches.length} import lines reference "${fromSpec}" (ambiguous)`,
      op,
    );
  }

  const importLine = buildImportLine(
    fromSpec,
    op.typeOnly ?? false,
    desiredSymbols,
    wantsDefault,
    wantsNamespace,
  );
  const insertAt = findImportInsertionPoint(existing);
  const next = existing.slice(0, insertAt) + importLine + '\n' + existing.slice(insertAt);
  return mkChange(
    FileChangeType.InsertBefore,
    absolutePath,
    relativePath,
    next,
    `ensure-import: added "${fromSpec}"`,
    op,
  );
}

function evaluateInsertEnumEntry(
  op: Extract<IPlannedOperation, { kind: 'insert-enum-entry' }>,
  absolutePath: string,
  relativePath: string,
  existing: string | null,
): IFileChange {
  if (existing === null) {
    return mkChange(
      FileChangeType.Conflict,
      absolutePath,
      relativePath,
      '',
      'insert-enum-entry: target file does not exist',
      op,
    );
  }
  const enumBlock = findEnumBlock(existing, op.enumName);
  if (!enumBlock) {
    return mkChange(
      FileChangeType.Conflict,
      absolutePath,
      relativePath,
      existing,
      `insert-enum-entry: enum "${op.enumName}" not found`,
      op,
    );
  }
  if (enumBlock.duplicate) {
    return mkChange(
      FileChangeType.Conflict,
      absolutePath,
      relativePath,
      existing,
      `insert-enum-entry: enum "${op.enumName}" appears multiple times (ambiguous)`,
      op,
    );
  }
  const body = existing.slice(enumBlock.openIdx + 1, enumBlock.closeIdx);
  if (new RegExp(`\\b${escapeRegex(op.entryName)}\\s*=`).test(body)) {
    return mkChange(
      FileChangeType.Skip,
      absolutePath,
      relativePath,
      existing,
      `insert-enum-entry: ${op.enumName}.${op.entryName} already present (idempotent)`,
      op,
    );
  }
  const indent = detectIndent(body) || '  ';
  const trailingTrim = body.replace(/[\s,]+$/, '');
  const needsComma = trailingTrim.length > 0;
  const valueLiteral = `'${op.entryValue.replace(/'/g, "\\'")}'`;
  const insertion = `${needsComma ? ',\n' : '\n'}${indent}${op.entryName} = ${valueLiteral}`;
  const next =
    existing.slice(0, enumBlock.openIdx + 1 + trailingTrim.length) +
    insertion +
    existing.slice(enumBlock.openIdx + 1 + trailingTrim.length);
  return mkChange(
    FileChangeType.InsertBefore,
    absolutePath,
    relativePath,
    next,
    `insert-enum-entry: added ${op.enumName}.${op.entryName}`,
    op,
  );
}

function evaluateInsertObjectEntry(
  op: Extract<IPlannedOperation, { kind: 'insert-object-entry' }>,
  absolutePath: string,
  relativePath: string,
  existing: string | null,
): IFileChange {
  if (existing === null) {
    return mkChange(
      FileChangeType.Conflict,
      absolutePath,
      relativePath,
      '',
      'insert-object-entry: target file does not exist',
      op,
    );
  }
  const obj = findObjectLiteralBlock(existing, op.objectName);
  if (!obj) {
    return mkChange(
      FileChangeType.Conflict,
      absolutePath,
      relativePath,
      existing,
      `insert-object-entry: object "${op.objectName}" not found`,
      op,
    );
  }
  if (obj.duplicate) {
    return mkChange(
      FileChangeType.Conflict,
      absolutePath,
      relativePath,
      existing,
      `insert-object-entry: object "${op.objectName}" appears multiple times (ambiguous)`,
      op,
    );
  }
  const body = existing.slice(obj.openIdx + 1, obj.closeIdx);
  if (new RegExp(`\\b${escapeRegex(op.entryKey)}\\s*:`).test(body)) {
    return mkChange(
      FileChangeType.Skip,
      absolutePath,
      relativePath,
      existing,
      `insert-object-entry: ${op.objectName}.${op.entryKey} already present (idempotent)`,
      op,
    );
  }
  const indent = detectIndent(body) || '  ';
  const trailingTrim = body.replace(/[\s,]+$/, '');
  const needsComma = trailingTrim.length > 0;
  const insertion = `${needsComma ? ',\n' : '\n'}${indent}${op.entryKey}: ${op.entryValue}`;
  const next =
    existing.slice(0, obj.openIdx + 1 + trailingTrim.length) +
    insertion +
    existing.slice(obj.openIdx + 1 + trailingTrim.length);
  return mkChange(
    FileChangeType.InsertBefore,
    absolutePath,
    relativePath,
    next,
    `insert-object-entry: added ${op.objectName}.${op.entryKey}`,
    op,
  );
}

function evaluateInsertArrayEntry(
  op: Extract<IPlannedOperation, { kind: 'insert-array-entry' }>,
  absolutePath: string,
  relativePath: string,
  existing: string | null,
): IFileChange {
  if (existing === null) {
    return mkChange(
      FileChangeType.Conflict,
      absolutePath,
      relativePath,
      '',
      'insert-array-entry: target file does not exist',
      op,
    );
  }
  // Try the primary array name, then each declared alternative in order. The
  // first cleanly-resolved (present + unambiguous) array wins. This lets a
  // template target a project whose registration array is named differently
  // without silently dead-ending.
  const candidates = [op.arrayName, ...(op.arrayNameAlternatives ?? [])].filter(
    (n) => n.length > 0,
  );
  let arr: IBlockLocation | null = null;
  let sawAmbiguous = false;
  for (const name of candidates) {
    const found = findArrayLiteralBlock(existing, name);
    if (!found) continue;
    if (found.duplicate) {
      sawAmbiguous = true;
      continue;
    }
    arr = found;
    break;
  }
  if (!arr) {
    return mkChange(
      FileChangeType.Conflict,
      absolutePath,
      relativePath,
      existing,
      unresolvedArrayReason(op, candidates, sawAmbiguous),
      op,
    );
  }
  // Idempotency: skip when the element (or its caller-supplied marker) is
  // already present anywhere inside the array body.
  const body = existing.slice(arr.openIdx + 1, arr.closeIdx);
  const marker = op.ifMissing ?? op.entryValue;
  if (marker.length > 0 && body.includes(marker)) {
    return mkChange(
      FileChangeType.Skip,
      absolutePath,
      relativePath,
      existing,
      `insert-array-entry: "${op.arrayName}" already contains entry (idempotent)`,
      op,
    );
  }
  const indent = detectIndent(body) || '  ';
  const trailingTrim = body.replace(/[\s,]+$/, '');
  const needsComma = trailingTrim.length > 0;
  const insertion = `${needsComma ? ',\n' : '\n'}${indent}${op.entryValue}`;
  const next =
    existing.slice(0, arr.openIdx + 1 + trailingTrim.length) +
    insertion +
    existing.slice(arr.openIdx + 1 + trailingTrim.length);
  return mkChange(
    FileChangeType.InsertBefore,
    absolutePath,
    relativePath,
    next,
    `insert-array-entry: added entry to ${op.arrayName}`,
    op,
  );
}

function evaluateInsertBeforeClosingBrace(
  op: Extract<IPlannedOperation, { kind: 'insert-before-closing-brace' }>,
  absolutePath: string,
  relativePath: string,
  existing: string | null,
): IFileChange {
  if (existing === null) {
    return mkChange(
      FileChangeType.Conflict,
      absolutePath,
      relativePath,
      '',
      'insert-before-closing-brace: target file does not exist',
      op,
    );
  }
  const marker = op.ifMissing ?? op.snippet;
  if (marker.length > 0 && existing.includes(marker)) {
    return mkChange(
      FileChangeType.Skip,
      absolutePath,
      relativePath,
      existing,
      'insert-before-closing-brace: already present (idempotent)',
      op,
    );
  }
  const block = findBlockByName(existing, op.containerName);
  if (!block) {
    return mkChange(
      FileChangeType.Conflict,
      absolutePath,
      relativePath,
      existing,
      `insert-before-closing-brace: container "${op.containerName}" not found`,
      op,
    );
  }
  if (block.duplicate) {
    return mkChange(
      FileChangeType.Conflict,
      absolutePath,
      relativePath,
      existing,
      `insert-before-closing-brace: container "${op.containerName}" appears multiple times (ambiguous)`,
      op,
    );
  }
  const indent = detectIndent(existing.slice(block.openIdx + 1, block.closeIdx)) || '  ';
  const insertion = `${indent}${op.snippet}\n`;
  const next =
    existing.slice(0, block.closeIdx) + insertion + existing.slice(block.closeIdx);
  return mkChange(
    FileChangeType.InsertBefore,
    absolutePath,
    relativePath,
    next,
    `insert-before-closing-brace: inserted into "${op.containerName}"`,
    op,
  );
}

function evaluateInsertBetweenAnchors(
  op: Extract<IPlannedOperation, { kind: 'insert-between-anchors' }>,
  absolutePath: string,
  relativePath: string,
  existing: string | null,
): IFileChange {
  if (existing === null) {
    return mkChange(
      FileChangeType.Conflict,
      absolutePath,
      relativePath,
      '',
      'insert-between-anchors: target file does not exist',
      op,
    );
  }
  const marker = op.ifMissing ?? op.snippet;
  if (marker.length > 0 && existing.includes(marker)) {
    return mkChange(
      FileChangeType.Skip,
      absolutePath,
      relativePath,
      existing,
      'insert-between-anchors: already present (idempotent)',
      op,
    );
  }
  // Anchor matching is line-bounded so anchors like `// region:body`
  // and `// region:body:end` don't trigger false-positive ambiguity.
  const beginMatches = findLineBoundedOccurrences(existing, op.beginAnchor);
  if (beginMatches.length === 0) {
    return mkChange(
      FileChangeType.Conflict,
      absolutePath,
      relativePath,
      existing,
      'insert-between-anchors: begin anchor not found',
      op,
    );
  }
  if (beginMatches.length > 1) {
    return mkChange(
      FileChangeType.Conflict,
      absolutePath,
      relativePath,
      existing,
      'insert-between-anchors: begin anchor matches multiple sites (ambiguous)',
      op,
    );
  }
  const beginIdx = beginMatches[0]!;
  const endMatches = findLineBoundedOccurrences(existing, op.endAnchor, beginIdx + op.beginAnchor.length);
  if (endMatches.length === 0) {
    return mkChange(
      FileChangeType.Conflict,
      absolutePath,
      relativePath,
      existing,
      'insert-between-anchors: end anchor not found after begin anchor',
      op,
    );
  }
  const endIdx = endMatches[0]!;
  const insertionPoint = beginIdx + op.beginAnchor.length;
  const between = existing.slice(insertionPoint, endIdx);
  const sep = between.endsWith('\n') ? '' : '\n';
  const next =
    existing.slice(0, endIdx) + sep + op.snippet + '\n' + existing.slice(endIdx);
  return mkChange(
    FileChangeType.InsertBefore,
    absolutePath,
    relativePath,
    next,
    `insert-between-anchors: inserted between anchors`,
    op,
  );
}

/**
 * Return indices where `needle` appears in `haystack` AS A FULL LINE-
 * BOUNDED OCCURRENCE: the character immediately after must be EOL or EOF.
 * The character before must be start-of-file or a newline.
 */
function findLineBoundedOccurrences(
  haystack: string,
  needle: string,
  startAt = 0,
): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  let from = startAt;
  while (true) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) return out;
    const afterChar = haystack[i + needle.length];
    const beforeChar = i === 0 ? '\n' : haystack[i - 1];
    const beforeOk = beforeChar === '\n' || beforeChar === '\r' || i === 0 ||
      // Tolerate leading whitespace on the anchor line.
      /[ \t]/.test(beforeChar ?? '');
    const afterOk = afterChar === undefined || afterChar === '\n' || afterChar === '\r';
    if (beforeOk && afterOk) out.push(i);
    from = i + needle.length;
  }
}

// ─── Helpers for primitive evaluators ───────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildImportRegex(fromSpec: string, typeOnly: boolean): RegExp {
  const fromEsc = escapeRegex(fromSpec);
  // Match: import [type] [<default>,] [* as <ns>,] [{ <named> },] from '<from>'
  const prefix = typeOnly ? 'import\\s+type\\s+' : 'import(?:\\s+type)?\\s+';
  return new RegExp(
    `${prefix}(?:(?<def>[A-Za-z_$][A-Za-z0-9_$]*)\\s*,?\\s*)?(?:\\*\\s+as\\s+(?<ns>[A-Za-z_$][A-Za-z0-9_$]*)\\s*,?\\s*)?(?:\\{(?<named>[^}]*)\\}\\s*)?from\\s+['"]${fromEsc}['"];?`,
    'g',
  );
}

function matchAll(input: string, re: RegExp): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    out.push(m);
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  return out;
}

function mergeNamedSymbols(existingNamed: string, additions: readonly string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string): void => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const key = trimmed.replace(/^type\s+/, '').replace(/\s+as\s+.*$/, '');
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };
  for (const piece of existingNamed.split(',')) push(piece);
  for (const sym of additions) push(sym);
  return out.join(', ');
}

function buildImportLine(
  fromSpec: string,
  typeOnly: boolean,
  symbols: readonly string[],
  defaultBinding: string | null,
  namespaceBinding: string | null,
): string {
  const keyword = typeOnly ? 'import type' : 'import';
  const parts: string[] = [];
  if (defaultBinding) parts.push(defaultBinding);
  if (namespaceBinding) parts.push(`* as ${namespaceBinding}`);
  if (symbols.length > 0) parts.push(`{ ${symbols.join(', ')} }`);
  if (parts.length === 0) {
    return `${keyword} '${fromSpec}';`;
  }
  return `${keyword} ${parts.join(', ')} from '${fromSpec}';`;
}

function findImportInsertionPoint(source: string): number {
  // Skip shebang + leading line comments + leading block comments.
  let i = 0;
  if (source.startsWith('#!')) {
    const nl = source.indexOf('\n');
    if (nl < 0) return source.length;
    i = nl + 1;
  }
  while (i < source.length) {
    // Skip whitespace lines.
    if (source[i] === '\n' || source[i] === '\r' || source[i] === '\t' || source[i] === ' ') {
      i += 1;
      continue;
    }
    if (source.startsWith('//', i)) {
      const nl = source.indexOf('\n', i);
      i = nl < 0 ? source.length : nl + 1;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) return source.length;
      i = end + 2;
      continue;
    }
    break;
  }
  return i;
}

interface IBlockLocation {
  openIdx: number;
  closeIdx: number;
  duplicate: boolean;
}

function findEnumBlock(source: string, enumName: string): IBlockLocation | null {
  const re = new RegExp(`\\benum\\s+${escapeRegex(enumName)}\\s*\\{`, 'g');
  return findBraceBlock(source, re);
}

function findObjectLiteralBlock(source: string, objectName: string): IBlockLocation | null {
  const re = new RegExp(
    `\\b(?:const|let|var)\\s+${escapeRegex(objectName)}\\b[^=]*=\\s*\\{`,
    'g',
  );
  return findBraceBlock(source, re);
}

function findArrayLiteralBlock(source: string, arrayName: string): IBlockLocation | null {
  const re = new RegExp(
    `\\b(?:const|let|var)\\s+${escapeRegex(arrayName)}\\b[^=]*=\\s*\\[`,
    'g',
  );
  return findBracketBlock(source, re);
}

function findBracketBlock(source: string, headRegex: RegExp): IBlockLocation | null {
  headRegex.lastIndex = 0;
  const first = headRegex.exec(source);
  if (!first) return null;
  const openIdx = first.index + first[0].length - 1;
  const second = headRegex.exec(source);
  const duplicate = second !== null;
  const closeIdx = findMatchingCloseBracket(source, openIdx);
  if (closeIdx < 0) return null;
  return { openIdx, closeIdx, duplicate };
}

function findMatchingCloseBracket(source: string, openBracketIdx: number): number {
  let depth = 0;
  let i = openBracketIdx;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

function findBlockByName(source: string, name: string): IBlockLocation | null {
  // Matches `class Name {`, `interface Name {`, `enum Name {`, `namespace Name {`.
  const re = new RegExp(
    `\\b(?:class|interface|enum|namespace|module)\\s+${escapeRegex(name)}\\b[^{]*\\{`,
    'g',
  );
  return findBraceBlock(source, re);
}

function findBraceBlock(source: string, headRegex: RegExp): IBlockLocation | null {
  headRegex.lastIndex = 0;
  const first = headRegex.exec(source);
  if (!first) return null;
  const openIdx = first.index + first[0].length - 1;
  const second = headRegex.exec(source);
  const duplicate = second !== null;
  const closeIdx = findMatchingClose(source, openIdx);
  if (closeIdx < 0) return null;
  return { openIdx, closeIdx, duplicate };
}

function findMatchingClose(source: string, openBraceIdx: number): number {
  let depth = 0;
  let i = openBraceIdx;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

function detectIndent(body: string): string | null {
  const match = body.match(/^([ \t]+)\S/m);
  if (!match) return null;
  return match[1] ?? null;
}

/**
 * Build the actionable reason for an `insert-array-entry` op whose target
 * array (and all declared alternatives) could not be resolved. Instead of an
 * opaque "array not found", the message tells the human exactly what to wire
 * by hand — preserving the template's "zero manual wiring" promise as an
 * explicit, honest fallback. A template author may override the message with
 * `op.manualStepInstruction`.
 */
function unresolvedArrayReason(
  op: Extract<IPlannedOperation, { kind: 'insert-array-entry' }>,
  candidates: readonly string[],
  sawAmbiguous: boolean,
): string {
  if (op.manualStepInstruction && op.manualStepInstruction.trim().length > 0) {
    return `insert-array-entry: MANUAL — ${op.manualStepInstruction.trim()}`;
  }
  const entry = oneLineEntryLabel(op.ifMissing ?? op.entryValue);
  const tried = candidates.map((c) => `"${c}"`).join(', ');
  const why = sawAmbiguous
    ? `registration array ${tried} appears multiple times (ambiguous)`
    : `no registration array found (tried ${tried})`;
  return `insert-array-entry: ${why} — wire ${entry} into ${op.arrayName} manually`;
}

function oneLineEntryLabel(raw: string): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed.length > 60 ? collapsed.slice(0, 57) + '…' : collapsed;
}
