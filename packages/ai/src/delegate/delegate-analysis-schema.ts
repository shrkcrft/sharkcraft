/**
 * The structured judgment an `analysis` delegate recipe asks a local model to
 * emit. Unlike a `patch` recipe (which emits editable ops — see
 * `delegate-edit-schema.ts`), an analysis recipe emits READ-ONLY findings: the
 * model interprets / prioritises / explains a deterministic report the engine
 * already computed. Each finding may cite `refs` (files / constructs / reason
 * codes) drawn from the grounding facts; the inspector's grounding cross-check
 * flags any ref that is NOT present in the ground truth as `unverified`, so the
 * model adds judgment on top of facts it cannot fabricate.
 *
 * This layer (`@shrkcrft/ai`) holds only the wire shape + a structural parse —
 * the grounding cross-check + report assembly live in `@shrkcrft/inspector`.
 */

/** One raw finding the model emits. `refs`/`id` are optional; `message` is not. */
export interface IDelegateRawFinding {
  /** Stable-ish id the model may assign (informational; the engine re-keys). */
  id?: string;
  /** The judgment / observation. */
  message: string;
  /**
   * Entities this finding references (file paths / construct ids / reason
   * codes). MUST be drawn from the provided grounding facts — a ref absent from
   * the ground truth is flagged `unverified` by the cross-check.
   */
  refs?: readonly string[];
}

/** The full structured analysis returned by an analysis worker. */
export interface IDelegateRawAnalysis {
  findings: readonly IDelegateRawFinding[];
  /** Optional free-form note (informational; never treated as a grounded fact). */
  note?: string;
}

/**
 * JSON Schema handed to the provider as `responseFormat.schema` so a local model
 * returns a parseable analysis. Deliberately closed (`additionalProperties:
 * false`) — a weak model that invents fields fails the parse and is reprompted
 * once rather than smuggling unstructured prose through.
 */
export const DELEGATE_ANALYSIS_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    note: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['message'],
        properties: {
          id: { type: 'string' },
          message: { type: 'string', description: 'the judgment / observation' },
          refs: {
            type: 'array',
            items: { type: 'string' },
            description:
              'files / constructs / reason-codes this finding references — MUST be drawn from the provided grounding facts',
          },
        },
      },
    },
  },
};
