import { createHmac } from 'node:crypto';
import {
  SIGNED_REWRITE_SCHEMA,
  type ISignedRewritePlan,
  type ISignedRewriteProvenance,
} from '../schema/signed-rewrite.ts';
import type { IRewritePlan } from '../schema/rewrite.ts';

/**
 * Sign a rewrite plan with HMAC-SHA256.
 *
 * Canonicalisation: the plan + provenance are serialised with sorted
 * keys (deep) before HMAC. This guarantees the signature matches when
 * the plan is round-tripped through any tool that preserves the data.
 *
 * `secret` is required; callers can read it from a project config or
 * environment (e.g. `SHRKCRFT_REWRITE_SECRET`). There's no built-in
 * default — passing an empty secret throws to prevent accidentally
 * "signing" with the empty string.
 */
export function signRewritePlan(
  plan: IRewritePlan,
  options: { secret: string; signedBy?: string },
): ISignedRewritePlan {
  if (!options.secret) {
    throw new Error('signRewritePlan: secret is required');
  }
  const provenance: ISignedRewriteProvenance = {
    signedAt: new Date().toISOString(),
    signedBy: options.signedBy ?? '@shrkcrft/structural-search',
    planSchema: plan.schema,
  };
  const hmac = computeHmac(plan, provenance, options.secret);
  return {
    schema: SIGNED_REWRITE_SCHEMA,
    algo: 'sha256',
    hmac,
    provenance,
    plan,
  };
}

export interface IVerifySignedPlanResult {
  ok: boolean;
  /** Set when `ok` is false. Stable, machine-readable code. */
  reason?:
    | 'schema-mismatch'
    | 'algo-mismatch'
    | 'invalid-signature'
    | 'malformed-plan';
  /** Human-readable detail (free-form). */
  message?: string;
  /** Computed HMAC, hex, for diagnostics. */
  expectedHmac?: string;
}

/**
 * Verify a signed rewrite plan. Constant-time HMAC comparison.
 *
 * Verification can fail for three reasons (each surfaced via
 * `reason`): a different schema (forward-incompat), a different algo
 * (different version of the signer), or a signature mismatch (wrong
 * secret OR tampered plan).
 */
export function verifySignedRewritePlan(
  signed: ISignedRewritePlan,
  options: { secret: string },
): IVerifySignedPlanResult {
  if (signed.schema !== SIGNED_REWRITE_SCHEMA) {
    return { ok: false, reason: 'schema-mismatch', message: `unexpected schema: ${signed.schema}` };
  }
  if (signed.algo !== 'sha256') {
    return { ok: false, reason: 'algo-mismatch', message: `unsupported algo: ${signed.algo}` };
  }
  if (!signed.plan || !signed.provenance) {
    return { ok: false, reason: 'malformed-plan', message: 'missing plan or provenance' };
  }
  const expected = computeHmac(signed.plan, signed.provenance, options.secret);
  if (!constantTimeEqualHex(expected, signed.hmac)) {
    return {
      ok: false,
      reason: 'invalid-signature',
      message: 'HMAC mismatch — wrong secret or tampered plan',
      expectedHmac: expected,
    };
  }
  return { ok: true };
}

function computeHmac(
  plan: IRewritePlan,
  provenance: ISignedRewriteProvenance,
  secret: string,
): string {
  const canonical = canonicalJson({ plan, provenance });
  return createHmac('sha256', secret).update(canonical).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value === null || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) sorted[key] = sortDeep(obj[key]);
  return sorted;
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let acc = 0;
  for (let i = 0; i < a.length; i += 1) acc |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return acc === 0;
}
