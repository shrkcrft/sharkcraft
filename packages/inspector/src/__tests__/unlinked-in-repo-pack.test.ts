import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findUnlinkedInRepoPacks } from '../sharkcraft-inspector.ts';

/**
 * Guards the doctor diagnostic that catches the silent-failure case: a pack
 * that lives in the repo (e.g. tools/sharkcraft-pack) but is not linked into
 * node_modules, so discovery — which scans node_modules — finds nothing and
 * every contribution goes dark.
 */
function scaffoldPack(
  root: string,
  parent: string,
  dir: string,
  packageName: string,
): void {
  const packRoot = join(root, parent, dir);
  mkdirSync(join(packRoot, 'src'), { recursive: true });
  writeFileSync(
    join(packRoot, 'package.json'),
    JSON.stringify({ name: packageName, sharkcraft: { manifest: './src/sharkcraft.plugin.ts' } }),
  );
  writeFileSync(
    join(packRoot, 'src', 'sharkcraft.plugin.ts'),
    'export default {};\n',
  );
}

describe('findUnlinkedInRepoPacks', () => {
  test('detects an in-repo pack that is not in the discovered set', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-unlinked-'));
    scaffoldPack(root, 'tools', 'sharkcraft-pack', '@nge/sharkcraft-pack');

    const found = findUnlinkedInRepoPacks(root, new Set());

    expect(found).toHaveLength(1);
    expect(found[0]?.packageName).toBe('@nge/sharkcraft-pack');
    expect(found[0]?.relPath).toBe(join('tools', 'sharkcraft-pack'));
  });

  test('does NOT flag a pack that is already discovered', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-linked-'));
    scaffoldPack(root, 'tools', 'sharkcraft-pack', '@nge/sharkcraft-pack');

    const found = findUnlinkedInRepoPacks(root, new Set(['@nge/sharkcraft-pack']));

    expect(found).toHaveLength(0);
  });

  test('ignores ordinary directories that are not packs', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-nopack-'));
    mkdirSync(join(root, 'libs', 'some-lib', 'src'), { recursive: true });
    writeFileSync(
      join(root, 'libs', 'some-lib', 'package.json'),
      JSON.stringify({ name: '@nge/some-lib' }),
    );

    const found = findUnlinkedInRepoPacks(root, new Set());

    expect(found).toHaveLength(0);
  });
});
