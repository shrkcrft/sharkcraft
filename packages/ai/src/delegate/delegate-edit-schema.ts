/**
 * The structured edit a delegate worker (local LLM) is asked to emit.
 *
 * This layer (`@shrkcrft/ai`) sits BELOW `@shrkcrft/generator`, so it cannot
 * reference `IPlannedOperation`. The worker's output is therefore parsed into a
 * deliberately-RAW shape here: `operation` is `{ kind } & Record<string,
 * unknown>`. The generator-layer packager (`packageDelegatePlan`) is the
 * authority that validates each raw op against the real operation union and the
 * recipe's `allowedOps` — a raw op never writes anything on its own.
 */

/** One raw operation the worker wants to apply to a file. */
export interface IDelegateRawOp {
  /** File path the op targets, relative to the project root. */
  targetPath: string;
  /**
   * The operation intent. `kind` selects an `IPlannedOperation` variant; the
   * remaining fields are validated against that variant downstream, never here.
   */
  operation: { kind: string } & Record<string, unknown>;
}

/** The full structured edit returned by a delegate worker. */
export interface IDelegateRawEdit {
  ops: readonly IDelegateRawOp[];
  /** Optional free-form note from the worker. Informational only; not applied. */
  note?: string;
}

/**
 * `IPlannedOperation` kinds a delegate worker may emit. Hardcoded here (not
 * imported from the higher generator layer) — this is a HINT for the model's
 * `json_schema` response format, not the security boundary. The generator's
 * `packageDelegatePlan` + the recipe's `allowedOps` are the real gate, so a
 * kind missing here only makes the model less likely to emit it.
 */
export const DELEGATE_OP_KINDS: readonly string[] = [
  'create',
  'append',
  'insert-after',
  'insert-before',
  'replace',
  'export',
  'ensure-import',
  'insert-enum-entry',
  'insert-object-entry',
  'insert-array-entry',
  'insert-before-closing-brace',
  'insert-between-anchors',
];

/**
 * JSON Schema handed to the provider as `responseFormat.schema` so a local
 * model returns a parseable edit. `operation` allows extra properties on
 * purpose — different op kinds carry different fields, and the generator
 * validates the exact shape per kind.
 */
export const DELEGATE_EDIT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['ops'],
  properties: {
    note: { type: 'string' },
    ops: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['targetPath', 'operation'],
        properties: {
          targetPath: {
            type: 'string',
            description: 'file path relative to the project root',
          },
          operation: {
            type: 'object',
            additionalProperties: true,
            required: ['kind'],
            properties: {
              kind: { type: 'string', enum: [...DELEGATE_OP_KINDS] },
              from: { type: 'string', description: 'module specifier (export / ensure-import)' },
              symbols: { type: 'array', items: { type: 'string' } },
              typeOnly: { type: 'boolean' },
              find: { type: 'string' },
              replaceWith: { type: 'string' },
              expectMatches: { type: 'number' },
              content: { type: 'string' },
              snippet: { type: 'string' },
              anchor: { type: 'string' },
              ifMissing: { type: 'string' },
            },
          },
        },
      },
    },
  },
};
