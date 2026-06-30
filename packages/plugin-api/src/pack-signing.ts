import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ISharkCraftPackManifest, ISharkCraftPackSignature } from './pack-manifest.ts';

export const PACK_SECRET_ENV = 'SHARKCRAFT_PACK_SECRET';
export const PACK_SIGNATURE_ALGO = 'sha256';
/**
 * Well-known dev secret. Any developer can produce a dev signature
 * mid-session without holding the release secret. The dev secret only
 * proves "someone signed this with the dev tooling"; release paths reject
 * dev signatures unless `--allow-dev-signature` is set.
 */
export const PACK_DEV_SECRET = 'sharkcraft-dev-signature-not-for-release';

/**
 * Canonical JSON for the signed portion of a pack manifest. Excludes the
 * signature field itself so the signature can be inserted afterwards without
 * disturbing the digest.
 */
export function canonicalizePackManifest(manifest: ISharkCraftPackManifest): string {
  const { signature: _signature, ...rest } = manifest;
  return canonicalJson(rest);
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

function readSecret(secret?: string): string | null {
  if (secret !== undefined && secret.length > 0) return secret;
  const fromEnv = process.env[PACK_SECRET_ENV];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return null;
}

export interface SignPackManifestOptions {
  secret?: string;
  keyId?: string;
  /**
   * When true, use the well-known dev secret and mark the signature
   * `dev: true`. Lets agents sign mid-session without the release secret;
   * release apply paths reject dev signatures unless explicitly allowed.
   */
  dev?: boolean;
}

export type SignPackResult =
  | { ok: true; manifest: ISharkCraftPackManifest; signature: ISharkCraftPackSignature }
  | { ok: false; status: 'missing-secret'; message: string };

export function signPackManifest(
  manifest: ISharkCraftPackManifest,
  options: SignPackManifestOptions = {},
): SignPackResult {
  // Dev mode: use the well-known dev secret. Real secret (env / flag)
  // is ignored in dev mode so the signature stays portable and verifiable
  // by any verifier that opts into dev verification.
  const useDev = options.dev === true;
  const secret = useDev ? PACK_DEV_SECRET : readSecret(options.secret);
  if (!secret) {
    return {
      ok: false,
      status: 'missing-secret',
      message: `Cannot sign pack manifest: set ${PACK_SECRET_ENV} or pass --secret (or use --dev for a non-release dev signature).`,
    };
  }
  const canon = canonicalizePackManifest(manifest);
  const hmac = createHmac(PACK_SIGNATURE_ALGO, secret).update(canon).digest('hex');
  const signature: ISharkCraftPackSignature = {
    algo: PACK_SIGNATURE_ALGO,
    hmac,
    signedAt: new Date().toISOString(),
  };
  if (options.keyId !== undefined) signature.keyId = options.keyId;
  if (useDev) signature.dev = true;
  return {
    ok: true,
    manifest: { ...manifest, signature },
    signature,
  };
}

export type VerifyPackResult =
  | { ok: true; status: 'verified'; dev: boolean }
  | {
      ok: false;
      status: 'missing-signature' | 'missing-secret' | 'invalid-signature' | 'dev-signature';
      message: string;
      /**
       * True when the rejection is specifically because the signature is
       * dev-only (`sig.dev === true`) and the caller did not pass
       * {@link VerifyPackManifestOptions.allowDev}. Lets callers distinguish a
       * "not release-trusted" dev signature from a genuinely bad one.
       */
      dev?: boolean;
    };

export interface VerifyPackManifestOptions {
  secret?: string;
  /**
   * Opt in to trusting dev signatures. A `dev: true` signature is produced by
   * `shrk packs sign --dev` and verifies against the WELL-KNOWN, PUBLIC
   * {@link PACK_DEV_SECRET} — so any party can forge one. By default
   * (`allowDev` unset/false) such a signature is REJECTED with
   * `status: 'dev-signature'`, regardless of whether the consumer's real
   * secret is set: a public dev secret is not proof of publisher identity.
   * Only pass `allowDev: true` (surfaced as `--allow-dev-signature`) for
   * local-only flows that explicitly accept dev signatures.
   */
  allowDev?: boolean;
}

export function verifyPackManifest(
  manifest: ISharkCraftPackManifest,
  options: VerifyPackManifestOptions = {},
): VerifyPackResult {
  const sig = manifest.signature;
  if (!sig) {
    return { ok: false, status: 'missing-signature', message: 'Manifest has no signature.' };
  }
  if (sig.algo !== PACK_SIGNATURE_ALGO) {
    return {
      ok: false,
      status: 'invalid-signature',
      message: `Unsupported signature algorithm: ${sig.algo}`,
    };
  }
  // Dev signatures verify against the well-known dev secret. Because that
  // secret is PUBLIC, a dev signature proves nothing about publisher identity,
  // so it is NOT release-trusted: reject it unless the caller explicitly opts
  // in via `allowDev` (`--allow-dev-signature`). This is the gate that stops a
  // forged `signPackManifest(forged, { dev: true })` from reporting "verified"
  // even when the consumer's own real secret is set.
  const isDev = sig.dev === true;
  if (isDev && options.allowDev !== true) {
    return {
      ok: false,
      status: 'dev-signature',
      message:
        'Dev signature is not release-trusted (signed with the well-known public dev secret); pass --allow-dev-signature to accept it for local-only flows.',
      dev: true,
    };
  }
  const secret = isDev ? PACK_DEV_SECRET : readSecret(options.secret);
  if (!secret) {
    return {
      ok: false,
      status: 'missing-secret',
      message: `Cannot verify pack manifest: set ${PACK_SECRET_ENV} or pass --secret.`,
    };
  }
  const canon = canonicalizePackManifest(manifest);
  const expected = createHmac(PACK_SIGNATURE_ALGO, secret).update(canon).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sig.hmac, 'hex');
  } catch {
    return { ok: false, status: 'invalid-signature', message: 'Signature is not valid hex.' };
  }
  if (given.length !== expected.length) {
    return { ok: false, status: 'invalid-signature', message: 'Signature length mismatch.' };
  }
  if (!timingSafeEqual(given, expected)) {
    return { ok: false, status: 'invalid-signature', message: 'Signature does not match.' };
  }
  return { ok: true, status: 'verified', dev: isDev };
}
