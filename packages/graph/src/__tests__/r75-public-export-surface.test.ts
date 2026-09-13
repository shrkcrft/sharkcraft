/**
 * Round 11 §2.4 — the public export surface, enumerated from the snapshot.
 *
 * `shrk reuse` could not find an exactly-named, publicly exported construct
 * even with the graph indexed: the graph knew the symbol, reuse never asked.
 * The surface is walked IN GRAPH from what the index already stores — package
 * `entryFile` (the same resolver every bare consumer import goes through) and
 * the re-export index (the same chain follower the reference rewriter uses) —
 * so it cannot disagree with `graph callers` / `graph importers`.
 *
 * Every fixture is a real workspace indexed by the real `buildFullIndex`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildFullIndex } from '../indexer/index-builder.ts';
import { detectGraphFreshness, graphFreshnessBehind, updateChanged } from '../indexer/incremental-updater.ts';
import { buildReExportIndex } from '../indexer/re-export-index.ts';
import { NodeKind } from '../schema/node-kind.ts';
import { GraphStore } from '../store/graph-store.ts';
import { enumeratePublicSurface } from '../query/enumerate-public-surface.ts';
import { GraphQueryApi } from '../query/query-api.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-surface-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  buildFullIndex({ projectRoot: root });
  return root;
}

const ROOT_PKG = JSON.stringify({ name: 'demo-root', version: '0.0.0', private: true, workspaces: ['packages/*'] });

/** The round-11 §2.4 evidence fixture, verbatim. */
const BASE: Record<string, string> = {
  'package.json': ROOT_PKG,
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

/** Renames, defaults, a re-export cycle, a dist-only main and a package with no entry. */
const EXTENDED: Record<string, string> = {
  'package.json': ROOT_PKG,
  // main names a dist file that does not exist → the resolver falls back to src/index.ts.
  'packages/ui/package.json': JSON.stringify({ name: '@demo/ui', version: '0.0.0', main: 'dist/index.js' }),
  'packages/ui/src/index.ts':
    "export * from './pickers';\nexport { Renamed as Exposed } from './renamed';\nexport * from './with-default';\nexport * from './cycle-a';\n",
  'packages/ui/src/pickers/index.ts': "export * from './date-range-picker';\n",
  'packages/ui/src/pickers/date-range-picker.ts': 'export class DateRangePicker {}\n',
  'packages/ui/src/renamed.ts': 'export function Renamed(): number { return 1; }\n',
  'packages/ui/src/with-default.ts': 'export default class HiddenDefault {}\nexport const visibleNamed = 1;\n',
  'packages/ui/src/cycle-a.ts': "export * from './cycle-b';\nexport const CycleA = 1;\n",
  'packages/ui/src/cycle-b.ts': "export * from './cycle-a';\nexport const CycleB = 2;\n",
  'packages/app/package.json': JSON.stringify({ name: '@demo/app', version: '0.0.0', main: 'src/index.ts' }),
  'packages/app/src/index.ts':
    "import { DateRangePicker } from '@demo/ui';\nexport default function createApp(): unknown { return new DateRangePicker(); }\nexport const appName = 'x';\n",
  'packages/noentry/package.json': JSON.stringify({ name: '@demo/noentry', version: '0.0.0', main: 'dist/index.js' }),
  'packages/noentry/lib/x.ts': 'export const X = 1;\n',
};

function api(root: string): GraphQueryApi {
  return GraphQueryApi.fromStore(root);
}

function names(root: string, pkg: string): string[] {
  return api(root)
    .publicExportSurface()
    .exports.filter((e) => e.package === pkg)
    .map((e) => e.name)
    .sort();
}

describe('the public export surface (§2.4 fixture)', () => {
  test('a two-level star barrel reaches DateRangePicker, with the barrel chain as `via`', () => {
    const root = workspace(BASE);
    const drp = api(root).publicExportSurface().exports.find((e) => e.name === 'DateRangePicker');
    expect(drp).toBeDefined();
    expect(drp!.package).toBe('@demo/ui');
    expect(drp!.entryFile).toBe('packages/ui/src/index.ts');
    expect(drp!.declaredIn).toBe('packages/ui/src/pickers/date-range-picker.ts');
    expect(drp!.declKind).toBe('class');
    expect(drp!.via).toEqual(['packages/ui/src/index.ts', 'packages/ui/src/pickers/index.ts']);
    expect(drp!.symbolId).toBe('symbol:packages/ui/src/pickers/date-range-picker.ts#DateRangePicker');
  });

  test('only what an entry reaches: 5 of the 7 exported symbols', () => {
    const root = workspace(BASE);
    const a = api(root);
    const surface = a.publicExportSurface();
    expect(surface.exports.map((e) => e.name).sort()).toEqual(
      ['DateRangePicker', 'IDateRangePickerOptions', 'Popover', 'formatDateRange', 'makeThing'].sort(),
    );
    // internalOnlyHelper is exported by its file but never re-exported;
    // DeepRangeSlider is exported but unreachable from any entry.
    const snap = new GraphStore(root).loadSnapshot();
    const exported = [...snap.nodes.values()].filter(
      (n) => n.kind === NodeKind.Symbol && n.data?.['isExported'] === true,
    );
    expect(exported.length).toBe(7);
    expect(surface.roots.map((r) => r.package)).toEqual(['@demo/app', '@demo/ui']);
    expect(surface.packagesWithoutEntry).toEqual([]);
    // Memoized per snapshot.
    expect(a.publicExportSurface()).toBe(surface);
  });
});

describe('ESM export semantics', () => {
  test('`export { A as B } from` exposes B, landing on the declaration of A', () => {
    const root = workspace(EXTENDED);
    const exposed = api(root).publicExportSurface().exports.find((e) => e.name === 'Exposed');
    expect(exposed?.symbolId).toBe('symbol:packages/ui/src/renamed.ts#Renamed');
    expect(names(root, '@demo/ui')).not.toContain('Renamed');
  });

  test('`export *` does not forward a default export; the root default is on the surface', () => {
    const root = workspace(EXTENDED);
    const ui = names(root, '@demo/ui');
    expect(ui).toContain('visibleNamed');
    expect(ui).not.toContain('HiddenDefault');
    const app = api(root).publicExportSurface().exports.filter((e) => e.package === '@demo/app');
    const createApp = app.find((e) => e.name === 'createApp');
    expect(createApp?.isDefault).toBe(true);
    expect(app.find((e) => e.name === 'appName')?.isDefault).toBeUndefined();
  });

  test('a re-export cycle terminates, and both sides are on the surface', () => {
    const root = workspace(EXTENDED);
    const ui = names(root, '@demo/ui');
    expect(ui).toContain('CycleA');
    expect(ui).toContain('CycleB');
    expect(ui).toEqual(['CycleA', 'CycleB', 'DateRangePicker', 'Exposed', 'visibleNamed']);
  });
});

describe('the root is the file a bare import resolves to', () => {
  test('main naming a missing dist/index.js gives entryFile = src/index.ts', () => {
    const root = workspace(EXTENDED);
    const snap = new GraphStore(root).loadSnapshot();
    expect(snap.nodes.get('package:@demo/ui')?.data?.['entryFile']).toBe('packages/ui/src/index.ts');
    expect(snap.nodes.get('package:@demo/ui')?.data?.['entry']).toBe('packages/ui/dist/index.js');
  });

  test('PROPERTY: for every package a consumer imports, entryFile === the file that import resolved to', () => {
    for (const fixture of [BASE, EXTENDED]) {
      const root = workspace(fixture);
      const a = api(root);
      let checked = 0;
      for (const pkg of a.allPackages()) {
        const consumed = a.fileForSpecifier(pkg.label);
        if (!consumed) continue;
        checked += 1;
        expect({ pkg: pkg.label, entryFile: pkg.data?.['entryFile'] }).toEqual({
          pkg: pkg.label,
          entryFile: consumed.path,
        });
      }
      expect(checked).toBeGreaterThan(0);
    }
  });

  test('a package with no resolvable entry is reported with a reason, never dropped', () => {
    const root = workspace(EXTENDED);
    const surface = api(root).publicExportSurface();
    const missing = surface.packagesWithoutEntry.find((p) => p.package === '@demo/noentry');
    expect(missing?.dir).toBe('packages/noentry');
    expect(missing?.reason).toContain('no resolvable entry');
    expect(surface.roots.map((r) => r.package)).not.toContain('@demo/noentry');
  });

  test('an index older than entryFile degrades loudly instead of guessing', () => {
    const root = workspace(EXTENDED);
    const snap = new GraphStore(root).loadSnapshot();
    // The same nodes an older indexer wrote: package data without `entryFile`.
    const legacyNodes = [...snap.nodes.values()].map((n) => {
      if (n.kind !== NodeKind.Package) return n;
      const { entryFile: _dropped, ...rest } = n.data ?? {};
      return { ...n, data: rest };
    });
    const surface = enumeratePublicSurface(legacyNodes, [...snap.edges.values()]);
    // @demo/app's raw entry IS an indexed file → still a root.
    expect(surface.roots.map((r) => r.package)).toContain('@demo/app');
    // @demo/ui's raw entry is the missing dist file → not guessed.
    const ui = surface.packagesWithoutEntry.find((p) => p.package === '@demo/ui');
    expect(ui?.reason).toContain('predates package entryFile');
  });

  test('an incremental update that adds src/index.ts later refreshes entryFile', () => {
    const root = workspace({
      'package.json': ROOT_PKG,
      'packages/late/package.json': JSON.stringify({ name: '@demo/late', version: '0.0.0', main: 'dist/index.js' }),
      'packages/late/src/late.ts': 'export class LateWidget {}\n',
    });
    expect(api(root).publicExportSurface().packagesWithoutEntry.map((p) => p.package)).toEqual(['@demo/late']);
    writeFileSync(join(root, 'packages/late/src/index.ts'), "export * from './late';\n");
    updateChanged({ projectRoot: root, changedFiles: ['packages/late/src/index.ts'] });
    const after = api(root);
    const snap = new GraphStore(root).loadSnapshot();
    expect(snap.nodes.get('package:@demo/late')?.data?.['entryFile']).toBe('packages/late/src/index.ts');
    expect(after.publicExportSurface().exports.map((e) => e.name)).toEqual(['LateWidget']);
  });
});

/** Unfollowable re-exports of every kind, plus a namespace re-export. */
const NEVER_SILENT: Record<string, string> = {
  'package.json': ROOT_PKG,
  'packages/ui/package.json': JSON.stringify({ name: '@demo/ui', version: '0.0.0', main: 'src/index.ts' }),
  'packages/ui/src/index.ts':
    "export * from './gone';\nexport * from 'left-pad';\nexport { Missing } from './real';\n" +
    "export { padStart } from 'left-pad';\nexport * as real from './real';\nexport * from './real';\n",
  'packages/ui/src/real.ts': 'export const realThing = 1;\n',
};

describe('never silent: every re-export that lands nowhere is listed and classified (review, low)', () => {
  test('local (unresolved) vs outside the workspace (external), per re-export', () => {
    const surface = api(workspace(NEVER_SILENT)).publicExportSurface();
    expect(surface.unfollowedReExports.map((u) => `${u.kind}:${u.name}:${u.specifier}`).sort()).toEqual([
      'external:*:left-pad',
      'external:padStart:left-pad',
      'unresolved:*:./gone',
      'unresolved:Missing:./real',
    ]);
    expect(surface.unresolvedReExports).toBe(surface.unfollowedReExports.length);
    for (const u of surface.unfollowedReExports) expect(u.package).toBe('@demo/ui');
  });

  test('`export * as ns` binds the module: on the surface as a namespace (it used to vanish)', () => {
    const surface = api(workspace(NEVER_SILENT)).publicExportSurface();
    expect(surface.exports.find((e) => e.name === 'real')).toMatchObject({
      package: '@demo/ui',
      namespace: true,
      declKind: 'namespace',
      declaredIn: 'packages/ui/src/real.ts',
      symbolId: 'file:packages/ui/src/real.ts',
      via: ['packages/ui/src/index.ts'],
    });
    expect(surface.exports.map((e) => e.name).sort()).toEqual(['real', 'realThing']);
  });

  test('ONE walk: moduleExports() of a package root is exactly that package on the surface', () => {
    for (const fixture of [BASE, EXTENDED, NEVER_SILENT]) {
      const a = api(workspace(fixture));
      const surface = a.publicExportSurface();
      for (const r of surface.roots) {
        const key = (e: { name: string; symbolId: string; isDefault?: boolean }): string =>
          `${e.name}|${e.symbolId}|${e.isDefault === true}`;
        const walked = a.moduleExports(r.entryFile).exports.map(key).sort();
        const onSurface = surface.exports.filter((e) => e.package === r.package).map(key).sort();
        expect({ pkg: r.package, walked }).toEqual({ pkg: r.package, walked: onSurface });
      }
    }
  });
});

describe('freshness covers package entries (review #1)', () => {
  test('a package.json-only entry edit is packagesChanged; a full index clears it; a new package is reported', () => {
    const root = workspace(BASE);
    expect(detectGraphFreshness(root).packagesChanged).toEqual([]);
    writeFileSync(
      join(root, 'packages/ui/package.json'),
      JSON.stringify({ name: '@demo/ui', version: '0.0.0', main: 'src/pickers/index.ts' }),
    );
    const f = detectGraphFreshness(root);
    // No source file changed — only the file walk's blind spot moved.
    expect([f.modified, f.added, f.deleted]).toEqual([[], [], []]);
    expect(f.packagesChanged).toEqual(['@demo/ui']);
    expect(graphFreshnessBehind(f)).toBe(1);
    buildFullIndex({ projectRoot: root });
    expect(detectGraphFreshness(root).packagesChanged).toEqual([]);
    mkdirSync(join(root, 'packages/extra'), { recursive: true });
    writeFileSync(join(root, 'packages/extra/package.json'), JSON.stringify({ name: '@demo/extra', version: '0.0.0' }));
    expect(detectGraphFreshness(root).packagesChanged).toEqual(['@demo/extra']);
  });
});

describe('one chain follower', () => {
  test('PROPERTY: every surface export is where the re-export index resolves its name from the entry', () => {
    for (const fixture of [BASE, EXTENDED]) {
      const root = workspace(fixture);
      const snap = new GraphStore(root).loadSnapshot();
      const index = buildReExportIndex([...snap.nodes.values()], [...snap.edges.values()]);
      const surface = api(root).publicExportSurface();
      expect(surface.exports.length).toBeGreaterThan(0);
      for (const e of surface.exports) {
        const key = e.isDefault ? 'default' : e.name;
        expect({ name: e.name, resolved: index.resolveName(e.entryFile, key) }).toEqual({
          name: e.name,
          resolved: e.symbolId,
        });
        // …and the query API answers from the same index.
        expect(api(root).resolveExportedName(e.entryFile, key)).toBe(e.symbolId);
      }
    }
  });
});
