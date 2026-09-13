/**
 * The closed allow-list of planned-operation kinds and their fields — THE one
 * table both `planGeneration` (before evaluating an op) and template lint
 * (`invalid-operation`) check a rendered `changes()` op against.
 *
 * `ITemplateChange` exists only as a type, so an op written with `key`/`value`
 * instead of `entryKey`/`entryValue` used to reach the evaluator and crash with
 * an unlocated `undefined is not an object (evaluating 'marker.length')`, while
 * template doctor reported the template clean. The `satisfies` below forces one
 * row per `PlannedOperationKind`: adding an op kind without its fields fails
 * the build.
 */
import type { PlannedOperationKind } from './operations.ts';

export const PLANNED_OPERATION_FIELDS = {
  create: { required: ['content'], optional: ['description'] },
  append: { required: ['snippet'], optional: ['ifMissing', 'description'] },
  'insert-after': { required: ['anchor', 'snippet'], optional: ['ifMissing', 'description'] },
  'insert-before': { required: ['anchor', 'snippet'], optional: ['ifMissing', 'description'] },
  replace: { required: ['find', 'replaceWith'], optional: ['expectMatches', 'description'] },
  export: { required: ['from'], optional: ['symbols', 'ifMissing', 'description'] },
  'ensure-import': {
    required: ['from'],
    optional: ['symbols', 'typeOnly', 'defaultBinding', 'namespaceBinding', 'description'],
  },
  'insert-enum-entry': { required: ['enumName', 'entryName', 'entryValue'], optional: ['description'] },
  'insert-object-entry': {
    required: ['objectName', 'entryKey', 'entryValue'],
    optional: ['shorthand', 'description'],
  },
  'insert-array-entry': {
    required: ['arrayName', 'entryValue'],
    optional: ['arrayNameAlternatives', 'manualStepInstruction', 'ifMissing', 'description'],
  },
  'insert-before-closing-brace': {
    required: ['containerName', 'snippet'],
    optional: ['ifMissing', 'description'],
  },
  'insert-between-anchors': {
    required: ['beginAnchor', 'endAnchor', 'snippet'],
    optional: ['ifMissing', 'description'],
  },
} as const satisfies Record<
  PlannedOperationKind,
  { readonly required: readonly string[]; readonly optional: readonly string[] }
>;

/** Explicit near-misses authors write for a required field. */
const NEAR_MISS: Readonly<Record<string, readonly string[]>> = {
  key: ['entryKey'],
  value: ['entryValue', 'snippet', 'content'],
  name: ['entryName', 'arrayName', 'objectName', 'enumName', 'containerName'],
  body: ['content', 'snippet'],
  text: ['snippet', 'content'],
  code: ['snippet', 'content'],
  snippet: ['content'],
  content: ['snippet'],
  replace: ['replaceWith'],
  with: ['replaceWith'],
  search: ['find'],
  pattern: ['find'],
  begin: ['beginAnchor'],
  end: ['endAnchor'],
  target: ['arrayName', 'objectName', 'enumName', 'containerName'],
};

function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return true;
  return true;
}

/**
 * Check one rendered op against the table. `kindKnown: false` means the kind is
 * not a planned-operation kind at all; `missing` lists required fields that are
 * absent; `unknown` lists keys the evaluator would silently drop; `suggestions`
 * pairs an unknown key with the missing field it most likely meant
 * (`value→entryValue`).
 */
export function validatePlannedOperation(op: unknown): {
  readonly kindKnown: boolean;
  readonly kind: string;
  readonly missing: readonly string[];
  readonly unknown: readonly string[];
  readonly suggestions: readonly string[];
} {
  if (!op || typeof op !== 'object') {
    return { kindKnown: false, kind: String(op), missing: [], unknown: [], suggestions: [] };
  }
  const record = op as Record<string, unknown>;
  const kind = typeof record.kind === 'string' ? record.kind : String(record.kind);
  const spec = (
    PLANNED_OPERATION_FIELDS as Record<string, { readonly required: readonly string[]; readonly optional: readonly string[] }>
  )[kind];
  if (!spec) return { kindKnown: false, kind, missing: [], unknown: [], suggestions: [] };
  const missing = spec.required.filter((f) => !isPresent(record[f]));
  const allowed = new Set<string>(['kind', ...spec.required, ...spec.optional]);
  const unknown = Object.keys(record).filter((k) => !allowed.has(k));
  const suggestions: string[] = [];
  for (const u of unknown) {
    const explicit = (NEAR_MISS[u.toLowerCase()] ?? []).filter((f) => missing.includes(f));
    const contained = missing.filter(
      (f) => !explicit.includes(f) && f.toLowerCase().includes(u.toLowerCase()) && u.length >= 3,
    );
    const target = explicit[0] ?? contained[0];
    if (target) suggestions.push(`${u}→${target}`);
  }
  return { kindKnown: true, kind, missing, unknown, suggestions };
}

/**
 * One sentence naming what is wrong with an op, or `undefined` when the op is
 * well-formed (unknown extra keys alone are reported by the caller as a
 * warning, not here).
 */
export function describeInvalidPlannedOperation(
  shape: ReturnType<typeof validatePlannedOperation>,
  where: string,
): string | undefined {
  if (!shape.kindKnown) {
    return `${where}: unknown operation kind "${shape.kind}" — must be one of ${Object.keys(PLANNED_OPERATION_FIELDS).join(', ')}`;
  }
  if (shape.missing.length === 0) return undefined;
  const parts = [`missing required ${shape.missing.join(', ')}`];
  if (shape.unknown.length > 0) parts.push(`unknown keys ${shape.unknown.join(', ')}`);
  const hint = shape.suggestions.length > 0 ? ` — did you mean ${shape.suggestions.join(', ')}?` : '';
  return `${where} (${shape.kind}): ${parts.join('; ')}${hint}`;
}
