import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectPackageManager, inspectWorkspace, PackageManager, readPackageJson } from '../index.ts';

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'shrk-ws-test-'));
}

describe('readPackageJson', () => {
  test('returns null when no package.json', () => {
    const root = makeTmp();
    const result = readPackageJson(root);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(null);
  });

  test('parses a valid package.json', () => {
    const root = makeTmp();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { start: 'echo hi' } }),
    );
    const result = readPackageJson(root);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value?.name).toBe('demo');
      expect(result.value?.scripts?.start).toBe('echo hi');
    }
  });

  test('returns error on malformed JSON', () => {
    const root = makeTmp();
    writeFileSync(join(root, 'package.json'), '{ this is not json');
    const result = readPackageJson(root);
    expect(result.ok).toBe(false);
  });
});

describe('detectPackageManager', () => {
  test('reads packageManager field', () => {
    const root = makeTmp();
    const info = detectPackageManager(root, {
      packageManager: 'bun@1.1.0',
    });
    expect(info.manager).toBe(PackageManager.Bun);
    expect(info.version).toBe('1.1.0');
  });

  test('detects bun via bun.lockb', () => {
    const root = makeTmp();
    writeFileSync(join(root, 'bun.lockb'), '');
    const info = detectPackageManager(root, null);
    expect(info.manager).toBe(PackageManager.Bun);
  });

  test('returns Unknown when nothing matches', () => {
    const root = makeTmp();
    const info = detectPackageManager(root, null);
    expect(info.manager).toBe(PackageManager.Unknown);
  });
});

describe('inspectWorkspace', () => {
  test('reports hasSharkcraftFolder=false when missing', async () => {
    const root = makeTmp();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x' }));
    const summary = await inspectWorkspace({ startDir: root });
    expect(summary.hasSharkcraftFolder).toBe(false);
    expect(summary.projectRoot).toBe(root);
    expect(summary.packageName).toBe('x');
  });
});
