import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '@shrkcrft/graph';
import { runArchCheck } from '@shrkcrft/architecture-guard';
import { archGate } from '../index.ts';

/**
 * §3.1 — the composite quality gate must treat "NEW architecture error" as
 * *introduced by this change* (diff vs HEAD), not drift against a frozen,
 * possibly months-old baseline. These tests construct the inputs directly
 * (fixture + explicit `changedFiles`) so they never depend on live git state.
 */

/** Fixture: package `a` illegally imports a PRIVATE internal file of package `b`
 *  cross-package — a `public-api-misuse` error originating in a/src/index.ts. */
function fixtureWithArchError(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-s31-arch-'));
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

/** Freeze an EMPTY baseline so the fixture's error reads as "NEW since baseline". */
function writeEmptyBaseline(root: string): void {
  const abs = join(root, '.sharkcraft', 'architecture', 'baseline.json');
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(
    abs,
    JSON.stringify(
      {
        schema: 'sharkcraft.architecture-snapshot/v1',
        generatedAt: '2020-01-01T00:00:00.000Z',
        filesAnalyzed: 0,
        countsBySeverity: { error: 0, warning: 0, info: 0 },
        countsByKind: {},
        violationIds: [],
      },
      null,
      2,
    ),
    'utf8',
  );
}

interface IArchDetails {
  newErrors?: number;
  driftErrors?: number;
  changeScoped?: boolean;
}

describe('archGate change-scoped NEW attribution (§3.1)', () => {
  let root = '';
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  test('NEW error in a CHANGED file → BLOCKING (fail)', () => {
    root = fixtureWithArchError();
    writeEmptyBaseline(root);
    // The changed set INCLUDES the error's origin file(s) → attributable → block.
    const originFiles = [...new Set(runArchCheck({ projectRoot: root }).violations.map((v) => v.file))];
    const r = archGate(root, { changedFiles: originFiles });
    expect(r.status).toBe('fail');
    const d = r.details as IArchDetails;
    expect(d.newErrors ?? 0).toBeGreaterThanOrEqual(1);
    expect(d.driftErrors ?? 0).toBe(0);
    expect(d.changeScoped).toBe(true);
  });

  test('NEW error in an UNTOUCHED file → INFORMATIONAL drift (pass, exit 0)', () => {
    root = fixtureWithArchError();
    writeEmptyBaseline(root);
    // The changed set does NOT include the error's origin file → drift only.
    const r = archGate(root, { changedFiles: ['packages/unrelated/src/other.ts'] });
    expect(r.status).toBe('pass');
    const d = r.details as IArchDetails;
    expect(d.newErrors ?? 0).toBe(0);
    expect(d.driftErrors ?? 0).toBeGreaterThanOrEqual(1);
    // Honest posture: not a misleading all-clear over zero attributed errors.
    expect(r.message).toContain('change-attributable');
  });

  test('empty changed set (clean tree) → no change-attributable errors (pass)', () => {
    root = fixtureWithArchError();
    writeEmptyBaseline(root);
    const r = archGate(root, { changedFiles: [] });
    expect(r.status).toBe('pass');
    const d = r.details as IArchDetails;
    expect(d.newErrors ?? 0).toBe(0);
    expect(d.driftErrors ?? 0).toBeGreaterThanOrEqual(1);
  });

  test('changedFiles undefined → legacy baseline-relative: any NEW error blocks', () => {
    root = fixtureWithArchError();
    writeEmptyBaseline(root);
    const r = archGate(root);
    expect(r.status).toBe('fail');
    expect((r.details as IArchDetails).changeScoped).toBe(false);
  });
});
