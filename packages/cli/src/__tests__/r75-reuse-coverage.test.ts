/**
 * Round 11 §2.4 — `shrk reuse coverage`: curated reusePrimitives[] against the
 * real public export surface, so curation drift is a number, not a silence.
 *
 * Locks: the counts on the §2.4 fixture, dead entries and importPath
 * mismatches fail (1), a missing or stale index is NOT VERIFIED (2) and prints
 * no percentage, usage errors are 3, `gate.exit` is the process exit, and —
 * one authority — the curation gaps are exactly what the lookup itself answers.
 *
 * Fixtures are real workspaces with a real sharkcraft.config.ts, indexed by the
 * real `buildFullIndex`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildFullIndex, detectGraphFreshness, GraphQueryApi } from '@shrkcrft/graph';
import { buildCodeIntelligenceChecks, splitIdentifierTokens } from '@shrkcrft/inspector';
import { graphCommand } from '../commands/graph.command.ts';
import { reuseCoverageCommand } from '../commands/reuse-coverage.command.ts';
import { reuseCommand } from '../commands/reuse.command.ts';
import { ExitCode } from '../exit-codes.ts';
import type { ParsedArgs } from '../command-registry.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const POPOVER_FIELDS =
  "symbol: 'Popover', roles: ['overlay', 'popup', 'anchored panel'], " +
  "keywords: ['picker', 'dropdown', 'date', 'range', 'menu'], " +
  "description: 'Generic anchored overlay - build any picker (e.g. a date range picker) on top of it.'";
const popover = (extra = "importPath: '@demo/ui'"): string => `{ ${POPOVER_FIELDS}${extra ? `, ${extra}` : ''} }`;

const BASE: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'demo-root', version: '0.0.0', private: true, workspaces: ['packages/*'] }),
  'packages/ui/package.json': JSON.stringify({ name: '@demo/ui', version: '0.0.0', main: 'src/index.ts' }),
  'packages/app/package.json': JSON.stringify({
    name: '@demo/app',
    version: '0.0.0',
    main: 'src/index.ts',
    dependencies: { '@demo/ui': '*' },
  }),
  'packages/ui/src/index.ts': "export * from './pickers';\nexport * from './overlay/popover';\n",
  'packages/ui/src/unexported-deep.ts': 'export class DeepRangeSlider {}\n',
  'packages/app/src/index.ts': "import { Popover } from '@demo/ui';\nexport function makeThing() { return new Popover(); }\n",
  'packages/ui/src/pickers/date-range-picker.ts':
    'export class DateRangePicker {\n  open(): void {}\n}\nexport interface IDateRangePickerOptions { min?: Date; max?: Date }\n',
  'packages/ui/src/pickers/format.ts':
    'export function formatDateRange(a: Date, b: Date): string { return `${a.toISOString()}..${b.toISOString()}`; }\nexport function internalOnlyHelper(): number { return 1; }\n',
  'packages/ui/src/pickers/index.ts': "export * from './date-range-picker';\nexport { formatDateRange } from './format';\n",
  'packages/ui/src/overlay/popover.ts': 'export class Popover {\n  show(): void {}\n}\n',
};

function fixture(o: { primitives?: string; files?: Record<string, string>; index?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-reusecov-'));
  roots.push(root);
  for (const [rel, body] of Object.entries({ ...BASE, ...(o.files ?? {}) })) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    `export default { reusePrimitives: [${o.primitives ?? popover()}] };\n`,
  );
  if (o.index !== false) buildFullIndex({ projectRoot: root });
  return root;
}

function args(root: string, positional: string[], flags: Record<string, string | boolean> = {}): ParsedArgs {
  return {
    positional,
    flags: new Map<string, string | boolean>([['cwd', root], ...Object.entries(flags)]),
    multiFlags: new Map(),
  };
}

async function run(
  h: { run(a: ParsedArgs): Promise<number> | number },
  a: ParsedArgs,
): Promise<{ code: number; out: string; err: string }> {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = '';
  let err = '';
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    out += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array): boolean => {
    err += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await h.run(a), out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

/** Run `reuse coverage --json` and assert the envelope's exit IS the process exit. */
async function coverage(root: string, flags: Record<string, string | boolean> = {}) {
  const r = await run(reuseCoverageCommand, args(root, [], { ...flags, json: true }));
  const out = JSON.parse(r.out);
  expect(out.gate.exit).toBe(r.code);
  expect(out.exitCode).toBe(r.code);
  expect(out.gate.verb).toBe('reuse coverage');
  return { code: r.code, out };
}

describe('the numbers on the §2.4 fixture', () => {
  test('curated 1 · public 5 (value 4) · 1/4 value, exit 0', async () => {
    const { code, out } = await coverage(fixture());
    expect(code).toBe(ExitCode.VerifiedPass);
    expect(out.schema).toBe('sharkcraft.reuse-coverage/v1');
    expect(out.curated.length).toBe(1);
    expect(out.curated[0]).toMatchObject({ symbol: 'Popover', status: 'public', importPathAgrees: true });
    expect(out.surface.all).toBe(5);
    expect(out.surface.value).toBe(4);
    expect(out.curatedPublicValue).toBe(1);
    expect(out.ratioValue).toBe(0.25);
    expect(out.surface.packagesWithoutEntry).toEqual([]);
    for (const rule of out.gate.rules) expect(rule.type).toBe('reuse');
    const text = await run(reuseCoverageCommand, args(fixture(), []));
    expect(text.out).toContain('curated 1 · public exports 5 (value 4) · coverage 1/4 value (25%) · 0 package(s) without a resolved entry');
  });

  test('curation gaps: the exported names the lookup answers with Popover; makeThing is not one', async () => {
    const root = fixture();
    const { out } = await coverage(root);
    expect(out.shadowed.map((s: { export: string; answeredBy: string }) => `${s.export}→${s.answeredBy}`)).toEqual([
      'DateRangePicker→Popover',
      'formatDateRange→Popover',
    ]);
    const withTypes = await coverage(root, { 'include-types': true });
    expect(withTypes.out.shadowed.map((s: { export: string }) => s.export)).toEqual([
      'DateRangePicker',
      'IDateRangePickerOptions',
      'formatDateRange',
    ]);
    expect(withTypes.out.shadowed.map((s: { export: string }) => s.export)).not.toContain('makeThing');
  });

  test('--strict turns a curation gap into a failure (1)', async () => {
    const { code, out } = await coverage(fixture(), { strict: true });
    expect(code).toBe(ExitCode.Failure);
    expect(out.gate.rules.find((r: { id: string }) => r.id === 'Popover').severity).toBe('error');
  });
});

describe('what fails (1)', () => {
  test('a curated symbol declared nowhere is a dead entry', async () => {
    const { code, out } = await coverage(
      fixture({ primitives: "{ symbol: 'Popovr', roles: ['overlay'], importPath: '@demo/ui' }" }),
    );
    expect(code).toBe(ExitCode.Failure);
    expect(out.curated[0].status).toBe('not-found');
    expect(out.gate.rules[0].status).toBe('failed');
  });

  test('an importPath whose package surface lacks the symbol (the printed import would not compile)', async () => {
    const { code, out } = await coverage(fixture({ primitives: popover("importPath: '@demo/app'") }));
    expect(code).toBe(ExitCode.Failure);
    expect(out.curated[0].importPathAgrees).toBe(false);
    expect(out.curated[0].publicIn).toEqual(['@demo/ui']);
  });

  test('--min-coverage unmet → 1; met → 0; not a number → 3', async () => {
    const root = fixture();
    expect((await coverage(root, { 'min-coverage': '50' })).code).toBe(ExitCode.Failure);
    expect((await coverage(root, { 'min-coverage': '20' })).code).toBe(ExitCode.VerifiedPass);
    const bad = await run(reuseCoverageCommand, args(root, [], { 'min-coverage': 'lots' }));
    expect(bad.code).toBe(ExitCode.UsageError);
  });
});

describe('what is NOT VERIFIED (2)', () => {
  test('no graph index', async () => {
    const root = fixture({ index: false });
    const { code, out } = await coverage(root);
    expect(code).toBe(ExitCode.NotVerified);
    expect(out.measured).toBe(false);
    const text = await run(reuseCoverageCommand, args(root, []));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(text.out).toContain('NOT VERIFIED');
  });

  test('a stale index: every number NOT VERIFIED, no percentage printed', async () => {
    const root = fixture();
    writeFileSync(join(root, 'packages/ui/src/overlay/popover.ts'), 'export class Popover {\n  hide(): void {}\n}\n');
    const { code, out } = await coverage(root);
    expect(code).toBe(ExitCode.NotVerified);
    expect(out.ratioValue).toBeUndefined();
    const text = await run(reuseCoverageCommand, args(root, []));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(text.out).toContain('NOT VERIFIED');
    expect(text.out).not.toContain('%');
  });

  test('a package with no resolvable entry is listed, and the verdict is partial', async () => {
    const root = fixture({
      files: {
        'packages/noentry/package.json': JSON.stringify({ name: '@demo/noentry', version: '0.0.0', main: 'dist/index.js' }),
        'packages/noentry/lib/x.ts': 'export const X = 1;\n',
      },
    });
    const { code, out } = await coverage(root);
    expect(code).toBe(ExitCode.NotVerified);
    expect(out.surface.packagesWithoutEntry.map((p: { package: string }) => p.package)).toEqual(['@demo/noentry']);
    expect(out.gate.shortfalls.join(' ')).toContain('@demo/noentry');
    // Deliberate narrowing is not a shortfall.
    const narrowed = await coverage(root, { package: '@demo/ui,@demo/app' });
    expect(narrowed.code).toBe(ExitCode.VerifiedPass);
  });

  test('nothing to measure (no curated entry, no public export) → 2; --allow-empty → 0', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-r75-reusecov-empty-'));
    roots.push(root);
    mkdirSync(join(root, 'sharkcraft'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'empty', version: '0.0.0' }));
    writeFileSync(join(root, 'sharkcraft', 'sharkcraft.config.ts'), 'export default {};\n');
    buildFullIndex({ projectRoot: root });
    expect((await coverage(root)).code).toBe(ExitCode.NotVerified);
    expect((await coverage(root, { 'allow-empty': true })).code).toBe(ExitCode.VerifiedPass);
  });
});

describe('usage (3) and routing', () => {
  test('a stray positional or an unknown flag', async () => {
    const root = fixture({ index: false });
    expect((await run(reuseCoverageCommand, args(root, ['extra']))).code).toBe(ExitCode.UsageError);
    expect((await run(reuseCoverageCommand, args(root, [], { 'no-such-flag': true }))).code).toBe(ExitCode.UsageError);
    expect((await run(reuseCoverageCommand, args(root, [], { package: '@demo/nope' }))).code).toBe(
      ExitCode.UsageError,
    );
  });

  test('from source: `reuse coverage` routes to the verb, `reuse coverage extra` is 3, other intents still reach reuse', () => {
    const root = fixture();
    const main = resolve(import.meta.dir, '../main.ts');
    const cov = spawnSync('bun', [main, 'reuse', 'coverage', '--json', '--cwd', root], { encoding: 'utf8' });
    expect(cov.status).toBe(0);
    expect(JSON.parse(cov.stdout).schema).toBe('sharkcraft.reuse-coverage/v1');
    const stray = spawnSync('bun', [main, 'reuse', 'coverage', 'extra', '--cwd', root], { encoding: 'utf8' });
    expect(stray.status).toBe(ExitCode.UsageError);
    const lookup = spawnSync('bun', [main, 'reuse', 'date', 'range', 'picker', '--json', '--cwd', root], {
      encoding: 'utf8',
    });
    expect(lookup.status).toBe(0);
    expect(JSON.parse(lookup.stdout).schema).toBe('sharkcraft.reuse/v1');
  }, 60_000);
});

/**
 * THE gap-parity property, run over every export coverage considered (`--all`):
 * `e ∈ shadowed` ⇔ `shrk reuse "<e's words>"` reports `curationGap` — and when
 * it does, `--curated-only` headlines exactly the `answeredBy` coverage names.
 */
async function gapParity(root: string): Promise<{ gaps: number; checked: number }> {
  const { out } = await coverage(root, { 'include-types': true, all: true });
  type Shadow = { export: string; package: string; answeredBy: string };
  const shadowed = new Map<string, Shadow>(out.shadowed.map((s: Shadow) => [`${s.package}#${s.export}`, s]));
  let gaps = 0;
  for (const u of out.uncovered as { name: string; package: string }[]) {
    const words = splitIdentifierTokens(u.name);
    const full = JSON.parse((await run(reuseCommand, args(root, words, { json: true, 'include-types': true }))).out);
    const s = shadowed.get(`${u.package}#${u.name}`);
    expect({ export: u.name, gap: full.curationGap === true }).toEqual({ export: u.name, gap: s !== undefined });
    if (s !== undefined) {
      gaps += 1;
      const curatedOnly = JSON.parse((await run(reuseCommand, args(root, words, { json: true, 'curated-only': true }))).out);
      expect(curatedOnly.results[0].symbol).toBe(s.answeredBy);
    }
  }
  return { gaps, checked: out.uncovered.length };
}

describe('one authority: coverage and the lookup cannot disagree', () => {
  test('PROPERTY: e ∈ shadowed ⇔ `reuse "<e’s words>"` reports curationGap (metadata-only curated answers)', async () => {
    const root = fixture({
      files: {
        'packages/ui/src/index.ts':
          "export * from './pickers';\nexport * from './overlay/popover';\nexport * from './menu';\n",
        'packages/ui/src/menu.ts':
          'export class DropdownMenu {}\nexport function rangeOf(): number { return 1; }\nexport const panelColor = 1;\n',
      },
    });
    const { gaps, checked } = await gapParity(root);
    expect(checked).toBeGreaterThanOrEqual(7);
    // The property is not vacuous: both sides occur.
    expect(gaps).toBeGreaterThan(0);
    expect(gaps).toBeLessThan(checked);
  });

  test('PROPERTY holds for a curated entry that names only PART of the intent (review #2)', async () => {
    const root = fixture({
      primitives: "{ symbol: 'RangeSlider', roles: ['slider'], importPath: '@demo/ui' }",
      files: {
        'packages/ui/src/index.ts':
          "export * from './pickers';\nexport * from './overlay/popover';\nexport * from './range-slider';\n",
        'packages/ui/src/range-slider.ts': 'export class RangeSlider {}\n',
      },
    });
    const { out } = await coverage(root);
    expect(out.shadowed.map((s: { export: string; answeredBy: string; nameMatch: string }) => `${s.export}->${s.answeredBy}(${s.nameMatch})`)).toEqual([
      'DateRangePicker->RangeSlider(partial)',
      'formatDateRange->RangeSlider(partial)',
    ]);
    const { gaps, checked } = await gapParity(root);
    expect(gaps).toBeGreaterThan(0);
    expect(gaps).toBeLessThan(checked);
  });
});

describe('a partial curated name never outranks the exact-named export (review #2)', () => {
  test('"date range picker": DateRangePicker first, RangeSlider below it, curationGap true', async () => {
    const root = fixture({
      primitives: "{ symbol: 'RangeSlider', roles: ['slider'], importPath: '@demo/ui' }",
      files: {
        'packages/ui/src/index.ts':
          "export * from './pickers';\nexport * from './overlay/popover';\nexport * from './range-slider';\n",
        'packages/ui/src/range-slider.ts': 'export class RangeSlider {}\n',
      },
    });
    const out = JSON.parse((await run(reuseCommand, args(root, ['date', 'range', 'picker'], { json: true }))).out);
    const rows = out.results.map((r: { symbol: string; nameMatch: string }) => `${r.symbol}:${r.nameMatch}`);
    expect(rows).toEqual(['DateRangePicker:exact', 'RangeSlider:partial']);
    expect(out.curationGap).toBe(true);
    // A curated entry whose name COVERS the intent still wins (tier 1).
    const covers = JSON.parse((await run(reuseCommand, args(root, ['range', 'slider'], { json: true }))).out);
    expect(covers.results[0]).toMatchObject({ symbol: 'RangeSlider', source: 'curated', nameMatch: 'exact' });
    expect(covers.curationGap).toBe(false);
  });
});

describe('freshness covers package entries (review #1)', () => {
  test('a package.json-only main edit is NOT VERIFIED (2) in both directions, and graph status + doctor agree', async () => {
    const root = fixture({ primitives: "{ symbol: 'Popover', roles: ['overlay'], importPath: '@demo/ui' }" });
    expect((await coverage(root)).code).toBe(ExitCode.VerifiedPass);
    const uiPkg = join(root, 'packages/ui/package.json');
    writeFileSync(uiPkg, JSON.stringify({ name: '@demo/ui', version: '0.0.0', main: 'src/pickers/index.ts' }));

    const stale = await coverage(root);
    expect(stale.code).toBe(ExitCode.NotVerified);
    expect(stale.out.measured).toBe(false);
    expect(stale.out.packagesChanged).toEqual(['@demo/ui']);
    expect(stale.out.gate.shortfalls.join(' ')).toContain('@demo/ui');
    const text = await run(reuseCoverageCommand, args(root, []));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(text.out).toContain('NOT VERIFIED');
    expect(text.out).not.toContain('%');

    // The one freshness authority: graph status and the doctor say stale too.
    const status = JSON.parse((await run(graphCommand, args(root, ['status'], { json: true }))).out);
    expect(status.state).toBe('stale');
    expect(status.packagesChanged).toEqual(['@demo/ui']);
    expect(status.nextCommand).toBe('shrk graph index');
    const check = buildCodeIntelligenceChecks(root, { graphDivergence: detectGraphFreshness(root) }).find(
      (c) => c.id === 'code-intelligence-graph',
    );
    expect(check?.message).toContain('STALE');
    expect(check?.message).toContain('@demo/ui');

    // Re-indexed: the real verdict — Popover is no longer on @demo/ui's surface.
    buildFullIndex({ projectRoot: root });
    const after = await coverage(root);
    expect(after.code).toBe(ExitCode.Failure);
    expect(after.out.curated[0].importPathAgrees).toBe(false);
    // The reverse edit without a re-index is NOT VERIFIED too — never a false 1.
    writeFileSync(uiPkg, JSON.stringify({ name: '@demo/ui', version: '0.0.0', main: 'src/index.ts' }));
    expect((await coverage(root)).code).toBe(ExitCode.NotVerified);
  });
});

describe('the exit-0 sentence is built from the report (review #3)', () => {
  test('an off-surface curated entry is listed and warned, with no ✓; --strict fails it', async () => {
    const root = fixture({ primitives: "{ symbol: 'internalOnlyHelper', roles: ['helper'] }" });
    const text = await run(reuseCoverageCommand, args(root, []));
    expect(text.code).toBe(ExitCode.VerifiedPass);
    expect(text.out).toContain('Curated entries not on the public surface (1)');
    expect(text.out).toContain('No blocking reuse coverage problems — 1 curated entry not on the public surface (listed above).');
    expect(text.out).not.toContain('✓');
    const { out } = await coverage(root);
    expect(out.verdict).toBe('warnings');
    expect(out.gate.rules[0]).toMatchObject({ status: 'failed', severity: 'warning' });
    expect((await coverage(root, { strict: true })).code).toBe(ExitCode.Failure);
  });

  test('no curated entries: a measured 0%, never a vacuous ✓', async () => {
    const text = await run(reuseCoverageCommand, args(fixture({ primitives: '' }), []));
    expect(text.code).toBe(ExitCode.VerifiedPass);
    expect(text.out).toContain('No curated reusePrimitives[] — 0 of 4 value export(s) curated.');
    expect(text.out).not.toContain('✓');
  });

  test('the ✓ is earned only when every curated entry is public and nothing is advisory', async () => {
    const text = await run(
      reuseCoverageCommand,
      args(fixture({ primitives: "{ symbol: 'Popover', roles: ['overlay'], importPath: '@demo/ui' }" }), []),
    );
    expect(text.code).toBe(ExitCode.VerifiedPass);
    expect(text.out).toContain('Every curated reuse entry resolves on the public surface. ✓');
  });
});

describe('one import-line authority (review #4)', () => {
  test('a curated DEFAULT export: coverage and the lookup print the same default import', async () => {
    const root = fixture({
      primitives: "{ symbol: 'createApp', roles: ['app factory'], importPath: '@demo/app' }",
      files: {
        'packages/app/src/index.ts':
          "import { Popover } from '@demo/ui';\nexport default function createApp() { return new Popover(); }\n",
      },
    });
    const { code, out } = await coverage(root);
    expect(code).toBe(ExitCode.VerifiedPass);
    const c = out.curated[0];
    expect(c).toMatchObject({
      symbol: 'createApp',
      status: 'public',
      importPathAgrees: true,
      importStyle: 'default',
      importLine: "import createApp from '@demo/app';",
    });
    const lookup = JSON.parse((await run(reuseCommand, args(root, ['create', 'app'], { json: true, 'curated-only': true }))).out);
    expect(lookup.results[0]).toMatchObject({ symbol: 'createApp', isDefault: true, importStyle: 'default' });
    expect(lookup.results[0].importLine).toBe(c.importLine);
    // A named export keeps the named import — from the same resolver.
    const named = await coverage(fixture());
    expect(named.out.curated[0]).toMatchObject({ importStyle: 'named', importLine: "import { Popover } from '@demo/ui';" });
  });
});

describe('the curated CONSTRUCT, not the curated name (review #5)', () => {
  test('a same-named export of a different construct stays visible to the lookup and to coverage', async () => {
    const root = fixture({
      primitives: "{ symbol: 'Button', roles: ['button'], importPath: '@demo/ui' }",
      files: {
        'packages/ui/src/index.ts': "export * from './pickers';\nexport * from './overlay/popover';\nexport * from './button';\n",
        'packages/ui/src/button.ts': 'export class Button {}\n',
        'packages/app/src/index.ts':
          "import { Popover } from '@demo/ui';\nexport function makeThing() { return new Popover(); }\nexport class Button { legacy = true; }\n",
      },
    });
    const lookup = JSON.parse((await run(reuseCommand, args(root, ['button'], { json: true }))).out);
    expect(lookup.results.map((r: { source: string; declaredIn: string }) => `${r.source}:${r.declaredIn}`)).toEqual([
      'curated:packages/ui/src/button.ts',
      'export-surface:packages/app/src/index.ts',
    ]);
    const { out } = await coverage(root);
    expect(out.curated[0].publicIn).toEqual(['@demo/ui']);
    const uncovered = out.uncovered.map((u: { name: string; package: string }) => `${u.package}#${u.name}`);
    expect(uncovered).toContain('@demo/app#Button');
    expect(uncovered).not.toContain('@demo/ui#Button');
  });
});

describe('unfollowed re-exports are counted, classified, never silent (review, low)', () => {
  const BARREL = "export * from './pickers';\nexport * from './overlay/popover';\n";

  test('a LOCAL re-export the index cannot follow leaves its package unexamined (2)', async () => {
    const root = fixture({ files: { 'packages/ui/src/index.ts': `${BARREL}export * from './gone';\n` } });
    const { code, out } = await coverage(root);
    expect(code).toBe(ExitCode.NotVerified);
    expect(out.surface.unfollowedReExports).toEqual([
      { package: '@demo/ui', file: 'packages/ui/src/index.ts', specifier: './gone', name: '*', kind: 'unresolved' },
    ]);
    expect(out.gate.shortfalls.join(' ')).toContain('@demo/ui');
    const text = await run(reuseCoverageCommand, args(root, []));
    expect(text.out).toContain('1 re-export(s) not followed');
    expect(text.out).toContain('NOT VERIFIED');
  });

  test('an EXTERNAL re-export is listed in text and JSON, not a shortfall', async () => {
    const root = fixture({ files: { 'packages/ui/src/index.ts': `${BARREL}export * from 'left-pad';\n` } });
    const { code, out } = await coverage(root);
    expect(code).toBe(ExitCode.VerifiedPass);
    expect(out.surface.unfollowedReExports.map((u: { kind: string }) => u.kind)).toEqual(['external']);
    const text = await run(reuseCoverageCommand, args(root, []));
    expect(text.out).toContain('1 re-export(s) not followed');
  });

  test('`export * as ns` is on the surface: the lookup answers the namespace with a named import', async () => {
    const root = fixture({
      primitives: '',
      files: { 'packages/ui/src/index.ts': `${BARREL}export * as dates from './pickers/format';\n` },
    });
    const out = JSON.parse((await run(reuseCommand, args(root, ['dates'], { json: true }))).out);
    expect(out.results[0]).toMatchObject({
      symbol: 'dates',
      source: 'export-surface',
      declaredIn: 'packages/ui/src/pickers/format.ts',
      importLine: "import { dates } from '@demo/ui';",
    });
  });
});
