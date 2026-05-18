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
});
