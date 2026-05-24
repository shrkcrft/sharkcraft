import {
  STRUCTURAL_PATTERN_SCHEMA,
  type IPatternEnvelope,
  type StructuralPattern,
} from './pattern.ts';

export const STRUCTURAL_PATTERN_REGISTRY_SCHEMA =
  'sharkcraft.structural-pattern-registry/v1' as const;

/**
 * One entry in the on-disk pattern registry. Carries the full pattern
 * envelope plus bookkeeping (added / validated timestamps + last error
 * if any) so the doctor can surface decayed entries.
 */
export interface IRegisteredPattern {
  id: string;
  title?: string;
  description?: string;
  pattern: StructuralPattern;
  /** ISO timestamp the entry was added. */
  addedAt: string;
  /** ISO timestamp the entry was last validated successfully. */
  lastValidatedAt?: string;
  /** Last validation error message (set when validation failed). */
  lastValidationError?: string;
}

/**
 * On-disk pattern registry shape, persisted at
 * `.sharkcraft/structural/patterns.json`. Lives alongside the pattern
 * engine so packs can ship patterns and the doctor can check their
 * health without a custom loader per pack.
 */
export interface IPatternRegistry {
  schema: typeof STRUCTURAL_PATTERN_REGISTRY_SCHEMA;
  patterns: readonly IRegisteredPattern[];
}

/**
 * Allowed `pattern.kind` strings. Hard-coded so we can validate
 * entries without invoking the matcher itself — a registry entry with
 * an unknown kind is rejected at registration time.
 */
export const KNOWN_PATTERN_KINDS = new Set<string>([
  'Identifier',
  'StringLiteral',
  'CallExpression',
  'NewExpression',
  'ImportDeclaration',
  'ClassDeclaration',
  'Decorator',
]);

export interface IPatternValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * Light-weight envelope validation. Confirms:
 *   - schema field matches the canonical version,
 *   - pattern.kind is one of the known matcher kinds,
 *   - any regex field compiles.
 *
 * This is deliberately not a full structural typecheck — TypeScript
 * already enforces the runtime fields. The goal is to catch
 * pack-contributed JSON that fails at the boundary instead of at
 * match time.
 */
export function validatePatternEnvelope(
  envelope: IPatternEnvelope,
): IPatternValidationResult {
  if (envelope.schema !== STRUCTURAL_PATTERN_SCHEMA) {
    return {
      ok: false,
      error: `schema mismatch: got "${envelope.schema}", expected "${STRUCTURAL_PATTERN_SCHEMA}"`,
    };
  }
  const p = envelope.pattern as { kind?: string; nameRegex?: string; textRegex?: string; fromRegex?: string } | null;
  if (!p || typeof p.kind !== 'string') {
    return { ok: false, error: 'pattern.kind is missing or not a string' };
  }
  if (!KNOWN_PATTERN_KINDS.has(p.kind)) {
    return {
      ok: false,
      error: `pattern.kind "${p.kind}" is not a known matcher kind (one of ${[...KNOWN_PATTERN_KINDS].sort().join(', ')})`,
    };
  }
  for (const key of ['nameRegex', 'textRegex', 'fromRegex'] as const) {
    const raw = p[key];
    if (typeof raw === 'string' && raw.length > 0) {
      try {
        new RegExp(raw);
      } catch (e) {
        return {
          ok: false,
          error: `pattern.${key} is not a valid regex: ${(e as Error).message}`,
        };
      }
    }
  }
  return { ok: true };
}
