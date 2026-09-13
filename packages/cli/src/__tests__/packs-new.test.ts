import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { discoverPacks } from '@shrkcrft/packs';
import { inspectSharkcraft, typecheckFiles } from '@shrkcrft/inspector';
import { planPackScaffold, type IScaffoldPackInput } from '../commands/packs-new.ts';

const REPO = resolve(import.meta.dir, '../../../..');
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

function materialize(dir: string, input: Omit<IScaffoldPackInput, 'outDir'>): ReturnType<typeof planPackScaffold> {
  const r = planPackScaffold({ ...input, outDir: dir });
  for (const f of r.files) write(dir, f.relativePath, f.body);
  return r;
}

describe('pack scaffolder (planPackScaffold)', () => {
  test('generic kind emits the documented file set — and no empty, undeclared asset', () => {
    const result = planPackScaffold({
      name: 'demo-pack',
      outDir: join(tmpdir(), 'unused'),
      kind: 'generic',
    });
    const paths = result.files.map((f) => f.relativePath);
    expect(paths).toContain('package.json');
    expect(paths).toContain('README.md');
    expect(paths).toContain('SECURITY.md');
    expect(paths).toContain('tsconfig.json');
    expect(paths).toContain('src/sharkcraft.plugin.ts');
    expect(paths).toContain('src/assets/knowledge.ts');
    expect(paths).toContain('src/assets/rules.ts');
    expect(paths).toContain('src/assets/paths.ts');
    expect(paths).toContain('src/assets/docs/overview.md');
    // A generic pack ships no template / pipeline / preset — so no empty file
    // the manifest would have to list (or, worse, leave unlisted and invisible).
    expect(paths).not.toContain('src/assets/templates.ts');
    expect(paths).not.toContain('src/assets/pipelines.ts');
    expect(paths).not.toContain('src/assets/presets.ts');
  });

  test('framework kind (or --with-examples) adds templates + pipelines; --preset adds presets', () => {
    const fw = planPackScaffold({ name: 'fw', outDir: '/tmp/x', kind: 'framework' }).files.map((f) => f.relativePath);
    expect(fw).toContain('src/assets/templates.ts');
    expect(fw).toContain('src/assets/pipelines.ts');
    const withPreset = planPackScaffold({ name: 'p', outDir: '/tmp/x', kind: 'generic', preset: 'bun-service' });
    expect(withPreset.files.map((f) => f.relativePath)).toContain('src/assets/presets.ts');
  });

  test('architecture kind adds boundaries.ts', () => {
    const r = planPackScaffold({ name: 'arch', outDir: '/tmp/x', kind: 'architecture' });
    const paths = r.files.map((f) => f.relativePath);
    expect(paths).toContain('src/assets/boundaries.ts');
  });

  test('enterprise kind adds review-workflow + security-baseline docs', () => {
    const r = planPackScaffold({ name: 'corp', outDir: '/tmp/x', kind: 'enterprise' });
    const paths = r.files.map((f) => f.relativePath);
    expect(paths).toContain('docs/review-workflow.md');
    expect(paths).toContain('docs/security-baseline.md');
  });

  test('scope is reflected in package.json', () => {
    const r = planPackScaffold({
      name: 'foo',
      outDir: '/tmp/x',
      kind: 'generic',
      scope: '@acme',
    });
    const pkg = JSON.parse(r.files.find((f) => f.relativePath === 'package.json')!.body);
    expect(pkg.name).toBe('@acme/foo');
    expect(pkg.sharkcraft.kind).toBe('generic');
  });

  test('preset id is recorded in package.json sharkcraft section', () => {
    const r = planPackScaffold({
      name: 'foo',
      outDir: '/tmp/x',
      kind: 'generic',
      preset: 'bun-service',
    });
    const pkg = JSON.parse(r.files.find((f) => f.relativePath === 'package.json')!.body);
    expect(pkg.sharkcraft.preset).toBe('bun-service');
  });

  test('package.json points discovery at the manifest; no main/exports into a dist the scaffold never builds', () => {
    const r = planPackScaffold({ name: 'foo', outDir: '/tmp/x', kind: 'framework' });
    const pkg = r.packageJson as {
      sharkcraft: { manifest: string };
      main?: string;
      exports?: unknown;
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.sharkcraft.manifest).toBe('./src/sharkcraft.plugin.ts');
    expect(pkg.main).toBe('./src/sharkcraft.plugin.ts');
    expect(pkg.exports).toBeUndefined();
    expect(pkg.scripts['typecheck']).toBe('tsc -p tsconfig.json');
    expect(pkg.scripts['test']).toContain('--typecheck');
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(['@shrkcrft/plugin-api', 'typescript']);
    const tsconfig = JSON.parse(r.files.find((f) => f.relativePath === 'tsconfig.json')!.body);
    expect(tsconfig.compilerOptions).toMatchObject({ noEmit: true, allowImportingTsExtensions: true, strict: true });
  });

  test('every emitted asset is declared in the manifest, and every declared file is emitted', () => {
    for (const input of [
      { name: 'g', kind: 'generic' as const },
      { name: 'f', kind: 'framework' as const, preset: 'p1' },
      { name: 'a', kind: 'architecture' as const, withExamples: true },
      { name: 'e', kind: 'enterprise' as const },
    ]) {
      const r = planPackScaffold({ ...input, outDir: '/tmp/x' });
      const manifest = r.files.find((f) => f.relativePath === 'src/sharkcraft.plugin.ts')!.body;
      const declared = [...manifest.matchAll(/'\.\/(src\/assets\/[^']+)'/g)].map((m) => m[1]!).sort();
      const emitted = r.files.map((f) => f.relativePath).filter((p) => p.startsWith('src/assets/')).sort();
      expect({ kind: input.kind, declared }).toEqual({ kind: input.kind, declared: emitted });
      expect(manifest).toContain('satisfies ISharkCraftPackManifest');
      expect(manifest).toContain(`import type { ISharkCraftPackManifest } from '@shrkcrft/plugin-api';`);
    }
  });
});

describe('the scaffold is a valid, discoverable, loadable pack', () => {
  test('copied into a consumer node_modules, real discovery reports it VALID and its entries load', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-r75-scaffold-consumer-'));
    roots.push(root);
    write(root, 'package.json', JSON.stringify({ name: 'consumer', version: '0.0.0' }));
    write(root, 'sharkcraft/sharkcraft.config.ts', "export default { projectName: 'consumer' };\n");
    materialize(join(root, 'node_modules', '@acme', 'demo-pack'), {
      name: 'demo-pack',
      scope: '@acme',
      kind: 'framework',
      preset: 'demo-preset',
    });
    const discovery = await discoverPacks({ projectRoot: root, noCache: true });
    const pack = discovery.discoveredPacks.find((p) => p.packageName === '@acme/demo-pack');
    expect({ valid: pack?.valid, loadError: pack?.loadError, issues: pack?.validationIssues }).toEqual({
      valid: true,
      loadError: undefined,
      issues: [],
    });
    const inspection = await inspectSharkcraft({ cwd: root });
    const ids = inspection.knowledgeEntries.map((e) => e.id);
    expect(ids).toContain('framework.overview');
    expect(ids).toContain('rule.example');
    expect(ids).toContain('demo-pack.path.source-layout');
    expect(inspection.templateRegistry.list().map((t) => t.id)).toContain('pack.example.service');
    expect(inspection.pipelineRegistry.list().map((p) => p.id)).toContain('pack.example.pipeline');
    expect(inspection.loaderDiagnostics.filter((d) => d.status !== 'ok')).toEqual([]);
  });
});

describe('the scaffold type-checks clean against the real SDK types', () => {
  /** One program over every scaffold under `parent`, with `@shrkcrft/*` mapped to this repo's sources. */
  function typecheckScaffolds(parent: string, packDirs: readonly string[], compilerOptions: Record<string, unknown>) {
    write(
      parent,
      'tsconfig.test.json',
      JSON.stringify({
        compilerOptions: {
          ...compilerOptions,
          baseUrl: '.',
          paths: { '@shrkcrft/*': [`${REPO}/packages/*/src/index.ts`] },
        },
      }),
    );
    const rootNames = packDirs.flatMap((dir) => [
      join(dir, 'src/sharkcraft.plugin.ts'),
      ...readdirSync(join(dir, 'src/assets'))
        .filter((f) => f.endsWith('.ts'))
        .map((f) => join(dir, 'src/assets', f)),
    ]);
    return typecheckFiles(parent, { rootNames, tsconfigPath: 'tsconfig.test.json', reportOnlyUnder: parent });
  }

  test(
    'every --kind (plus --with-examples and --preset) → 0 errors',
    () => {
      const parent = mkdtempSync(join(tmpdir(), 'shrk-r75-scaffold-tc-'));
      roots.push(parent);
      const inputs: Omit<IScaffoldPackInput, 'outDir'>[] = [
        { name: 'generic-pack', kind: 'generic' },
        { name: 'framework-pack', kind: 'framework', preset: 'p1' },
        { name: 'architecture-pack', kind: 'architecture', withExamples: true },
        { name: 'enterprise-pack', kind: 'enterprise' },
      ];
      let compilerOptions: Record<string, unknown> = {};
      const dirs = inputs.map((input) => {
        const dir = join(parent, input.name);
        const r = materialize(dir, input);
        compilerOptions = JSON.parse(r.files.find((f) => f.relativePath === 'tsconfig.json')!.body).compilerOptions;
        return dir;
      });
      const result = typecheckScaffolds(parent, dirs, compilerOptions);
      expect(result.ran).toBe(true);
      expect(result.errors.map((e) => `${e.file}:${e.line} ${e.message}`)).toEqual([]);
    },
    120_000,
  );

  test(
    'a reference with a bogus kind in a scaffolded asset fails the typecheck where it is written',
    () => {
      const parent = mkdtempSync(join(tmpdir(), 'shrk-r75-scaffold-bogus-'));
      roots.push(parent);
      const dir = join(parent, 'bogus-pack');
      const r = materialize(dir, { name: 'bogus-pack', kind: 'generic' });
      const knowledge = r.files.find((f) => f.relativePath === 'src/assets/knowledge.ts')!.body;
      write(dir, 'src/assets/knowledge.ts', knowledge.replace("appliesWhen: ['onboarding'],", "appliesWhen: ['onboarding'],\n    references: [{ kind: 'bogus', path: 'src' }],"));
      const compilerOptions = JSON.parse(r.files.find((f) => f.relativePath === 'tsconfig.json')!.body).compilerOptions;
      const result = typecheckScaffolds(parent, [dir], compilerOptions);
      expect(result.ran).toBe(true);
      expect(result.errors.some((e) => e.file.endsWith('src/assets/knowledge.ts') && e.message.includes('bogus'))).toBe(true);
    },
    120_000,
  );
});
