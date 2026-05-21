import { describe, expect, test } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planPackScaffold } from '../commands/packs-new.ts';

describe('pack scaffolder (planPackScaffold)', () => {
  test('generic kind emits the documented file set', () => {
    const result = planPackScaffold({
      name: 'demo-pack',
      outDir: join(tmpdir(), 'unused'),
      kind: 'generic',
    });
    const paths = result.files.map((f) => f.relativePath);
    expect(paths).toContain('package.json');
    expect(paths).toContain('README.md');
    expect(paths).toContain('SECURITY.md');
    expect(paths).toContain('src/sharkcraft.plugin.ts');
    expect(paths).toContain('src/assets/knowledge.ts');
    expect(paths).toContain('src/assets/rules.ts');
    expect(paths).toContain('src/assets/paths.ts');
    expect(paths).toContain('src/assets/templates.ts');
    expect(paths).toContain('src/assets/pipelines.ts');
    expect(paths).toContain('src/assets/presets.ts');
    expect(paths).toContain('src/assets/docs/overview.md');
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
});
