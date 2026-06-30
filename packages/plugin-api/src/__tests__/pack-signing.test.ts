import { describe, expect, test } from "bun:test";
import { canonicalizePackManifest, signPackManifest, verifyPackManifest } from '../pack-signing.ts';
import type { ISharkCraftPackManifest } from '../pack-manifest.ts';

function manifest(): ISharkCraftPackManifest {
  return {
    schema: 'sharkcraft.pack/v1',
    info: { name: '@x/test', version: '0.1.0' },
    contributions: { knowledgeFiles: ['./k.ts'] },
  };
}

describe('pack signing', () => {
  test('sign + verify roundtrips successfully', () => {
    const signed = signPackManifest(manifest(), { secret: 's3cret' });
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    const r = verifyPackManifest(signed.manifest, { secret: 's3cret' });
    expect(r.ok).toBe(true);
  });

  test('verification fails when secret is wrong', () => {
    const signed = signPackManifest(manifest(), { secret: 's3cret' });
    if (!signed.ok) throw new Error('sign failed');
    const r = verifyPackManifest(signed.manifest, { secret: 'wrong' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe('invalid-signature');
  });

  test('canonical JSON excludes signature so re-signing works', () => {
    const a = manifest();
    const aCanon = canonicalizePackManifest(a);
    const signed1 = signPackManifest(a, { secret: 's' });
    if (!signed1.ok) throw new Error('sign failed');
    const bCanon = canonicalizePackManifest(signed1.manifest);
    expect(bCanon).toBe(aCanon);
  });

  test('tampered manifest fails verification', () => {
    const signed = signPackManifest(manifest(), { secret: 's3cret' });
    if (!signed.ok) throw new Error('sign failed');
    const tampered: ISharkCraftPackManifest = {
      ...signed.manifest,
      info: { ...signed.manifest.info, version: '9.9.9' },
    };
    const r = verifyPackManifest(tampered, { secret: 's3cret' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe('invalid-signature');
  });

  test('keyId is preserved through canonicalization', () => {
    const signed = signPackManifest(manifest(), { secret: 's', keyId: 'k1' });
    if (!signed.ok) throw new Error('sign failed');
    expect(signed.manifest.signature?.keyId).toBe('k1');
  });

  test('missing secret returns missing-secret status', () => {
    delete process.env.SHARKCRAFT_PACK_SECRET;
    const result = signPackManifest(manifest());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe('missing-secret');
  });

  test('canonicalization covers the schema key (whole-manifest HMAC)', () => {
    const canon = canonicalizePackManifest(manifest());
    expect(canon).toContain('"schema":"sharkcraft.pack/v1"');
    // The signature field is the only thing excluded.
    const signed = signPackManifest(manifest(), { secret: 's' });
    if (!signed.ok) throw new Error('sign failed');
    expect(canonicalizePackManifest(signed.manifest)).not.toContain('"signature"');
  });
});

describe('pack signing — dev signatures are not release-trusted (S3-1)', () => {
  test('dev signature is REJECTED by default even with a real secret set', () => {
    const signed = signPackManifest(manifest(), { dev: true });
    if (!signed.ok) throw new Error('dev sign failed');
    expect(signed.manifest.signature?.dev).toBe(true);
    const prev = process.env.SHARKCRAFT_PACK_SECRET;
    process.env.SHARKCRAFT_PACK_SECRET = 'consumer-real-secret';
    try {
      const r = verifyPackManifest(signed.manifest);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.status).toBe('dev-signature');
      expect(r.dev).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.SHARKCRAFT_PACK_SECRET;
      else process.env.SHARKCRAFT_PACK_SECRET = prev;
    }
  });

  test('dev signature verifies with allowDev:true and reports dev:true', () => {
    const signed = signPackManifest(manifest(), { dev: true });
    if (!signed.ok) throw new Error('dev sign failed');
    const r = verifyPackManifest(signed.manifest, { allowDev: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe('verified');
    expect(r.dev).toBe(true);
  });

  test('a TAMPERED dev signature still fails even with allowDev:true', () => {
    const signed = signPackManifest(manifest(), { dev: true });
    if (!signed.ok) throw new Error('dev sign failed');
    const tampered: ISharkCraftPackManifest = {
      ...signed.manifest,
      info: { ...signed.manifest.info, version: '9.9.9' },
    };
    const r = verifyPackManifest(tampered, { allowDev: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe('invalid-signature');
  });

  test('a real signed pack with NO secret available is unverifiable (missing-secret)', () => {
    const signed = signPackManifest(manifest(), { secret: 's3cret' });
    if (!signed.ok) throw new Error('sign failed');
    const prev = process.env.SHARKCRAFT_PACK_SECRET;
    delete process.env.SHARKCRAFT_PACK_SECRET;
    try {
      const r = verifyPackManifest(signed.manifest); // no secret in opts or env
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.status).toBe('missing-secret');
    } finally {
      if (prev !== undefined) process.env.SHARKCRAFT_PACK_SECRET = prev;
    }
  });

  test('a forged manifest re-tagged dev does NOT verify against the dev secret', () => {
    // Forge: sign with an attacker secret, then claim dev:true. allowDev makes
    // the verifier hash against PACK_DEV_SECRET, which will not match.
    const forged = signPackManifest(manifest(), { secret: 'attacker-secret' });
    if (!forged.ok) throw new Error('sign failed');
    const reTagged: ISharkCraftPackManifest = {
      ...forged.manifest,
      signature: { ...forged.manifest.signature!, dev: true },
    };
    const r = verifyPackManifest(reTagged, { allowDev: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe('invalid-signature');
  });
});
