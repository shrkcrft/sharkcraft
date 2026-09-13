/**
 * Round 11 — the registry-lifecycle scan is bounded, and honest about the bound.
 *
 *   §1.2#3  a capped scan is NOT a pass; sorted candidates + `offset` reach the
 *           remainder; pages union to the uncapped run.
 *   §6.1(b) every per-file step is linear on blanked buffers (runtime locks on
 *           the files that took 8–16 s), and line numbers are the declaration's.
 *   §6.2    the budget is checked INSIDE a file; an over-budget file is named and
 *           contributes nothing partial; a signal yields a partial report.
 *   §6.4(b) `skipDirsAdd` extends the defaults; a replacing `skipDirs` that
 *           drops node_modules/dist is reported by the scan and by `shrk doctor`.
 *
 * Real files on disk and a real config loaded through inspectSharkcraft — no
 * hand-built report or inspection shapes.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBlankRunHazards } from '@shrkcrft/boundaries';
import {
  buildRegistryLifecycleReport,
  createRegistryLifecycleScan,
  DEFAULT_REGISTRY_LIFECYCLE_SKIP_DIRS,
  REGISTRY_LIFECYCLE_PATTERNS,
  registryLifecycleVerdict,
  renderRegistryLifecycleReportText,
  resolveRegistryLifecycleSkipDirs,
  runRegistryLifecycleScan,
  type IRegistryLifecycleReport,
  type RegistryLifecycleCheckpoint,
} from '../registry-lifecycle.ts';
import { inspectSharkcraft, runDoctor } from '../sharkcraft-inspector.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-lifecycle-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

const pair = (n: string): string =>
  `const m = new Map();\nexport function register${n}(id, x) { m.set(id, x); }\nexport function remove${n}(id) { m.delete(id); }\n`;
/** Accumulates, has a teardown-shaped API, and no remover for the register → a real miss. */
const miss = (n: string): string =>
  `const m = new Map();\nexport function register${n}(id, x) { m.set(id, x); }\nexport function clearAll() { m.clear(); }\n`;

function pairsAndMisses(r: IRegistryLifecycleReport): string[] {
  return [
    ...r.matchedPairs.map((p) => `pair:${p.file}:${p.registerName}`),
    ...r.missingRemovers.map((m) => `miss:${m.file}:${m.registerName}`),
  ].sort();
}

describe('§1.2#3 — a capped scan is not a pass, and --offset reaches the remainder', () => {
  const files = { 'src/a.ts': pair('A'), 'src/b.ts': pair('B'), 'src/c.ts': pair('C'), 'src/d.ts': pair('D'), 'src/e.ts': miss('E') };

  test('limit 3 of 5: truncated, nextOffset 3, not-verified naming the continuation', () => {
    const root = repo(files);
    const r = buildRegistryLifecycleReport({ projectRoot: root, limit: 3 });
    expect(r.truncated).toBe(true);
    expect(r.nextOffset).toBe(3);
    expect(r.missingRemovers).toEqual([]);
    expect(r.coverage.capped).toBe(true);
    expect(r.verdict).toBe('not-verified');
    expect(r.verdictReason).toContain('--offset 3');
    expect(renderRegistryLifecycleReportText(r, { command: 'shrk check registry-lifecycle' })).toContain(
      'Continue: shrk check registry-lifecycle --offset 3',
    );
  });

  test('--offset 3 finds the missing remover in the 5th (sorted) file → fail', () => {
    const root = repo(files);
    const r = buildRegistryLifecycleReport({ projectRoot: root, limit: 3, offset: 3 });
    expect(r.offset).toBe(3);
    expect(r.nextOffset).toBeUndefined();
    expect(r.missingRemovers.map((m) => m.file)).toEqual(['src/e.ts']);
    expect(r.verdict).toBe('fail');
  });

  test('property: a truncated report with no missing remover is never a pass', () => {
    const root = repo(files);
    for (let limit = 1; limit <= 6; limit += 1) {
      for (let offset = 0; offset <= 5; offset += 1) {
        const r = buildRegistryLifecycleReport({ projectRoot: root, limit, offset });
        if (r.truncated && r.missingRemovers.length === 0) {
          expect({ limit, offset, verdict: registryLifecycleVerdict(r).verdict }).not.toEqual({
            limit,
            offset,
            verdict: 'pass',
          });
        }
      }
    }
  });

  test('pagination is complete and independent of creation order', () => {
    // Created in REVERSE order: readdir order is not the continuation order.
    const reversed: Record<string, string> = {};
    for (const k of Object.keys(files).reverse()) reversed[k] = files[k as keyof typeof files];
    const root = repo(reversed);
    const whole = buildRegistryLifecycleReport({ projectRoot: root, limit: 0 });
    expect(whole.truncated).toBe(false);
    for (const k of [1, 2, 3]) {
      const seen: string[] = [];
      let offset: number | undefined = 0;
      while (offset !== undefined) {
        const page: IRegistryLifecycleReport = buildRegistryLifecycleReport({ projectRoot: root, limit: k, offset });
        seen.push(...pairsAndMisses(page));
        offset = page.nextOffset;
      }
      expect({ k, seen: seen.sort() }).toEqual({ k, seen: pairsAndMisses(whole) });
    }
  });

  test('limit 0 is uncapped; a complete clean scan is a pass', () => {
    const root = repo({ 'src/a.ts': pair('A'), 'src/b.ts': pair('B') });
    const r = buildRegistryLifecycleReport({ projectRoot: root, limit: 0 });
    expect(r.limit).toBe(0);
    expect(r.coverage).toMatchObject({ unit: 'files', expected: 2, examined: 2 });
    expect(r.verdict).toBe('pass');
  });
});

describe('§6.1(b) — linear per-file work on blanked buffers', () => {
  const doc = (lines: number): string =>
    '/**\n' + ' * lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor\n'.repeat(lines) + ' */\n';

  test('a 35 KB file with a 400-line doc comment scans in < 500 ms (8.3 s before)', () => {
    const body = `${doc(400)}const m = new Map();\nexport function registerX(id, x) { m.set(id, x); }\nexport function clearAll() { m.clear(); }\n`;
    expect(body.length).toBeGreaterThan(30_000);
    const root = repo({ 'src/big.ts': body });
    const started = performance.now();
    const r = buildRegistryLifecycleReport({ projectRoot: root });
    expect(performance.now() - started).toBeLessThan(500);
    expect(r.registersFound).toBe(1);
    expect(r.missingRemovers.map((m) => m.registerName)).toEqual(['registerX']);
  });

  test('12 registers each after a 50-line JSDoc (16 s before) finish in < 2 s with every pair matched', () => {
    let body = 'const handlers = new Map();\nexport function clearAll() { handlers.clear(); }\n';
    for (let i = 0; i < 12; i += 1) {
      body += `${doc(50)}export function registerFoo${i}(id, h) { handlers.set(id, h); }\n`;
      body += `${doc(50)}export function removeFoo${i}(id) { handlers.delete(id); }\n`;
    }
    const root = repo({ 'src/many.ts': body });
    const started = performance.now();
    const r = buildRegistryLifecycleReport({ projectRoot: root });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(r.registersFound).toBe(12);
    expect(r.matchedPairs.length).toBe(12);
    expect(r.missingRemovers).toEqual([]);
  });

  test('a class method after a JSDoc reports its OWN line for register and remover', () => {
    const body = [
      'const handlers = new Map();', // 1
      'export class Reg {', // 2
      '  /**', // 3
      '   * Registers a foo.', // 4
      '   * More doc.', // 5
      '   */', // 6
      '  registerFoo(id: string): void { handlers.set(id, 1); }', // 7
      '  /**', // 8
      '   * Removes a foo.', // 9
      '   * More.', // 10
      '   * More.', // 11
      '   */', // 12
      '  removeFoo(id: string): void { handlers.delete(id); }', // 13
      '}', // 14
      '',
    ].join('\n');
    const root = repo({ 'src/reg.ts': body });
    const r = buildRegistryLifecycleReport({ projectRoot: root });
    expect(r.matchedPairs).toEqual([
      { registerName: 'registerFoo', removerName: 'removeFoo', file: 'src/reg.ts', registerLine: 7, removerLine: 13 },
    ]);
  });

  test('every pattern the scan runs on a blanked buffer is lint-clean and fast on a 64 KiB blank run', () => {
    const line = ' '.repeat(79) + '\n';
    const buffer = `const a = 1;\n${line.repeat(820)}export function registerZ() {}\n`;
    const patterns = [
      ...REGISTRY_LIFECYCLE_PATTERNS.register,
      REGISTRY_LIFECYCLE_PATTERNS.accumulation,
      REGISTRY_LIFECYCLE_PATTERNS.teardown,
      REGISTRY_LIFECYCLE_PATTERNS.callableSite,
    ];
    for (const re of patterns) {
      expect({ re: re.source, hazards: findBlankRunHazards(re.source) }).toEqual({ re: re.source, hazards: [] });
      const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
      const started = performance.now();
      let m: RegExpExecArray | null;
      while ((m = g.exec(buffer)) !== null) if (m.index === g.lastIndex) g.lastIndex += 1;
      expect({ re: re.source, fast: performance.now() - started < 250 }).toEqual({ re: re.source, fast: true });
    }
  });
});

describe('§6.2 — the budget is checked inside a file, and an overshoot is named', () => {
  /** A clock that advances 10 s at every checkpoint of ONE kind — deterministic, no wall-clock race. */
  function clockAdvancingAt(kind: RegistryLifecycleCheckpoint, times = Infinity): (cp: RegistryLifecycleCheckpoint) => number {
    let t = 0;
    let left = times;
    return (cp) => {
      if (cp === kind && left > 0) {
        left -= 1;
        t += 10_000;
      }
      return t;
    };
  }

  test('an overshoot inside the last (only) file sets timedOut and names it — never a complete in-budget scan', () => {
    const root = repo({ 'src/a.ts': pair('A') });
    const r = buildRegistryLifecycleReport({ projectRoot: root, budgetMs: 1_000, now: clockAdvancingAt('register') });
    expect(r.timedOut).toBe(true);
    expect(r.overBudgetFiles).toEqual([
      { file: 'src/a.ts', phase: 'removers', deadline: 'run', elapsedMs: 10_000, registersSeen: 1 },
    ]);
    expect(r.matchedPairs).toEqual([]);
    expect(r.nextOffset).toBe(0);
    expect(r.verdict).toBe('not-verified');
  });

  test('a file over its per-file sub-budget is skipped whole; the next file is still judged', () => {
    const root = repo({ 'src/a.ts': pair('A'), 'src/b.ts': pair('B') });
    const r = buildRegistryLifecycleReport({
      projectRoot: root,
      budgetMs: 1e9,
      perFileBudgetMs: 1_000,
      now: clockAdvancingAt('register', 1),
    });
    expect(r.timedOut).toBe(false);
    expect(r.overBudgetFiles.map((o) => [o.file, o.phase, o.deadline])).toEqual([['src/a.ts', 'removers', 'file']]);
    // a.ts contributes NOTHING partial; b.ts is judged.
    expect(r.matchedPairs.map((p) => p.file)).toEqual(['src/b.ts']);
    expect(r.coverage).toMatchObject({ expected: 2, examined: 1 });
    expect(r.verdict).toBe('not-verified');
    expect(r.verdictReason).toContain('per-file budget');
    expect(renderRegistryLifecycleReportText(r)).toContain('! over budget     src/a.ts');
  });

  test('a pre-aborted signal yields an interrupted partial report at offset 0', async () => {
    const root = repo({ 'src/a.ts': pair('A'), 'src/b.ts': pair('B') });
    const controller = new AbortController();
    controller.abort();
    const r = await runRegistryLifecycleScan({ projectRoot: root }, { signal: controller.signal });
    expect(r.interrupted).toBe(true);
    expect(r.filesScanned).toBe(0);
    expect(r.nextOffset).toBe(0);
    expect(r.verdict).toBe('not-verified');
  });

  test('aborting after the first step continues from offset 1', async () => {
    const root = repo({ 'src/a.ts': pair('A'), 'src/b.ts': pair('B') });
    const controller = new AbortController();
    const pending = runRegistryLifecycleScan({ projectRoot: root }, { signal: controller.signal });
    controller.abort(); // the first step already ran synchronously
    const r = await pending;
    expect(r.interrupted).toBe(true);
    expect(r.filesScanned).toBe(1);
    expect(r.nextOffset).toBe(1);
  });

  test('one step() authority: the sync and async wrappers produce identical reports', async () => {
    const root = repo({ 'src/a.ts': pair('A'), 'src/b.ts': miss('B'), 'src/c.d.ts': 'export declare const x: 1;\n' });
    const sync = buildRegistryLifecycleReport({ projectRoot: root });
    const async = await runRegistryLifecycleScan({ projectRoot: root });
    expect(async).toEqual(sync);
    // The scan and the stepper agree too.
    const scan = createRegistryLifecycleScan({ projectRoot: root });
    while (scan.step()) {
      // drive it
    }
    expect(scan.snapshot()).toEqual(sync);
    expect(sync.excludedFiles.generated).toBe(1);
  });
});

describe('§6.4(b) — skipDirsAdd extends; a replacing skipDirs is reported', () => {
  const tree = {
    'node_modules/somedep/index.ts': miss('Dep'),
    'dist/out.ts': miss('Dist'),
    'examples/demo/ex.ts': miss('Ex'),
    'scripts/s.ts': miss('Script'),
    'myexclude/x.ts': miss('Mine'),
    'src/ok.ts': pair('Ok'),
  };

  test('skipDirsAdd: [myexclude] scans only src — no vendor/build false positives', () => {
    const root = repo(tree);
    const r = buildRegistryLifecycleReport({ projectRoot: root, skipDirsAdd: ['myexclude'] });
    expect(r.filesScanned).toBe(1);
    expect(r.missingRemovers).toEqual([]);
    expect(r.droppedDefaultSkipDirs).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  test('back-compat: skipDirs [myexclude] still replaces — and says what it dropped', () => {
    const root = repo(tree);
    const r = buildRegistryLifecycleReport({ projectRoot: root, skipDirs: ['myexclude'] });
    expect(r.missingRemovers.map((m) => m.file).sort()).toEqual([
      'dist/out.ts',
      'examples/demo/ex.ts',
      'node_modules/somedep/index.ts',
      'scripts/s.ts',
    ]);
    expect(r.droppedDefaultSkipDirs).toContain('node_modules');
    expect(r.droppedDefaultSkipDirs).toContain('dist');
    expect(renderRegistryLifecycleReportText(r)).toContain('skipDirsAdd');
  });

  test('property: skipDirsAdd never drops a default', () => {
    for (const add of [[], ['x'], ['node_modules'], ['a', 'b', 'dist'], ['tools', '.cache']]) {
      const { effective, droppedDefaults } = resolveRegistryLifecycleSkipDirs({ skipDirsAdd: add });
      for (const d of DEFAULT_REGISTRY_LIFECYCLE_SKIP_DIRS) expect(effective).toContain(d);
      for (const a of add) expect(effective).toContain(a);
      expect(droppedDefaults).toEqual([]);
    }
  });

  function project(registryLifecycle: Record<string, unknown>): string {
    return repo({
      'package.json': JSON.stringify({ name: 'r75-skip', version: '0.0.0' }),
      'sharkcraft/sharkcraft.config.ts': `export default ${JSON.stringify({ projectName: 'r75-skip', registryLifecycle })};\n`,
    });
  }

  test('shrk doctor warns about a replacing skipDirs that drops node_modules, and not about skipDirsAdd', async () => {
    const replacing = await inspectSharkcraft({ cwd: project({ skipDirs: ['myexclude'] }) });
    expect(replacing.configLoadError).toBeUndefined();
    const warn = runDoctor(replacing).checks.find((c) => c.id === 'registry-lifecycle-skip-dirs');
    expect(String(warn?.severity)).toBe('warning');
    expect(warn?.message).toContain('node_modules');
    expect(warn?.message).toContain('skipDirsAdd');

    const additive = await inspectSharkcraft({ cwd: project({ skipDirsAdd: ['myexclude'] }) });
    expect(additive.configLoadError).toBeUndefined();
    expect(additive.config?.registryLifecycle?.skipDirsAdd).toEqual(['myexclude']);
    expect(runDoctor(additive).checks.find((c) => c.id === 'registry-lifecycle-skip-dirs')).toBeUndefined();
  });

  test('the strict config schema rejects a non-string skipDirsAdd entry (the whole config is refused, loudly)', async () => {
    const bad = await inspectSharkcraft({ cwd: project({ skipDirsAdd: [42] }) });
    expect(bad.configLoadError).toBeDefined();
    expect(bad.configLoadError?.issues.join(' ')).toContain('skipDirsAdd');
  });
});
