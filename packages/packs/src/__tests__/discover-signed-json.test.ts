import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ISharkCraftPackManifest, signPackManifest } from '@shrkcrft/plugin-api';
import { discoverPacks } from '../index.ts';

function makeProjectWithNodeModules(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-packs-signed-test-'));
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  return root;
}

function installSignedJsonPack(
  root: string,
  scope: string,
  name: string,
  manifest: ISharkCraftPackManifest,
): { packageRoot: string; manifestPath: string } {
  const scopedDir = join(root, 'node_modules', scope);
  mkdirSync(scopedDir, { recursive: true });
  const pkgDir = join(scopedDir, name);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({
      name: `${scope}/${name}`,
      version: '1.0.0',
      sharkcraft: { manifest: './manifest.signed.json' },
    }),
  );
  const manifestPath = join(pkgDir, 'manifest.signed.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return { packageRoot: pkgDir, manifestPath };
}

const BASE: ISharkCraftPackManifest = {
  schema: 'sharkcraft.pack/v1',
  info: { name: '@test/signed-pack', version: '1.0.0' },
  contributions: { knowledgeFiles: ['./k.ts'] },
};

describe('discoverPacks — signed JSON manifests', () => {
  test('discovers a signed JSON pack (no dynamic import)', async () => {
    const root = makeProjectWithNodeModules();
    const signed = signPackManifest(BASE, { secret: 'demo' });
    if (!signed.ok) throw new Error('sign failed');
    installSignedJsonPack(root, '@test', 'signed-pack', signed.manifest);
    const result = await discoverPacks({ projectRoot: root });
    const pack = result.discoveredPacks.find((p) => p.packageName === '@test/signed-pack');
    expect(pack).toBeDefined();
    expect(pack?.valid).toBe(true);
    expect(pack?.manifest?.signature).toBeDefined();
  });

  test('with verifySignatures, a signed JSON pack verifies with the right secret', async () => {
    const root = makeProjectWithNodeModules();
    const signed = signPackManifest(BASE, { secret: 'demo' });
    if (!signed.ok) throw new Error('sign failed');
    installSignedJsonPack(root, '@test', 'signed-pack', signed.manifest);
    const result = await discoverPacks({
      projectRoot: root,
      verifySignatures: true,
      packSecret: 'demo',
    });
    const pack = result.discoveredPacks.find((p) => p.packageName === '@test/signed-pack');
    expect(pack?.signatureStatus).toBe('verified');
  });

  test('tampered signed JSON pack is rejected when verification is on', async () => {
    const root = makeProjectWithNodeModules();
    const signed = signPackManifest(BASE, { secret: 'demo' });
    if (!signed.ok) throw new Error('sign failed');
    // Tamper: change version after signing.
    const tampered: ISharkCraftPackManifest = {
      ...signed.manifest,
      info: { ...signed.manifest.info, version: '9.9.9' },
    };
    installSignedJsonPack(root, '@test', 'tampered-pack', tampered);
    const result = await discoverPacks({
      projectRoot: root,
      verifySignatures: true,
      packSecret: 'demo',
    });
    const pack = result.discoveredPacks.find((p) => p.packageName === '@test/tampered-pack');
    expect(pack?.signatureStatus).toBe('invalid-signature');
    expect(pack?.valid).toBe(false);
  });

  test('unsigned TS-style pack is accepted when signatures are not required', async () => {
    const root = makeProjectWithNodeModules();
    const scopedDir = join(root, 'node_modules', '@plain');
    mkdirSync(scopedDir, { recursive: true });
    const pkgDir = join(scopedDir, 'unsigned-pack');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: '@plain/unsigned-pack',
        version: '0.1.0',
        sharkcraft: { manifest: './sharkcraft.plugin.ts' },
      }),
    );
    writeFileSync(
      join(pkgDir, 'sharkcraft.plugin.ts'),
      `export default {
        schema: 'sharkcraft.pack/v1',
        info: { name: '@plain/unsigned-pack', version: '0.1.0' },
        contributions: { knowledgeFiles: ['./k.ts'] },
      };`,
    );
    const result = await discoverPacks({ projectRoot: root });
    const pack = result.discoveredPacks.find((p) => p.packageName === '@plain/unsigned-pack');
    expect(pack?.valid).toBe(true);
    expect(pack?.signatureStatus).toBeUndefined();
  });
});
