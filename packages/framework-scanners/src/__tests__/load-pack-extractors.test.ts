import { describe, expect, test } from 'bun:test';
import type { IPackDiscoveryResult } from '@shrkcrft/packs';
import { loadPackExtractors } from '../runner/load-pack-extractors.ts';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeDiscovery(packs: IPackDiscoveryResult['validPacks']): IPackDiscoveryResult {
  return {
    projectRoot: '/tmp',
    nodeModulesPath: '/tmp/node_modules',
    nodeModulesExists: false,
    scannedPackageCount: packs.length,
    discoveredPacks: packs,
    validPacks: packs,
    invalidPacks: [],
    warnings: [],
  };
}

describe('loadPackExtractors', () => {
  test('loads a pack-shipped extractor (default export)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-pack-ext-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      const extPath = join(root, 'src', 'ext.ts');
      writeFileSync(
        extPath,
        [
          "export default {",
          "  framework: 'custom-fw',",
          "  label: 'Custom',",
          "  fileMatches: () => false,",
          "  extract: () => ({ nodes: [], edges: [] }),",
          "};",
        ].join('\n'),
      );
      const result = await loadPackExtractors(
        makeDiscovery([
          {
            packageName: 'demo-pack',
            packageVersion: '0.0.1',
            manifestPath: join(root, 'sharkcraft-pack.ts'),
            packageRoot: root,
            manifest: {
              schema: 'sharkcraft.pack/v1',
              info: { name: 'demo-pack', version: '0.0.1' },
              contributions: { frameworkExtractorFiles: ['src/ext.ts'] },
            },
            contributionCounts: {
              knowledgeFiles: 0, ruleFiles: 0, pathFiles: 0, templateFiles: 0,
              pipelineFiles: 0, docsFiles: 0, presetFiles: 0,
              scaffoldPatternFiles: 0, policyCheckFiles: 0, constructFiles: 0,
              constructFacetFiles: 0, playbookFiles: 0, delegateRecipeFiles: 0,
            },
            validationIssues: [],
            valid: true,
          },
        ]),
        new Set(['nestjs']),
      );
      expect(result.extractors.length).toBe(1);
      expect(result.extractors[0]!.framework).toBe('custom-fw');
      expect(result.packs).toContain('demo-pack');
      expect(result.diagnostics).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('skips colliding framework name + emits diagnostic', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-pack-ext-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(
        join(root, 'src', 'ext.ts'),
        [
          "export default {",
          "  framework: 'nestjs',", // collides with built-in
          "  label: 'Custom',",
          "  fileMatches: () => false,",
          "  extract: () => ({ nodes: [], edges: [] }),",
          "};",
        ].join('\n'),
      );
      const result = await loadPackExtractors(
        makeDiscovery([
          {
            packageName: 'demo-pack',
            packageVersion: '0.0.1',
            manifestPath: join(root, 'sharkcraft-pack.ts'),
            packageRoot: root,
            manifest: {
              schema: 'sharkcraft.pack/v1',
              info: { name: 'demo-pack', version: '0.0.1' },
              contributions: { frameworkExtractorFiles: ['src/ext.ts'] },
            },
            contributionCounts: {
              knowledgeFiles: 0, ruleFiles: 0, pathFiles: 0, templateFiles: 0,
              pipelineFiles: 0, docsFiles: 0, presetFiles: 0,
              scaffoldPatternFiles: 0, policyCheckFiles: 0, constructFiles: 0,
              constructFacetFiles: 0, playbookFiles: 0, delegateRecipeFiles: 0,
            },
            validationIssues: [],
            valid: true,
          },
        ]),
        new Set(['nestjs']),
      );
      expect(result.extractors.length).toBe(0);
      expect(result.diagnostics.some((d) => d.includes('already registered'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('invalid extractor shape produces a diagnostic, not a throw', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-pack-ext-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(
        join(root, 'src', 'ext.ts'),
        "export default { notAnExtractor: true };",
      );
      const result = await loadPackExtractors(
        makeDiscovery([
          {
            packageName: 'demo-pack',
            packageVersion: '0.0.1',
            manifestPath: join(root, 'manifest.ts'),
            packageRoot: root,
            manifest: {
              schema: 'sharkcraft.pack/v1',
              info: { name: 'demo-pack', version: '0.0.1' },
              contributions: { frameworkExtractorFiles: ['src/ext.ts'] },
            },
            contributionCounts: {
              knowledgeFiles: 0, ruleFiles: 0, pathFiles: 0, templateFiles: 0,
              pipelineFiles: 0, docsFiles: 0, presetFiles: 0,
              scaffoldPatternFiles: 0, policyCheckFiles: 0, constructFiles: 0,
              constructFacetFiles: 0, playbookFiles: 0, delegateRecipeFiles: 0,
            },
            validationIssues: [],
            valid: true,
          },
        ]),
        new Set(),
      );
      expect(result.extractors.length).toBe(0);
      expect(result.diagnostics.some((d) => d.includes('invalid extractor shape') || d.includes('no extractor exports found'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
