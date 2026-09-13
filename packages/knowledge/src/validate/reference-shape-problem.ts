import { describeEntryValue } from '@shrkcrft/core';
import { parseReferenceSpec, referenceSpecProblem } from '../format/knowledge-reference-format.ts';
import { KnowledgeSourceFormat } from '../model/knowledge-source-format.ts';

/**
 * Reference fields read as strings. A list or a map there cannot be checked —
 * a `path: [a, b]` reached `path.join` and crashed the stale-check.
 * (`contains` / `matches` / `scan` / `kind` keep their own, older checks.)
 */
const STRING_FIELDS = ['path', 'symbol', 'id', 'command', 'note'] as const;

/** `{ kind: 'file', path: 'src/a.ts' }` — the object literal a compact spec stands for. */
function objectLiteral(ref: object): string {
  const fields = Object.entries(ref).map(([k, v]) => `${k}: ${typeof v === 'string' ? `'${v}'` : String(v)}`);
  return `{ ${fields.join(', ')} }`;
}

/**
 * Why one `references[]` item is not even a well-typed reference object —
 * `undefined` when it is one (its kind and required fields are judged next).
 *
 * THE item-shape predicate: the validator (`invalid-reference`) and the
 * stale-check (an INVALID row) both apply it, so a TypeScript item and a
 * Markdown frontmatter item fail the same way. A Markdown compact string the
 * grammar accepts never reaches here — the loader has already read it into an
 * object — so a string here is one the grammar refused, or a TypeScript string.
 */
export function referenceShapeProblem(ref: unknown): string | undefined {
  if (typeof ref === 'string') {
    const spec = parseReferenceSpec(ref);
    return spec
      ? `is the string ${describeEntryValue(ref)} — a references[] item is an object: write ${objectLiteral(spec)} (the compact kind:value string is read from a Markdown references: frontmatter list only)`
      : `is the string ${describeEntryValue(ref)}, which is not a reference spec (kind:value[:required]): ${referenceSpecProblem(ref)}`;
  }
  if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) {
    return `is not an object (got ${describeEntryValue(ref)})`;
  }
  for (const field of STRING_FIELDS) {
    const value = (ref as Record<string, unknown>)[field];
    if (value !== undefined && typeof value !== 'string') {
      return `has a non-string \`${field}\` (got ${describeEntryValue(value)})`;
    }
  }
  // Round 15 follow-up (F10): `required` is a boolean. `required: yes` (a
  // Markdown string) or `'yes'` read as NOT required — `--ci` / `--strict` then
  // waived the very reference the author meant to block on. Malformed, never a
  // silent downgrade; the same predicate for a TypeScript and a Markdown item.
  const required = (ref as Record<string, unknown>)['required'];
  if (required !== undefined && typeof required !== 'boolean') {
    return `has a non-boolean \`required\` (got ${describeEntryValue(required)}) — write required: true or required: false`;
  }
  return undefined;
}

/**
 * Why an entry's `references` VALUE is not a list — `undefined` when it is one
 * (or absent). A non-list value is a validation issue that KEEPS the entry
 * (the `validateCrossReferenceFields` precedent), never a crash; `format` picks
 * the spelling of the fix.
 */
export function referencesListProblem(value: unknown, format: KnowledgeSourceFormat): string | undefined {
  if (value === undefined || value === null || Array.isArray(value)) return undefined;
  const fix =
    format === KnowledgeSourceFormat.Markdown
      ? 'write a YAML list — references: [file:src/a.ts] or one `- …` item per line'
      : "write an array — references: [{ kind: 'file', path: 'src/a.ts' }]";
  return `\`references\` must be a list (got ${describeEntryValue(value)}) — ${fix}`;
}
