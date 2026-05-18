import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppErrorImpl, ERROR_CODES, err, ok, type AppError, type Result } from '@shrkcrft/core';
import type { ISavedPlan } from './saved-plan.ts';

/** Env var that supplies the HMAC secret. */
export const PLAN_SECRET_ENV = 'SHARKCRAFT_PLAN_SECRET';
export const SIGNATURE_ALGO = 'sha256';

export interface IPlanSignature {
  /** Algorithm marker. */
  algo: typeof SIGNATURE_ALGO;
  /** Hex-encoded HMAC. */
  hmac: string;
  /** ISO timestamp of when the plan was signed. */
  signedAt: string;
}

/**
 * Stable JSON encoding for a saved plan, excluding any existing signature.
 * Keys are sorted recursively. Used as the input to the HMAC.
 */
export function canonicalizePlan(plan: ISavedPlan): string {
  const clone: Record<string, unknown> = { ...plan };
  delete clone.signature;
  return canonicalJson(clone);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = (value as Record<string, unknown>)[k];
    if (v === undefined) continue;
    parts.push(JSON.stringify(k) + ':' + canonicalJson(v));
  }
  return '{' + parts.join(',') + '}';
}

function readSecret(envSecret?: string): string | null {
  if (envSecret !== undefined && envSecret.length > 0) return envSecret;
  const fromEnv = process.env[PLAN_SECRET_ENV];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return null;
}

export interface SignPlanOptions {
  /** Explicit secret. If omitted, falls back to SHARKCRAFT_PLAN_SECRET env. */
  secret?: string;
}

export function signPlan(
  plan: ISavedPlan,
  options: SignPlanOptions = {},
): Result<ISavedPlan, AppError> {
  const secret = readSecret(options.secret);
  if (!secret) {
    return err(
      new AppErrorImpl(
        ERROR_CODES.INVALID_INPUT,
        `Cannot sign plan: no secret. Set ${PLAN_SECRET_ENV} or pass --secret.`,
      ),
    );
  }
  const canon = canonicalizePlan(plan);
  const hmac = createHmac(SIGNATURE_ALGO, secret).update(canon).digest('hex');
  const signed: ISavedPlan = {
    ...plan,
    signature: { algo: SIGNATURE_ALGO, hmac, signedAt: new Date().toISOString() },
  };
  return ok(signed);
}

export interface VerifyPlanOptions {
  secret?: string;
}

export type VerifyResult =
  | { ok: true; status: 'verified' }
  | { ok: false; status: 'missing-signature' | 'missing-secret' | 'invalid-signature'; message: string };

/** Pure verification: returns a discriminated status union. */
export function verifyPlan(plan: ISavedPlan, options: VerifyPlanOptions = {}): VerifyResult {
  if (!plan.signature) {
    return { ok: false, status: 'missing-signature', message: 'Plan has no signature.' };
  }
  const secret = readSecret(options.secret);
  if (!secret) {
    return {
      ok: false,
      status: 'missing-secret',
      message: `Cannot verify plan: no secret. Set ${PLAN_SECRET_ENV} or pass --secret.`,
    };
  }
  const canon = canonicalizePlan(plan);
  const expected = createHmac(SIGNATURE_ALGO, secret).update(canon).digest();
  let given: Buffer;
  try {
    given = Buffer.from(plan.signature.hmac, 'hex');
  } catch {
    return { ok: false, status: 'invalid-signature', message: 'Signature is not valid hex.' };
  }
  if (given.length !== expected.length) {
    return { ok: false, status: 'invalid-signature', message: 'Signature length mismatch.' };
  }
  const equal = timingSafeEqual(given, expected);
  if (!equal) {
    return { ok: false, status: 'invalid-signature', message: 'Signature does not match.' };
  }
  return { ok: true, status: 'verified' };
}
