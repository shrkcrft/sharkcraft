import { describe, expect, test } from 'bun:test';
import { ALL_TOOLS } from '../tools/all-tools.ts';
import { TOOL_INPUT_SCHEMAS, validateToolInput } from '../server/tool-input-validators.ts';
import type { IToolJsonSchema } from '../server/tool-definition.ts';

/**
 * Schema-parity guard. Generalizes the `compress_context maxTokens` Critical:
 * a tool advertised `maxTokens` in its `inputSchema` but the strict zod
 * validator in `tool-input-validators.ts` rejected it on the wire, so the
 * feature was dead in production and the handler test (which bypasses the
 * validator) never saw it.
 *
 * For every tool that has BOTH a JSON `inputSchema` AND a strict zod validator,
 * we synthesize an input covering EVERY advertised property and assert the
 * validator accepts it. Adding a property to a tool's inputSchema without
 * teaching its validator (or vice-versa: a validator requiring a field the
 * schema never advertises) turns this suite red.
 */

interface IJsonSchemaProp {
  type?: string;
  enum?: unknown[];
  minimum?: number;
  items?: { type?: string };
}

/**
 * Build a representative value for one advertised property from its JSON Schema
 * declaration. Respects `enum` (first member) and numeric `minimum`, and floors
 * numbers at 100 so it clears the larger `.min(100)` token budgets in the zod
 * validators (no validator declares an upper bound).
 */
function sampleValue(prop: IJsonSchemaProp): unknown {
  if (Array.isArray(prop.enum) && prop.enum.length > 0) return prop.enum[0];
  switch (prop.type) {
    case 'number':
    case 'integer':
      return Math.max(100, typeof prop.minimum === 'number' ? prop.minimum : 0);
    case 'boolean':
      return true;
    case 'array': {
      const itemType = prop.items?.type;
      if (itemType === 'number' || itemType === 'integer') return [1];
      return ['x'];
    }
    case 'object':
      return {};
    case 'string':
    default:
      return 'x';
  }
}

/** Synthesize an input object covering every property the inputSchema advertises. */
function sampleInput(schema: IToolJsonSchema): Record<string, unknown> {
  const props = (schema.properties ?? {}) as Record<string, IJsonSchemaProp>;
  const input: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(props)) {
    input[key] = sampleValue(prop);
  }
  return input;
}

const validatedTools = ALL_TOOLS.filter((t) => TOOL_INPUT_SCHEMAS[t.name] !== undefined);

describe('wire/handler schema parity', () => {
  test('every validated tool is actually registered in ALL_TOOLS', () => {
    const registered = new Set(ALL_TOOLS.map((t) => t.name));
    const orphanValidators = Object.keys(TOOL_INPUT_SCHEMAS).filter((n) => !registered.has(n));
    // A validator for a tool that no longer exists is dead drift.
    expect(orphanValidators).toEqual([]);
  });

  test('a representative full input is accepted by each tool validator', () => {
    // Guard the guard: if nobody is cross-validated, the suite proves nothing.
    expect(validatedTools.length).toBeGreaterThan(0);

    for (const tool of validatedTools) {
      const input = sampleInput(tool.inputSchema);
      const result = validateToolInput(tool.name, input);
      if (!result.ok) {
        throw new Error(
          `Schema drift on "${tool.name}": its inputSchema advertises ${JSON.stringify(
            Object.keys(input),
          )} but the zod validator rejected the representative input — ${result.failure.message}. ` +
            `Update the validator in server/tool-input-validators.ts to mirror the inputSchema (or vice-versa).`,
        );
      }
      expect(result.ok).toBe(true);
    }
  });
});
