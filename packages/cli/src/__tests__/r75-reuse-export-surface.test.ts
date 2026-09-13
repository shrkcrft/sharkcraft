/**
 * Round 11 §2.4 — `shrk reuse` falls back to the real public export surface,
 * and says which field a match came from.
 *
 * The defect: `reuse "date range picker"` answered `Popover` — a generic
 * primitive whose description recommends it as a substitute — at "100% of
 * intent", while the exactly-named `DateRangePicker` sat on the public surface
 * of the same package, absent from the results even with the graph indexed.
 *
 * Fixtures are real workspaces with a real sharkcraft.config.ts, indexed by the
 * real `buildFullIndex`, run through the real command handler.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildFullIndex } from '@shrkcrft/graph';
import { reuseCommand } from '../commands/reuse.command.ts';
import { ExitCode } from '../exit-codes.ts';
import type { ParsedArgs } from '../command-registry.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const POPOVER_FIELDS =
  "symbol: 'Popover', roles: ['overlay', 'popup', 'anchored panel'], importPath: '@demo/ui', " +
  "keywords: ['picker', 'dropdown', 'date', 'range', 'menu'], " +
  "description: 'Generic anchored overlay - build any picker (e.g. a date range picker) on top of it.'";
const POPOVER = `{ ${POPOVER_FIELDS} }`;

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
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-reuse-'));
  roots.push(root);
  for (const [rel, body] of Object.entries({ ...BASE, ...(o.files ?? {}) })) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    `export default { reusePrimitives: [${o.primitives ?? POPOVER}] };\n`,
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

async function run(a: ParsedArgs): Promise<{ code: number; out: string; err: string }> {
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
    return { code: await reuseCommand.run(a), out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

async function json(root: string, intent: string, flags: Record<string, string | boolean> = {}) {
  const r = await run(args(root, intent.split(' '), { ...flags, json: true }));
  expect(r.code).toBe(0);
  return JSON.parse(r.out);
}

describe('the export-surface fallback', () => {
  test('"date range picker" → the exactly-named export first, labelled uncurated; Popover below it', async () => {
    const root = fixture();
    const out = await json(root, 'date range picker');
    expect(out.exportSurface.status).toBe('searched');
    expect(out.exportSurface.roots).toBe(2);
    const top = out.results[0];
    expect(top.symbol).toBe('DateRangePicker');
    expect(top.source).toBe('export-surface');
    expect(top.nameMatch).toBe('exact');
    expect(top.package).toBe('@demo/ui');
    expect(top.importLine).toBe("import { DateRangePicker } from '@demo/ui';");
    expect(top.declaredIn).toBe('packages/ui/src/pickers/date-range-picker.ts');
    expect(top.via).toEqual(['packages/ui/src/index.ts', 'packages/ui/src/pickers/index.ts']);
    const popIdx = out.results.findIndex((r: { symbol: string }) => r.symbol === 'Popover');
    expect(popIdx).toBeGreaterThan(0);
    expect(out.results[popIdx].matchedVia).not.toContain('symbol');
    expect(out.curationGap).toBe(true);
    // The shared confidence vocabulary.
    expect(out.confident).toBe(true);
    expect(out.verdict).toBe('confident');
    expect(typeof out.floor).toBe('number');
    expect(out.bestScore).toBeGreaterThan(0);
  });

  test('"date picker" ranks DateRangePicker first (its name covers the intent)', async () => {
    const out = await json(fixture(), 'date picker');
    expect(out.results[0].symbol).toBe('DateRangePicker');
    expect(out.results[0].nameMatch).toBe('covers');
  });

  test('the identifier typed as the intent is an exact match', async () => {
    const out = await json(fixture(), 'DateRangePicker');
    expect(out.results[0].symbol).toBe('DateRangePicker');
    expect(out.results[0].nameMatch).toBe('exact');
  });

  test('--curated-only is the pre-round ranking, and still says where the match came from', async () => {
    const out = await json(fixture(), 'date range picker', { 'curated-only': true });
    expect(out.exportSurface.status).toBe('disabled');
    expect(out.results.map((r: { symbol: string }) => r.symbol)).toEqual(['Popover']);
    expect(out.results[0].source).toBe('curated');
    expect(out.results[0].nameMatch).toBe('none');
    expect(out.curationGap).toBe(false);
  });

  test('a curated entry that NAMES the construct still outranks an uncurated exact match', async () => {
    const root = fixture({
      primitives: "{ symbol: 'AppButton', roles: ['button', 'clickable control'], importPath: '@demo/ui' }",
      files: {
        'packages/ui/src/index.ts': "export * from './app-button';\nexport * from './button';\n",
        'packages/ui/src/app-button.ts': 'export class AppButton {}\n',
        'packages/ui/src/button.ts': 'export class Button {}\n',
      },
    });
    const out = await json(root, 'button');
    expect(out.results.map((r: { symbol: string }) => r.symbol)).toEqual(['AppButton', 'Button']);
    expect(out.results[0].source).toBe('curated');
    expect(out.results[0].matchedVia).toContain('symbol');
    expect(out.results[0].nameMatch).toBe('covers');
    expect(out.results[1].source).toBe('export-surface');
    expect(out.results[1].nameMatch).toBe('exact');
  });

  test('`supersedes` suppresses the export and lists it', async () => {
    const root = fixture({ primitives: `{ ${POPOVER_FIELDS}, supersedes: ['DateRangePicker'] }` });
    const out = await json(root, 'date range picker');
    expect(out.results.map((r: { symbol: string }) => r.symbol)).not.toContain('DateRangePicker');
    expect(out.superseded).toEqual([{ symbol: 'DateRangePicker', package: '@demo/ui', supersededBy: ['Popover'] }]);
  });

  test('no graph index → the surface is NOT searched, said out loud', async () => {
    const root = fixture({ index: false });
    const out = await json(root, 'date range picker');
    expect(out.exportSurface.status).toBe('not-searched');
    expect(out.results[0].symbol).toBe('Popover');
    const text = await run(args(root, ['date', 'range', 'picker']));
    expect(text.out).toContain('uncurated export surface NOT searched (no graph index)');
  });

  test('no reusePrimitives, with a graph → labelled uncurated answers instead of an early return', async () => {
    const root = fixture({ primitives: '' });
    const out = await json(root, 'date range picker');
    expect(out.results[0].symbol).toBe('DateRangePicker');
    expect(out.results[0].source).toBe('export-surface');
    const text = await run(args(root, ['date', 'range', 'picker']));
    expect(text.code).toBe(0);
    expect(text.out).toContain('DateRangePicker  [uncurated · exported by @demo/ui · exact name match]');
    expect(text.out).toContain("import { DateRangePicker } from '@demo/ui';");
  });

  test("'ran' no longer matches DateRangePicker by name (token equality)", async () => {
    const out = await json(fixture(), 'ran');
    // A confident answer carries no `suggestions` key (the pre-round shape).
    const all = [...out.results, ...(out.suggestions ?? [])].map((r: { symbol: string }) => r.symbol);
    expect(all).not.toContain('DateRangePicker');
    // Popover still matches — through its keywords, and says so.
    expect(out.results[0].symbol).toBe('Popover');
    expect(out.results[0].nameMatch).toBe('none');
  });
});

describe('a metadata-only curated match is labelled as one', () => {
  test('Popover for "date range picker": matched via keyword/description, not its name', async () => {
    const out = await json(fixture(), 'date range picker', { 'curated-only': true });
    const pop = out.results[0];
    expect(pop.symbol).toBe('Popover');
    for (const v of pop.matchedVia) expect(['keyword', 'description']).toContain(v);
    expect(pop.matchedVia).not.toContain('symbol');
    expect(pop.nameMatch).toBe('none');
    // The numeric confidence keeps its meaning (back-compat).
    expect(pop.confidence).toBe(1);
  });

  test('the text row carries the "not its name" qualifier; the gap footer points at coverage', async () => {
    const text = await run(args(fixture(), ['date', 'range', 'picker']));
    const popRow = text.out.split('\n').find((l) => l.includes('100% of intent — via keywords, description'));
    expect(popRow).toContain('not its name');
    expect(text.out).toContain('Curation gap');
    expect(text.out).toContain('shrk reuse coverage');
  });
});

describe('exportSurface.status never reads "searched" over what was not walked (review #6)', () => {
  const DIST = (name: string): string => JSON.stringify({ name, version: '0.0.0', main: 'dist/index.js' });

  test('0 package roots walked → not-searched, with the reason; never "searched" over nothing', async () => {
    const root = fixture({
      files: {
        'packages/ui/package.json': DIST('@demo/ui'),
        'packages/ui/dist/index.js': 'module.exports = {};\n',
        'packages/app/package.json': DIST('@demo/app'),
        'packages/app/dist/index.js': 'module.exports = {};\n',
      },
    });
    const out = await json(root, 'date range picker');
    expect(out.exportSurface).toMatchObject({
      status: 'not-searched',
      reason: 'no package entry resolves to an indexed file',
      roots: 0,
      size: 0,
    });
    expect(out.exportSurface.packagesWithoutEntry.map((p: { package: string }) => p.package)).toEqual([
      '@demo/app',
      '@demo/ui',
    ]);
    const text = await run(args(root, ['date', 'range', 'picker']));
    expect(text.out).toContain('uncurated export surface NOT searched (no package entry resolves to an indexed file)');
  });

  test('some roots walked, some not → partial, with how many', async () => {
    const root = fixture({
      files: { 'packages/app/package.json': DIST('@demo/app'), 'packages/app/dist/index.js': 'module.exports = {};\n' },
    });
    const out = await json(root, 'date range picker');
    expect(out.exportSurface.status).toBe('partial');
    expect(out.exportSurface.reason).toContain('1 of 2 package(s) have no resolved entry');
    expect(out.exportSurface.roots).toBe(1);
    expect(out.results[0].symbol).toBe('DateRangePicker');
  });

  test('no workspace packages at all → not-searched, said as such', async () => {
    const root = fixture({ files: { 'package.json': JSON.stringify({ name: 'solo', version: '0.0.0' }) } });
    const out = await json(root, 'date range picker');
    expect(out.exportSurface).toMatchObject({ status: 'not-searched', reason: 'no workspace packages (package.json `workspaces`)' });
  });
});

describe('usage', () => {
  test('an empty intent is a usage error (3)', async () => {
    const r = await run(args(fixture({ index: false }), []));
    expect(r.code).toBe(ExitCode.UsageError);
  });
});
