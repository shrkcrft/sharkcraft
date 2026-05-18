import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { checkPackSymbolCompat } from '../index.ts';

function makeFixture(): string {
  const root = mkdtempSync(nodePath.join(tmpdir(), 'r16-pack-compat-'));
  return root;
}

function writePackPluginApi(consumerRoot: string, exports: Record<string, string>): string {
  const dist = nodePath.join(consumerRoot, 'node_modules', '@shrkcrft', 'plugin-api', 'dist');
  mkdirSync(dist, { recursive: true });
  const body =
    "'use strict';\nObject.defineProperty(exports, '__esModule', { value: true });\n" +
    Object.entries(exports)
      .map(([k]) => `Object.defineProperty(exports, "${k}", { get: function() { return null; } });`)
      .join('\n');
  writeFileSync(nodePath.join(dist, 'index.js'), body, 'utf8');
  return dist;
}

function writePack(packDir: string, imports: readonly string[]): void {
  mkdirSync(nodePath.join(packDir, 'src'), { recursive: true });
  writeFileSync(
    nodePath.join(packDir, 'package.json'),
    JSON.stringify({ name: 'demo-pack' }, null, 2),
    'utf8',
  );
  writeFileSync(
    nodePath.join(packDir, 'src', 'index.ts'),
    `import { ${imports.join(', ')} } from '@shrkcrft/plugin-api';\nvoid 0;\n`,
    'utf8',
  );
}

describe('r16 pack compat dist-aware', () => {
  test('detects CJS Object.defineProperty exports', () => {
    const root = makeFixture();
    const pack = nodePath.join(root, 'pack');
    const consumer = nodePath.join(root, 'consumer');
    mkdirSync(pack, { recursive: true });
    mkdirSync(consumer, { recursive: true });
    writePack(pack, ['existsHelper', 'noSuchHelper']);
    writePackPluginApi(consumer, { existsHelper: '1' });
    const report = checkPackSymbolCompat({ packPath: pack, consumerRoot: consumer, distAware: true });
    expect(report.availableSymbols).toContain('existsHelper');
    expect(report.missingSymbols).toContain('noSuchHelper');
    expect(['source', 'declaration', 'dist-js', 'fallback']).toContain(report.sourceMode);
  });
  test('detects exports.X = … patterns', () => {
    const root = makeFixture();
    const pack = nodePath.join(root, 'pack');
    const consumer = nodePath.join(root, 'consumer');
    mkdirSync(pack, { recursive: true });
    const dist = nodePath.join(consumer, 'node_modules', '@shrkcrft', 'plugin-api', 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(
      nodePath.join(dist, 'index.js'),
      "'use strict';\nexports.alphaHelper = function () {};\nexports.betaHelper = function () {};\n",
      'utf8',
    );
    writePack(pack, ['alphaHelper']);
    const report = checkPackSymbolCompat({ packPath: pack, consumerRoot: consumer, distAware: true });
    expect(report.availableSymbols).toContain('alphaHelper');
    expect(report.availableSymbols).toContain('betaHelper');
    expect(report.compatible).toBe(true);
  });
  test('detects ESM `export const X` in dist', () => {
    const root = makeFixture();
    const pack = nodePath.join(root, 'pack');
    const consumer = nodePath.join(root, 'consumer');
    mkdirSync(pack, { recursive: true });
    const dist = nodePath.join(consumer, 'node_modules', '@shrkcrft', 'plugin-api', 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(
      nodePath.join(dist, 'index.mjs'),
      'export const gammaHelper = () => null;\nexport function deltaHelper() {}\n',
      'utf8',
    );
    writePack(pack, ['gammaHelper', 'deltaHelper']);
    const report = checkPackSymbolCompat({ packPath: pack, consumerRoot: consumer, distAware: true });
    expect(report.availableSymbols).toContain('gammaHelper');
    expect(report.availableSymbols).toContain('deltaHelper');
  });
});
