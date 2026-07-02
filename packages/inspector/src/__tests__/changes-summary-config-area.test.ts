import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildChangesSummary, ChangeArea } from '../changes-summary.ts';
import { inspectSharkcraft } from '../sharkcraft-inspector.ts';

/**
 * §3.5 — built-in config / tooling area defaults for the `changes` classifier.
 *
 * A large share of a typical changeset is config / tooling / manifest / non-lib
 * paths. Previously those fell through to `unknown` (firing the loud
 * `unknown = taxonomy gap` flag). Now recognized config/tooling paths resolve to
 * a built-in `config` / `tooling` area, and `unknown` is reserved for genuinely
 * unclassifiable paths. The declared taxonomy (boundary globs + package roots)
 * must still win where it applies.
 */
function setupRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-changes-config-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '0.0.0' }));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    ["export default {", "  projectName: 'demo',", "  boundaryFiles: ['boundaries.ts'],", "};"].join(
      '\n',
    ),
  );
  writeFileSync(
    join(root, 'sharkcraft', 'boundaries.ts'),
    [
      'export default [{',
      "  id: 'demo.backend',",
      "  title: 'backend layer',",
      "  severity: 'error',",
      "  from: ['services/api/**'],",
      "  forbiddenImports: ['@demo/ui'],",
      "  tags: ['backend'],",
      "  appliesWhen: ['review-code'],",
      '}];',
    ].join('\n'),
  );
  return root;
}

describe('changes summary — built-in config/tooling area (§3.5)', () => {
  test('recognized config/tooling/manifest paths resolve to config/tooling, not unknown', async () => {
    const root = setupRepo();
    try {
      const inspection = await inspectSharkcraft({ cwd: root });
      const report = await buildChangesSummary(inspection, {
        files: [
          'nx.json',
          'tsconfig.base.json',
          'tsconfig.json',
          'biome.json',
          'bunfig.toml',
          'vite.config.ts',
          '.eslintrc.json',
          '.prettierrc',
          '.npmrc',
          '.editorconfig',
          'package.json',
          'package-lock.json',
          'yarn.lock',
          'pnpm-lock.yaml',
          'bun.lockb',
          'scripts/foo.ts',
          '.github/workflows/x.yml',
          '.husky/pre-commit',
          'ci/deploy.sh',
          'tooling/build-dist.mjs',
          'build/make.ts',
          'src/really/unknown/thing.ts',
        ],
      });
      const areaOf = (p: string): string => report.files.find((f) => f.path === p)!.area;

      // Manifests / config files → config.
      for (const cfg of [
        'nx.json',
        'tsconfig.base.json',
        'tsconfig.json',
        'biome.json',
        'bunfig.toml',
        'vite.config.ts',
        '.eslintrc.json',
        '.prettierrc',
        '.npmrc',
        '.editorconfig',
        'package.json',
        'package-lock.json',
        'yarn.lock',
        'pnpm-lock.yaml',
        'bun.lockb',
      ]) {
        expect(areaOf(cfg)).toBe(ChangeArea.Config);
      }

      // CI / build / tooling directories → tooling.
      for (const tool of [
        '.github/workflows/x.yml',
        '.husky/pre-commit',
        'ci/deploy.sh',
        'tooling/build-dist.mjs',
        'build/make.ts',
      ]) {
        expect(areaOf(tool)).toBe(ChangeArea.Tooling);
      }

      // `scripts/` keeps its own dedicated area (still not unknown).
      expect(areaOf('scripts/foo.ts')).toBe(ChangeArea.Scripts);

      // A genuinely unclassifiable source file must stay unknown.
      expect(areaOf('src/really/unknown/thing.ts')).toBe(ChangeArea.Unknown);

      // The loud diagnostic fires only for the one genuinely-unknown path.
      expect(report.unknownFiles).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('declared taxonomy still wins over the config/tooling fallback', async () => {
    const root = setupRepo();
    try {
      const inspection = await inspectSharkcraft({ cwd: root });
      const report = await buildChangesSummary(inspection, {
        files: [
          // A manifest inside a monorepo package root → attributed to the
          // package (declared taxonomy), not the generic config bucket.
          'packages/widget/package.json',
          'packages/widget/tsconfig.json',
          // A config file under a declared boundary glob → the boundary's area.
          'services/api/vite.config.ts',
        ],
      });
      const areaOf = (p: string): string => report.files.find((f) => f.path === p)!.area;
      expect(areaOf('packages/widget/package.json')).toBe('widget');
      expect(areaOf('packages/widget/tsconfig.json')).toBe('widget');
      expect(areaOf('services/api/vite.config.ts')).toBe('backend');
      expect(report.unknownFiles).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
