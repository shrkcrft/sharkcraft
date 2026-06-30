/**
 * Dev pack-signature mode.
 *
 * Locks in the contract:
 *   - `signPackManifest({ dev: true })` produces a signature with
 *     `dev: true` and works WITHOUT a real secret (uses the well-known
 *     dev secret).
 *   - `verifyPackManifest` returns `dev: boolean` so callers can reject
 *     dev signatures on release paths.
 *   - Release signatures still verify normally and report `dev: false`.
 *   - A signature that was signed `dev:true` cannot be verified as a
 *     release signature with an arbitrary secret.
 */
import { describe, expect, test } from 'bun:test';
import {
  PACK_DEV_SECRET,
  signPackManifest,
  verifyPackManifest,
} from '../pack-signing.ts';
import type { ISharkCraftPackManifest } from '../pack-manifest.ts';

function manifest(): ISharkCraftPackManifest {
  return {
    schema: 'sharkcraft.pack/v1',
    info: {
      name: 'r49.test-pack',
      version: '0.0.1',
    },
    contributions: {},
  };
}

describe('dev-mode signing', () => {
  test('--dev signs without a real secret + marks dev:true', () => {
    const r = signPackManifest(manifest(), { dev: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.signature.dev).toBe(true);
    expect(r.manifest.signature?.dev).toBe(true);
  });

  test('dev signature is rejected by default (not release-trusted)', () => {
    // SECURITY (S3-1): a dev signature uses the well-known PUBLIC dev secret,
    // so it must NOT verify as release-trusted without an explicit opt-in —
    // even if a real consumer secret is set in the environment.
    const signed = signPackManifest(manifest(), { dev: true });
    if (!signed.ok) throw new Error('sign failed');
    const prev = process.env.SHARKCRAFT_PACK_SECRET;
    process.env.SHARKCRAFT_PACK_SECRET = 'consumer-real-secret';
    try {
      const v = verifyPackManifest(signed.manifest);
      expect(v.ok).toBe(false);
      if (v.ok) return;
      expect(v.status).toBe('dev-signature');
      expect(v.dev).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.SHARKCRAFT_PACK_SECRET;
      else process.env.SHARKCRAFT_PACK_SECRET = prev;
    }
  });

  test('dev signature verifies only with allowDev opt-in', () => {
    const signed = signPackManifest(manifest(), { dev: true });
    if (!signed.ok) throw new Error('sign failed');
    const v = verifyPackManifest(signed.manifest, { allowDev: true });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.dev).toBe(true);
  });

  test('PACK_DEV_SECRET is a well-known constant, not the release secret', () => {
    expect(PACK_DEV_SECRET).toContain('dev');
    expect(PACK_DEV_SECRET).toContain('not-for-release');
  });

  test('release signature: dev=false in verification result', () => {
    const signed = signPackManifest(manifest(), { secret: 'real-secret' });
    if (!signed.ok) throw new Error('sign failed');
    expect(signed.signature.dev).toBeUndefined();
    const v = verifyPackManifest(signed.manifest, { secret: 'real-secret' });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.dev).toBe(false);
  });

  test('dev signature does NOT verify under a random release secret', () => {
    // The dev signer uses PACK_DEV_SECRET internally. Verifying without the
    // dev tag (i.e. attempting a "release verify") with a different secret
    // must fail.
    const signed = signPackManifest(manifest(), { dev: true });
    if (!signed.ok) throw new Error('sign failed');
    // Strip the dev marker to simulate a release-path verifier that doesn't
    // know about dev signatures.
    const tampered: ISharkCraftPackManifest = {
      ...signed.manifest,
      signature: { ...signed.manifest.signature!, dev: undefined as unknown as boolean },
    };
    const v = verifyPackManifest(tampered, { secret: 'real-secret' });
    expect(v.ok).toBe(false);
  });

  test('release signature does NOT verify when re-tagged as dev', () => {
    const signed = signPackManifest(manifest(), { secret: 'real-secret' });
    if (!signed.ok) throw new Error('sign failed');
    // Tampered: claim dev:true but the hmac was signed with a release secret.
    const tampered: ISharkCraftPackManifest = {
      ...signed.manifest,
      signature: { ...signed.manifest.signature!, dev: true },
    };
    const v = verifyPackManifest(tampered);
    expect(v.ok).toBe(false);
  });
});
