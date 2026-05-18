import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { buildReportSite, inspectSharkcraft } from '../index.ts';

describe('r17 pack-compat report-site embed', () => {
  test('emits pack-compat.html with placeholder when no compat file', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'r17-report-'));
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const out = nodePath.join(root, 'site');
    const result = await buildReportSite(inspection, out, {});
    const compatFile = nodePath.join(out, 'pack-compat.html');
    const body = readFileSync(compatFile, 'utf8');
    expect(body).toContain('Pack compatibility');
    expect(body).toContain('packs compat');
    expect(result.placeholderPages).toContain('pack-compat');
  });
  test('embeds an actual compat report when provided', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'r17-report-good-'));
    const compatPath = nodePath.join(root, 'compat.json');
    writeFileSync(
      compatPath,
      JSON.stringify({
        pack: '/tmp/pack',
        consumerRoot: '/tmp/consumer',
        symbolCompat: {
          pluginApiSource: '/tmp/pa',
          pluginApiResolution: 'consumer-symlink',
          sourceMode: 'source',
          confidence: 'high',
          availableSymbols: ['a', 'b'],
          missingSymbols: ['missingSym'],
          findings: [{ symbol: 'missingSym', status: 'missing', files: ['x.ts'] }],
          suggestions: ['bump version'],
          filesInspected: ['x.ts'],
        },
      }),
      'utf8',
    );
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const out = nodePath.join(root, 'site');
    await buildReportSite(inspection, out, { packCompatFile: compatPath });
    const body = readFileSync(nodePath.join(out, 'pack-compat.html'), 'utf8');
    expect(body).toContain('missingSym');
    expect(body).toContain('bump version');
    expect(body).toContain('available symbols');
  });
});
