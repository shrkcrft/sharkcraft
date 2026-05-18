import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverPacks } from '../index.ts';

function makeProjectWithNodeModules(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-packs-test-'));
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  return root;
}

function installPlainPack(
  root: string,
  packageName: string,
  body: { manifestField?: unknown; manifestFile?: string; manifestExports?: string } = {},
): string {
  const pkgDir = join(root, 'node_modules', packageName);
  mkdirSync(pkgDir, { recursive: true });
  const manifestFile = body.manifestFile ?? './sharkcraft.plugin.ts';
  const pkgJson = {
    name: packageName,
    version: '0.1.0',
    sharkcraft: body.manifestField ?? { manifest: manifestFile },
  };
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(pkgJson));
  if (body.manifestExports !== undefined) {
    writeFileSync(join(pkgDir, manifestFile), body.manifestExports);
  }
  return pkgDir;
}

function installScopedPack(
  root: string,
  scope: string,
  name: string,
  body: { manifestField?: unknown; manifestExports?: string } = {},
): string {
  const scopedDir = join(root, 'node_modules', scope);
  mkdirSync(scopedDir, { recursive: true });
  const pkgDir = join(scopedDir, name);
  mkdirSync(pkgDir, { recursive: true });
  const pkgJson = {
    name: `${scope}/${name}`,
    version: '1.0.0',
    sharkcraft: body.manifestField ?? { manifest: './sharkcraft.plugin.ts' },
  };
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(pkgJson));
  if (body.manifestExports !== undefined) {
    writeFileSync(join(pkgDir, 'sharkcraft.plugin.ts'), body.manifestExports);
  }
  return pkgDir;
}

const VALID_MANIFEST = `
export default {
  schema: 'sharkcraft.pack/v1',
  info: { name: 'demo', version: '0.1.0' },
  contributions: { knowledgeFiles: ['./assets/knowledge.ts'] },
};
`;

const INVALID_MANIFEST_NO_INFO = `
export default { schema: 'sharkcraft.pack/v1' };
`;

const BROKEN_MANIFEST = `
this is not typescript;
`;

describe('discoverPacks', () => {
  test('returns no-packs result when node_modules is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-packs-empty-'));
    const result = await discoverPacks({ projectRoot: root });
    expect(result.nodeModulesExists).toBe(false);
    expect(result.discoveredPacks.length).toBe(0);
  });

  test('discovers a plain (non-scoped) pack', async () => {
    const root = makeProjectWithNodeModules();
    installPlainPack(root, 'my-pack', { manifestExports: VALID_MANIFEST });
    const result = await discoverPacks({ projectRoot: root });
    expect(result.discoveredPacks.length).toBe(1);
    expect(result.validPacks[0]?.packageName).toBe('my-pack');
    expect(result.validPacks[0]?.contributionCounts.knowledgeFiles).toBe(1);
  });

  test('discovers a scoped pack', async () => {
    const root = makeProjectWithNodeModules();
    installScopedPack(root, '@acme', 'pack-a', { manifestExports: VALID_MANIFEST });
    const result = await discoverPacks({ projectRoot: root });
    expect(result.validPacks[0]?.packageName).toBe('@acme/pack-a');
  });

  test('supports the short form `sharkcraft: "./path"`', async () => {
    const root = makeProjectWithNodeModules();
    installPlainPack(root, 'short-form', {
      manifestField: './sharkcraft.plugin.ts',
      manifestExports: VALID_MANIFEST,
    });
    const result = await discoverPacks({ projectRoot: root });
    expect(result.validPacks[0]?.packageName).toBe('short-form');
  });

  test('reports manifest validation issues as invalid (no crash)', async () => {
    const root = makeProjectWithNodeModules();
    installPlainPack(root, 'no-info', { manifestExports: INVALID_MANIFEST_NO_INFO });
    const result = await discoverPacks({ projectRoot: root });
    expect(result.invalidPacks.length).toBe(1);
    expect(result.invalidPacks[0]?.validationIssues.length).toBeGreaterThan(0);
    expect(result.validPacks.length).toBe(0);
  });

  test('broken manifest import does not crash; surfaces loadError', async () => {
    const root = makeProjectWithNodeModules();
    installPlainPack(root, 'broken', { manifestExports: BROKEN_MANIFEST });
    const result = await discoverPacks({ projectRoot: root });
    expect(result.invalidPacks.length).toBe(1);
    expect(typeof result.invalidPacks[0]?.loadError).toBe('string');
  });

  test('packages without a sharkcraft field are not discovered', async () => {
    const root = makeProjectWithNodeModules();
    const pkgDir = join(root, 'node_modules', 'plain');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'plain', version: '0.0.1' }),
    );
    const result = await discoverPacks({ projectRoot: root });
    expect(result.scannedPackageCount).toBe(1);
    expect(result.discoveredPacks.length).toBe(0);
  });
});
