/**
 * Pack-contribution honesty coverage (findings P1, P2, P3).
 *
 * Guards that the pre-publish release gate, discovery contribution counts, and
 * the path loader all cover the FULL canonical set of contribution kinds — not
 * the partial hard-coded lists that previously let "extended" contributions
 * (framework extractors / conventions / helpers / decisions / …) ship broken or
 * silently report zero.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import {
  CONTRIBUTION_FILE_KEYS,
  FUTURE_CONTRIBUTION_FILE_KEYS,
} from '@shrkcrft/plugin-api';
import { countContributions, type IDiscoveredPack } from '@shrkcrft/packs';
import { inspectSharkcraft, runPackReleaseCheck, scorePack } from '../index.ts';

/** Write a pack whose package.json points at a JSON manifest with `contributions`. */
function makeJsonPack(
  packDir: string,
  contributions: Record<string, readonly string[]>,
): void {
  mkdirSync(packDir, { recursive: true });
  writeFileSync(
    nodePath.join(packDir, 'package.json'),
    JSON.stringify({
      name: 'cov-pack',
      version: '0.0.1',
      sharkcraft: { manifest: './manifest.signed.json' },
      files: ['**'],
    }),
  );
  writeFileSync(
    nodePath.join(packDir, 'manifest.signed.json'),
    JSON.stringify({
      schema: 'sharkcraft.pack/v1',
      info: { name: 'cov-pack', version: '0.0.1' },
      contributions,
    }),
  );
}

function missingFinding(
  findings: { code: string; message: string }[],
  key: string,
): { code: string; message: string } | undefined {
  return findings.find(
    (f) => f.code === 'contribution-missing' && f.message.startsWith(`${key} `),
  );
}

describe('pack contribution coverage', () => {
  // P1 — the release gate must verify "extended" contribution slots, not just
  // the historical 16.
  test('release check fails on broken framework/convention/helper contributions', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-pcc-rc-'));
    try {
      const packDir = nodePath.join(root, 'pack');
      makeJsonPack(packDir, {
        frameworkExtractorFiles: ['./missing-extractor.ts'],
        conventionFiles: ['./missing-conventions.ts'],
        helperFiles: ['./missing-helpers.ts'],
      });
      const check = await runPackReleaseCheck(packDir);
      expect(check.passed).toBe(false);
      for (const key of ['frameworkExtractorFiles', 'conventionFiles', 'helperFiles']) {
        const finding = missingFinding([...check.findings], key);
        expect(finding).toBeDefined();
        expect(finding?.code).toBe('contribution-missing');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // P1 parity — EVERY canonical key is exercised by the release check, while the
  // documented Future no-op slots are deliberately NOT verified.
  test('every canonical contribution key is exercised by the release check', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-pcc-parity-'));
    try {
      const packDir = nodePath.join(root, 'pack');
      const contributions: Record<string, readonly string[]> = {};
      for (const key of [...CONTRIBUTION_FILE_KEYS, ...FUTURE_CONTRIBUTION_FILE_KEYS]) {
        contributions[key] = [`./missing-${key}.ts`];
      }
      makeJsonPack(packDir, contributions);
      const check = await runPackReleaseCheck(packDir);
      const findings = [...check.findings];
      for (const key of CONTRIBUTION_FILE_KEYS) {
        // Each canonical slot's broken file must surface as contribution-missing.
        expect(missingFinding(findings, key)).toBeDefined();
      }
      for (const key of FUTURE_CONTRIBUTION_FILE_KEYS) {
        // Future no-op slots have no consumer yet, so verifying them would be
        // dishonest — they must NOT produce a finding.
        expect(missingFinding(findings, key)).toBeUndefined();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // P3 — counting + scoring recognise an extended-only pack as contributing.
  test('extended-only manifest reports non-zero counts and no "no contributions" note', async () => {
    const counts = countContributions({
      conventionFiles: ['conventions.ts'],
      helperFiles: ['helpers.ts'],
      frameworkExtractorFiles: ['ext.ts'],
    });
    expect(counts.conventionFiles).toBe(1);
    expect(counts.helperFiles).toBe(1);
    expect(counts.frameworkExtractorFiles).toBe(1);
    // None of the originally-summed 8 kinds are present — under the old
    // totalDeclared this would have been 0 and triggered the false note.
    expect(counts.knowledgeFiles).toBe(0);

    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-pcc-score-'));
    try {
      writeFileSync(
        nodePath.join(root, 'package.json'),
        JSON.stringify({ name: 'x', version: '0.0.0' }),
      );
      const inspection = await inspectSharkcraft({ cwd: root });
      const pack: IDiscoveredPack = {
        packageName: 'extended-only-pack',
        packageVersion: '0.0.1',
        manifestPath: '',
        packageRoot: root,
        contributionCounts: counts,
        validationIssues: [],
        valid: true,
      };
      const score = scorePack(inspection, pack);
      const contribDim = score.dimensions.find((d) => d.id === 'contributions');
      expect(contribDim).toBeDefined();
      expect(contribDim?.notes ?? []).not.toContain('Pack declares no contributions');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // P2 — pathConventionFiles actually loads into pathService.
  test('pathConventionFiles load contributed conventions into pathService', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-pcc-path-'));
    try {
      writeFileSync(
        nodePath.join(root, 'package.json'),
        JSON.stringify({ name: 'pcf-workspace', version: '0.0.0' }),
      );
      const packRoot = nodePath.join(root, 'node_modules/@pcf/pack');
      mkdirSync(packRoot, { recursive: true });
      writeFileSync(
        nodePath.join(packRoot, 'package.json'),
        JSON.stringify({
          name: '@pcf/pack',
          version: '0.0.1',
          sharkcraft: { manifest: './sharkcraft.plugin.ts' },
        }),
      );
      writeFileSync(
        nodePath.join(packRoot, 'sharkcraft.plugin.ts'),
        `export default {
  schema: 'sharkcraft.pack/v1',
  info: { name: '@pcf/pack', version: '0.0.1' },
  contributions: { pathConventionFiles: ['./paths.ts'] },
};
`,
      );
      writeFileSync(
        nodePath.join(packRoot, 'paths.ts'),
        `export default [{
  id: 'pcf.convention.shared',
  title: 'Pack path convention (test)',
  type: 'path',
  priority: 'medium',
  scope: ['typescript'],
  tags: ['shared'],
  appliesWhen: ['generate-utility'],
  content: 'Test pack convention: shared utilities under src/shared.',
  metadata: { path: 'src/shared', description: 'test' },
}];
`,
      );
      const inspection = await inspectSharkcraft({ cwd: root });
      const ids = inspection.pathService.list().map((p) => p.id);
      expect(ids).toContain('pcf.convention.shared');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
