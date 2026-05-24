import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '@shrkcrft/graph';
import {
  graphCyclesGate,
  graphUnresolvedGate,
  impactBaselineGate,
  structuralPatternsGate,
  intentClassifierGate,
} from '../index.ts';

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `shrk-q-gates-${prefix}-`));
}

function writeJson(root: string, rel: string, body: unknown): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, JSON.stringify(body, null, 2), 'utf8');
}

describe('graphCyclesGate', () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot('cycles');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('skipped when index missing', () => {
    const r = graphCyclesGate(root);
    expect(r.status).toBe('skipped');
  });

  test('passes on a leaf-only fixture', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
    );
    mkdirSync(join(root, 'packages', 'p', 'src'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'p', 'package.json'),
      JSON.stringify({ name: '@demo/p', main: 'src/index.ts' }, null, 2),
    );
    writeFileSync(join(root, 'packages', 'p', 'src', 'index.ts'), 'export const x = 1;');
    buildFullIndex({ projectRoot: root });
    const r = graphCyclesGate(root);
    expect(r.status).toBe('pass');
    expect(r.message).toContain('0 cycle');
  });

  test('warns on a manufactured 3-file cycle', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
    );
    mkdirSync(join(root, 'packages', 'p', 'src'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'p', 'package.json'),
      JSON.stringify({ name: '@demo/p', main: 'src/a.ts' }, null, 2),
    );
    writeFileSync(join(root, 'packages', 'p', 'src', 'a.ts'), "import './b.ts'; export const a = 1;");
    writeFileSync(join(root, 'packages', 'p', 'src', 'b.ts'), "import './c.ts'; export const b = 1;");
    writeFileSync(join(root, 'packages', 'p', 'src', 'c.ts'), "import './a.ts'; export const c = 1;");
    buildFullIndex({ projectRoot: root });
    const r = graphCyclesGate(root);
    expect(r.status).toBe('warn');
    expect(r.message).toContain('1 import cycle');
  });

  test('failOnLarge=true escalates warn to fail', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
    );
    mkdirSync(join(root, 'packages', 'p', 'src'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'p', 'package.json'),
      JSON.stringify({ name: '@demo/p', main: 'src/a.ts' }, null, 2),
    );
    writeFileSync(join(root, 'packages', 'p', 'src', 'a.ts'), "import './b.ts'; export const a = 1;");
    writeFileSync(join(root, 'packages', 'p', 'src', 'b.ts'), "import './c.ts'; export const b = 1;");
    writeFileSync(join(root, 'packages', 'p', 'src', 'c.ts'), "import './a.ts'; export const c = 1;");
    buildFullIndex({ projectRoot: root });
    const r = graphCyclesGate(root, { failOnLarge: true });
    expect(r.status).toBe('fail');
  });
});

describe('graphUnresolvedGate', () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot('unres');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('skipped when index missing', () => {
    expect(graphUnresolvedGate(root).status).toBe('skipped');
  });

  test('passes when there are no unresolved imports', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
    );
    mkdirSync(join(root, 'packages', 'p', 'src'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'p', 'package.json'),
      JSON.stringify({ name: '@demo/p', main: 'src/index.ts' }, null, 2),
    );
    writeFileSync(join(root, 'packages', 'p', 'src', 'index.ts'), 'export const x = 1;');
    buildFullIndex({ projectRoot: root });
    expect(graphUnresolvedGate(root).status).toBe('pass');
  });

  test('warns on broken imports by default; fails with failOnAny', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
    );
    mkdirSync(join(root, 'packages', 'p', 'src'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'p', 'package.json'),
      JSON.stringify({ name: '@demo/p', main: 'src/a.ts' }, null, 2),
    );
    writeFileSync(
      join(root, 'packages', 'p', 'src', 'a.ts'),
      "import './missing'; export const a = 1;",
    );
    buildFullIndex({ projectRoot: root });
    expect(graphUnresolvedGate(root).status).toBe('warn');
    expect(graphUnresolvedGate(root, { failOnAny: true }).status).toBe('fail');
  });
});

describe('impactBaselineGate', () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot('impact-baseline');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('skipped without a baseline', () => {
    expect(impactBaselineGate(root).status).toBe('skipped');
  });

  test('skipped when baseline present but last absent', () => {
    writeJson(root, '.sharkcraft/impact/baseline.json', {
      schema: 'sharkcraft.impact-run/v1',
      generatedAt: '2026-05-22T10:00:00Z',
      inputKind: 'files',
      inputSummary: 'x',
      risk: 'low',
      directDependentCount: 0,
      transitiveDependentCount: 0,
      affectedPackageCount: 0,
      affectedSymbolCount: 0,
      affectedCallerFileCount: 0,
      affectedRuleCount: 0,
      affectedTemplateCount: 0,
      likelyTestCount: 0,
      publicApiTouched: false,
      riskReasons: [],
      validationScope: [],
      diagnostics: [],
    });
    expect(impactBaselineGate(root).status).toBe('skipped');
  });

  test('passes when within baseline; warns when worsened', () => {
    const baseline = {
      schema: 'sharkcraft.impact-run/v1',
      generatedAt: '2026-05-20T10:00:00Z',
      inputKind: 'files',
      inputSummary: 'core.ts',
      risk: 'low',
      directDependentCount: 2,
      transitiveDependentCount: 5,
      affectedPackageCount: 1,
      affectedSymbolCount: 0,
      affectedCallerFileCount: 0,
      affectedRuleCount: 0,
      affectedTemplateCount: 0,
      likelyTestCount: 0,
      publicApiTouched: false,
      riskReasons: [],
      validationScope: [],
      diagnostics: [],
    };
    writeJson(root, '.sharkcraft/impact/baseline.json', baseline);
    writeJson(root, '.sharkcraft/impact/last.json', baseline);
    expect(impactBaselineGate(root).status).toBe('pass');
    writeJson(root, '.sharkcraft/impact/last.json', {
      ...baseline,
      risk: 'high',
      directDependentCount: 12,
    });
    expect(impactBaselineGate(root).status).toBe('warn');
    expect(impactBaselineGate(root, { failOnWorsened: true }).status).toBe('fail');
  });
});

describe('structuralPatternsGate', () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot('patterns');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('skipped when no registry', () => {
    expect(structuralPatternsGate(root).status).toBe('skipped');
  });

  test('passes when all entries valid', () => {
    writeJson(root, '.sharkcraft/structural/patterns.json', {
      schema: 'sharkcraft.structural-pattern-registry/v1',
      patterns: [
        {
          id: 'p',
          pattern: { kind: 'Decorator', name: 'Controller' },
          addedAt: '2026-05-22T10:00:00Z',
          lastValidatedAt: '2026-05-22T11:00:00Z',
        },
      ],
    });
    expect(structuralPatternsGate(root).status).toBe('pass');
  });

  test('warns on broken entry; fails with failOnInvalid', () => {
    writeJson(root, '.sharkcraft/structural/patterns.json', {
      schema: 'sharkcraft.structural-pattern-registry/v1',
      patterns: [
        {
          id: 'broken',
          pattern: { kind: 'NoSuch' },
          addedAt: '2026-05-22T10:00:00Z',
        },
      ],
    });
    expect(structuralPatternsGate(root).status).toBe('warn');
    expect(structuralPatternsGate(root, { failOnInvalid: true }).status).toBe('fail');
  });
});

describe('intentClassifierGate', () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot('intent');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('skipped without a fixture', () => {
    expect(intentClassifierGate(root).status).toBe('skipped');
  });

  test('passes at 100% accuracy', () => {
    writeJson(root, 'sharkcraft/intent-benchmark.json', {
      schema: 'sharkcraft.intent-benchmark/v1',
      cases: [
        { task: 'fix the broken login', expected: 'bug-fix' },
        { task: 'add a feature', expected: 'feature' },
      ],
    });
    expect(intentClassifierGate(root).status).toBe('pass');
  });

  test('warns / fails below thresholds', () => {
    writeJson(root, 'sharkcraft/intent-benchmark.json', {
      schema: 'sharkcraft.intent-benchmark/v1',
      cases: [
        { task: 'fix bug', expected: 'bug-fix' },
        { task: 'totally random text', expected: 'release' },
        { task: 'add a feature', expected: 'feature' },
      ],
    });
    // 2/3 ≈ 66.7%. Default warnBelow=0.95, failBelow=0.6 → warn.
    expect(intentClassifierGate(root).status).toBe('warn');
    // Tighten failBelow to 0.7 → fail.
    expect(intentClassifierGate(root, { failBelow: 0.7 }).status).toBe('fail');
  });
});
