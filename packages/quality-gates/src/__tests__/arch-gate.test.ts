import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '@shrkcrft/graph';
import { ArchReportStore, runArchCheck } from '@shrkcrft/architecture-guard';
import { archGate } from '../index.ts';

/** A fixture where package `a` imports a PRIVATE internal file from package `b`
 *  cross-package — a `public-api-misuse` error. */
function fixtureWithArchError(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-arch-gate-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
  );
  for (const name of ['a', 'b']) {
    mkdirSync(join(root, 'packages', name, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'packages', name, 'package.json'),
      JSON.stringify({ name: `@demo/${name}`, main: 'src/index.ts' }, null, 2),
    );
  }
  writeFileSync(
    join(root, 'packages', 'a', 'src', 'index.ts'),
    "import '../../b/src/internal.ts';\nexport const a = 1;",
  );
  writeFileSync(join(root, 'packages', 'b', 'src', 'index.ts'), 'export const b = 1;');
  writeFileSync(join(root, 'packages', 'b', 'src', 'internal.ts'), 'export const internal = 1;');
  buildFullIndex({ projectRoot: root });
  return root;
}

describe('archGate baseline-relative behavior', () => {
  let root = '';
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  test('no baseline → fails on any error + opt-in hint', () => {
    root = fixtureWithArchError();
    const r = archGate(root);
    expect(r.status).toBe('fail');
    expect(r.nextCommands).toContain('shrk arch baseline write');
  });

  test('a baseline covering the error → passes as baseline debt', () => {
    root = fixtureWithArchError();
    new ArchReportStore(root).writeBaseline(runArchCheck({ projectRoot: root }));
    const r = archGate(root);
    expect(r.status).toBe('pass');
    expect((r.details as { baselineErrors?: number } | undefined)?.baselineErrors).toBeGreaterThan(0);
  });

  test('a NEW error not in the baseline → fails', () => {
    root = fixtureWithArchError();
    const emptyBaseline = {
      schema: 'sharkcraft.architecture-snapshot/v1',
      generatedAt: '2020-01-01T00:00:00.000Z',
      filesAnalyzed: 0,
      countsBySeverity: { error: 0, warning: 0, info: 0 },
      countsByKind: {},
      violationIds: [],
    };
    const abs = join(root, '.sharkcraft', 'architecture', 'baseline.json');
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, JSON.stringify(emptyBaseline, null, 2), 'utf8');
    const r = archGate(root);
    expect(r.status).toBe('fail');
    expect(
      (r.details as { newViolationIds?: readonly string[] } | undefined)?.newViolationIds?.length,
    ).toBeGreaterThanOrEqual(1);
  });

  test('baselineRelative:false ignores the baseline → fails on total', () => {
    root = fixtureWithArchError();
    new ArchReportStore(root).writeBaseline(runArchCheck({ projectRoot: root }));
    const r = archGate(root, { baselineRelative: false });
    expect(r.status).toBe('fail');
  });
});
