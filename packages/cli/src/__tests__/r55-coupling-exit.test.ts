/**
 * `--fail-on engine` exits non-zero iff at least one hit is
 * category-engine. The bucket name reflects the current source
 * location, not the recommended target.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import {
  auditProjectCoupling,
  CouplingExternalizationTarget,
} from '@shrkcrft/inspector';

function withTmpRepo<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(nodePath.join(os.tmpdir(), 'shrk-r55-coupling-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('project-coupling categories', () => {
  test('hits in packages/ classify as engine (renamed from pack)', () => {
    withTmpRepo((root) => {
      mkdirSync(nodePath.join(root, 'packages/example/src'), { recursive: true });
      writeFileSync(
        nodePath.join(root, 'packages/example/src/code.ts'),
        `// uses libs/legacy for resolution\nexport const x = 1;\n`,
      );
      const r = auditProjectCoupling({ projectRoot: root, tokens: ['libs/legacy'] });
      expect(r.hits.length).toBeGreaterThan(0);
      expect(r.hits[0]!.externalizationTarget).toBe(CouplingExternalizationTarget.Engine);
      expect(r.verdict).toBe('has-coupling');
    });
  });

  test('fixture-only stays its own category', () => {
    withTmpRepo((root) => {
      mkdirSync(nodePath.join(root, 'packages/example/src/__tests__'), { recursive: true });
      writeFileSync(
        nodePath.join(root, 'packages/example/src/__tests__/x.test.ts'),
        `describe('libs/legacy fixture', () => {});\n`,
      );
      const r = auditProjectCoupling({ projectRoot: root, tokens: ['libs/legacy'] });
      expect(r.hits.length).toBeGreaterThan(0);
      expect(r.hits[0]!.externalizationTarget).toBe(CouplingExternalizationTarget.FixtureOnly);
      expect(r.verdict).toBe('clean');
    });
  });

  test('hits in sharkcraft/ classify as local-config (not engine)', () => {
    withTmpRepo((root) => {
      mkdirSync(nodePath.join(root, 'sharkcraft'), { recursive: true });
      writeFileSync(
        nodePath.join(root, 'sharkcraft/config.ts'),
        `// uses libs/legacy for resolution\nexport const x = 1;\n`,
      );
      const r = auditProjectCoupling({ projectRoot: root, tokens: ['libs/legacy'] });
      expect(r.hits.length).toBeGreaterThan(0);
      expect(r.hits[0]!.externalizationTarget).toBe(CouplingExternalizationTarget.LocalConfig);
      // engine-category hits should be zero — the local-config hits are
      // not engine bugs, so `--fail-on engine` would NOT fail here.
      const engineHits = r.hits.filter(
        (h) => h.externalizationTarget === CouplingExternalizationTarget.Engine,
      );
      expect(engineHits.length).toBe(0);
    });
  });
});
