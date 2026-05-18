import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { checkPackSymbolCompat } from '../pack-symbol-compat.ts';

function makeConsumer(): { consumerRoot: string } {
  const root = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r15-consumer-'));
  const apiDir = nodePath.join(root, 'node_modules/@shrkcrft/plugin-api/src');
  mkdirSync(apiDir, { recursive: true });
  writeFileSync(
    nodePath.join(apiDir, 'index.ts'),
    `export function definePackManifest() { return {}; }\nexport interface ISearchTuning { id: string }\nexport function defineSearchTuning() { return {}; }\n`,
  );
  return { consumerRoot: root };
}

function makePack(packRoot: string, content: string): void {
  mkdirSync(nodePath.join(packRoot, 'src/assets'), { recursive: true });
  writeFileSync(nodePath.join(packRoot, 'src/assets/knowledge.ts'), content);
}

describe('r15 pack plugin-api symbol compat', () => {
  test('reports compatible when every imported symbol is exported', () => {
    const { consumerRoot } = makeConsumer();
    const packRoot = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r15-pack-ok-'));
    makePack(
      packRoot,
      `import { defineSearchTuning } from '@shrkcrft/plugin-api';\nexport default [defineSearchTuning({ id: 'x' })];\n`,
    );
    const report = checkPackSymbolCompat({ packPath: packRoot, consumerRoot });
    expect(report.compatible).toBe(true);
    expect(report.missingSymbols).toEqual([]);
    expect(report.availableSymbols).toContain('defineSearchTuning');
  });

  test('reports missing symbols when the consumer plugin-api lacks them', () => {
    const { consumerRoot } = makeConsumer();
    const packRoot = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r15-pack-bad-'));
    makePack(
      packRoot,
      `import { defineScaffoldPatterns } from '@shrkcrft/plugin-api';\nexport default defineScaffoldPatterns([]);\n`,
    );
    const report = checkPackSymbolCompat({ packPath: packRoot, consumerRoot });
    expect(report.compatible).toBe(false);
    expect(report.missingSymbols).toContain('defineScaffoldPatterns');
    expect(report.suggestions.join(' ')).toContain('structural object literals');
  });

  test('handles a structural-only pack with no plugin-api imports', () => {
    const { consumerRoot } = makeConsumer();
    const packRoot = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r15-pack-struct-'));
    makePack(
      packRoot,
      `export default ([{ id: 'service.user', type: 'service', title: 'X' }] as const);\n`,
    );
    const report = checkPackSymbolCompat({ packPath: packRoot, consumerRoot });
    expect(report.compatible).toBe(true);
    expect(report.imports.length).toBe(0);
  });

  test('falls back to pack-local plugin-api when no consumer is given', () => {
    const packRoot = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r15-pack-self-'));
    mkdirSync(nodePath.join(packRoot, 'node_modules/@shrkcrft/plugin-api/src'), { recursive: true });
    writeFileSync(
      nodePath.join(packRoot, 'node_modules/@shrkcrft/plugin-api/src/index.ts'),
      `export function defineLocal() { return {}; }\n`,
    );
    makePack(packRoot, `import { defineLocal } from '@shrkcrft/plugin-api';\n`);
    const report = checkPackSymbolCompat({ packPath: packRoot });
    expect(report.pluginApiResolution).toBe('pack-node-modules');
    expect(report.compatible).toBe(true);
  });
});
