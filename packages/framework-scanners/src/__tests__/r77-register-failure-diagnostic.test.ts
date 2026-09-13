/**
 * Round 13 — `buildRegistryWithPacks` discarded a `register()` failure:
 * `loaded.diagnostics.concat(...)` threw its result away, so an extractor that
 * lost a registration race vanished with no diagnostic ("a loader never drops
 * an entry silently"). The race is real: the loader filters duplicates against
 * the registry as it stood when the call began, and two concurrent calls
 * sharing one registry both pass that filter. Real pack fixture, real loader,
 * real registry.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IPackDiscoveryResult } from '@shrkcrft/packs';
import { FrameworkExtractorRegistry } from '../extractor-api/extractor-registry.ts';
import { buildRegistryWithPacks } from '../runner/load-pack-extractors.ts';

function discoveryFor(root: string): IPackDiscoveryResult {
  const pack: IPackDiscoveryResult['validPacks'][number] = {
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
  };
  return {
    projectRoot: root,
    nodeModulesPath: join(root, 'node_modules'),
    nodeModulesExists: false,
    scannedPackageCount: 1,
    discoveredPacks: [pack],
    validPacks: [pack],
    invalidPacks: [],
    warnings: [],
  };
}

describe('buildRegistryWithPacks records a register() failure', () => {
  test('two concurrent calls on one registry: one registers, the other reports why it could not', async () => {
    const root = mkdtempSync(join(tmpdir(), 'r77-register-race-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(
        join(root, 'src', 'ext.ts'),
        [
          'export default {',
          "  framework: 'custom-fw',",
          "  label: 'Custom',",
          '  fileMatches: () => false,',
          '  extract: () => ({ nodes: [], edges: [] }),',
          '};',
        ].join('\n'),
      );
      const registry = new FrameworkExtractorRegistry();
      const discovery = discoveryFor(root);
      const results = await Promise.all([
        buildRegistryWithPacks(registry, discovery),
        buildRegistryWithPacks(registry, discovery),
      ]);
      expect(registry.list().map((e) => e.framework)).toEqual(['custom-fw']);
      const failures = results.flatMap((r) => r.diagnostics).filter((d) => d.includes('register failed'));
      expect(failures).toEqual(['custom-fw: register failed (framework extractor already registered: custom-fw)']);
      for (const r of results) expect(r.registry).toBe(registry);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
