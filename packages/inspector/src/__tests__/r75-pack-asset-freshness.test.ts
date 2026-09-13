/**
 * Round 11 §3.3#1 + challenge L-5 #3 — ONE pack-asset freshness authority.
 *
 * Three mtime heuristics used to answer "is this pack stale?" and disagreed in
 * both directions; none of them saw a compiled `dist/*.js` built from an OLDER
 * `src/*.ts`. `detectPackAssetFreshness` reads recorded CONTENT (the signature's
 * digests, a source map's `sourcesContent`) — divergence, never age — and
 * signature-status, dev-status and the contributions inventory all consume it.
 *
 * Every fixture is a real consumer repo with a real pack under node_modules,
 * loaded through `inspectSharkcraft`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { signPackManifest, type ISharkCraftPackManifest } from '@shrkcrft/plugin-api';
import {
  buildPackContributionsInventoryAsync,
  buildPackDevStatus,
  buildPackSignatureStatusReport,
  computePackContentDigests,
  ConflictKind,
  detectPackAssetFreshness,
  inspectSharkcraft,
  PackSignatureStatusKind,
  runDoctor,
} from '../index.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

const entry = (summary: string): string =>
  `export default [{ id: 'fresh.rule', title: 'Rule', type: 'rule', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: '${summary}' }];\n`;
const SRC = entry('NEW source summary');
const COMPILED = entry('OLD compiled summary');

function manifest(contributions: ISharkCraftPackManifest['contributions']): ISharkCraftPackManifest {
  return { schema: 'sharkcraft.pack/v1', info: { name: '@r75/fresh', version: '0.0.1' }, contributions };
}

/** A consumer repo with `@r75/fresh` under node_modules; the manifest is a JSON file. */
function consumer(files: Record<string, string>, m: ISharkCraftPackManifest, pkgExtra: Record<string, unknown> = {}): {
  root: string;
  packRoot: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-fresh-'));
  roots.push(root);
  write(root, 'package.json', JSON.stringify({ name: 'consumer', version: '0.0.0' }));
  write(root, 'sharkcraft/sharkcraft.config.ts', "export default { projectName: 'consumer' };\n");
  const packRoot = join(root, 'node_modules', '@r75', 'fresh');
  write(
    packRoot,
    'package.json',
    JSON.stringify({ name: '@r75/fresh', version: '0.0.1', sharkcraft: { manifest: './manifest.json' }, ...pkgExtra }),
  );
  for (const [rel, body] of Object.entries(files)) write(packRoot, rel, body);
  write(packRoot, 'manifest.json', JSON.stringify(m, null, 2));
  return { root, packRoot };
}

/** Re-sign the pack's manifest in place, recording content digests (as `shrk packs sign` does). */
function sign(packRoot: string, m: ISharkCraftPackManifest, opts: { dev?: boolean; digests?: boolean } = {}): ISharkCraftPackManifest {
  const r = signPackManifest(m, {
    secret: 'r75-secret',
    ...(opts.dev ? { dev: true } : {}),
    ...(opts.digests === false ? {} : { contentDigests: computePackContentDigests(packRoot, m) }),
  });
  if (!r.ok) throw new Error(r.message);
  write(packRoot, 'manifest.json', JSON.stringify(r.manifest, null, 2));
  return r.manifest;
}

const PACK = (packRoot: string, m: ISharkCraftPackManifest) => ({ packageName: '@r75/fresh', packageRoot: packRoot, manifest: m });

describe('build freshness — compiled artifacts vs their source', () => {
  test('a compiled artifact with no build record is unrecorded — never fresh', () => {
    const m = manifest({ ruleFiles: ['./dist/assets/rules.js'] });
    const { packRoot } = consumer({ 'dist/assets/rules.js': COMPILED, 'src/assets/rules.ts': SRC }, m);
    const f = detectPackAssetFreshness(PACK(packRoot, m));
    expect(f.build.state).toBe('unrecorded');
    expect(f.build.artifacts).toEqual([{ artifact: 'dist/assets/rules.js', source: 'src/assets/rules.ts', state: 'unrecorded' }]);
    expect(f.signature.state).toBe('unsigned');
  });

  test('a source map records the build: equal sourcesContent → fresh; an edited source → stale, whatever the mtimes', () => {
    const m = manifest({ ruleFiles: ['./dist/assets/rules.js'] });
    const map = JSON.stringify({ version: 3, sources: ['../../src/assets/rules.ts'], sourcesContent: [SRC], mappings: '' });
    const { packRoot } = consumer(
      {
        'dist/assets/rules.js': COMPILED + '//# sourceMappingURL=rules.js.map\n',
        'dist/assets/rules.js.map': map,
        'src/assets/rules.ts': SRC,
      },
      m,
    );
    expect(detectPackAssetFreshness(PACK(packRoot, m)).build.state).toBe('fresh');
    write(packRoot, 'src/assets/rules.ts', entry('EDITED after the build'));
    // Make the edited source OLDER than the artifact: age must not matter.
    utimesSync(join(packRoot, 'src/assets/rules.ts'), new Date('2000-01-01'), new Date('2000-01-01'));
    const f = detectPackAssetFreshness(PACK(packRoot, m));
    expect(f.build.state).toBe('stale');
    expect(f.build.artifacts[0]).toMatchObject({ state: 'stale', recordedBy: 'source-map' });
  });

  test('signed digests record the build: the signed artifact goes stale when its source diverges', () => {
    const unsigned = manifest({ ruleFiles: ['./dist/assets/rules.js'] });
    const { packRoot } = consumer({ 'dist/assets/rules.js': COMPILED, 'src/assets/rules.ts': SRC }, unsigned, {
      scripts: { build: 'tsc' },
    });
    const m = sign(packRoot, unsigned);
    expect(Object.keys(m.signature!.contentDigests!).sort()).toEqual(['dist/assets/rules.js', 'src/assets/rules.ts']);
    let f = detectPackAssetFreshness(PACK(packRoot, m));
    expect(f.signature.state).toBe('fresh');
    expect(f.build.state).toBe('fresh');

    write(packRoot, 'src/assets/rules.ts', entry('EDITED source'));
    f = detectPackAssetFreshness(PACK(packRoot, m));
    expect(f.signature).toMatchObject({ state: 'diverged', diverged: ['src/assets/rules.ts'] });
    expect(f.build).toMatchObject({ state: 'stale', rebuildCommand: 'npm run build' });
    expect(f.build.artifacts[0]!.recordedBy).toBe('signature');

    // Rebuilt after signing: the signed record no longer describes this build.
    write(packRoot, 'dist/assets/rules.js', entry('REBUILT'));
    f = detectPackAssetFreshness(PACK(packRoot, m));
    expect(f.build.state).toBe('unrecorded');
    expect(f.signature.diverged).toContain('dist/assets/rules.js');
  });

  test('tsconfig outDir → rootDir mapping is honoured', () => {
    const m = manifest({ ruleFiles: ['./out/rules.js'] });
    const { packRoot } = consumer(
      {
        'tsconfig.json': '{ // comments are tolerated\n "compilerOptions": { "outDir": "out", "rootDir": "lib-src" } }\n',
        'out/rules.js': COMPILED,
        'lib-src/rules.ts': SRC,
      },
      m,
    );
    expect(detectPackAssetFreshness(PACK(packRoot, m)).build.artifacts[0]!.source).toBe('lib-src/rules.ts');
  });

  test('a TS-source pack is not-compiled; an installed dist-only pack is no-source', () => {
    const ts = manifest({ ruleFiles: ['./src/assets/rules.ts'] });
    const a = consumer({ 'src/assets/rules.ts': SRC }, ts);
    expect(detectPackAssetFreshness(PACK(a.packRoot, ts)).build.state).toBe('not-compiled');
    const dist = manifest({ ruleFiles: ['./dist/assets/rules.js'] });
    const b = consumer({ 'dist/assets/rules.js': COMPILED }, dist);
    expect(detectPackAssetFreshness(PACK(b.packRoot, dist)).build.state).toBe('no-source');
  });

  test('the inspection carries it, and runDoctor reports a stale compiled build', async () => {
    const m = manifest({ ruleFiles: ['./dist/assets/rules.js'] });
    const map = JSON.stringify({ version: 3, sources: ['../../src/assets/rules.ts'], sourcesContent: [SRC], mappings: '' });
    const { root } = consumer(
      { 'dist/assets/rules.js': COMPILED, 'dist/assets/rules.js.map': map, 'src/assets/rules.ts': entry('EDITED') },
      m,
    );
    const inspection = await inspectSharkcraft({ cwd: root });
    expect(inspection.packAssetFreshness?.map((f) => f.build.state)).toEqual(['stale']);
    const check = runDoctor(inspection).checks.find((c) => c.code === 'compiled-artifacts-stale');
    expect(check?.message).toContain('shrk is serving the previous build');
  });
});

describe('signature freshness — a pre-digest signature is unrecorded, never fresh', () => {
  test('signed without content digests → unrecorded', () => {
    const unsigned = manifest({ ruleFiles: ['./src/assets/rules.ts'] });
    const { packRoot } = consumer({ 'src/assets/rules.ts': SRC }, unsigned);
    const m = sign(packRoot, unsigned, { digests: false });
    const f = detectPackAssetFreshness(PACK(packRoot, m));
    expect(f.signature).toMatchObject({ state: 'unrecorded', unrecorded: ['src/assets/rules.ts'] });
  });
});

/**
 * The property the three mtime checks violated: every consumer returns the
 * SAME answer, because every consumer reads the one authority. Each scenario
 * is built so the OLD mtime heuristics would have disagreed with the truth.
 */
describe('every freshness consumer agrees (signature-status, dev-status, inventory)', () => {
  type State = 'fresh' | 'diverged' | 'unrecorded' | 'unsigned';
  const scenarios: readonly { name: string; state: State; dev: boolean }[] = [
    { name: 'fresh content, old signedAt, new mtimes', state: 'fresh', dev: false },
    { name: 'fresh content (dev)', state: 'fresh', dev: true },
    { name: 'changed content, mtime set to the past', state: 'diverged', dev: false },
    { name: 'changed content (dev)', state: 'diverged', dev: true },
    { name: 'pre-digest signature', state: 'unrecorded', dev: false },
    { name: 'pre-digest signature (dev)', state: 'unrecorded', dev: true },
    { name: 'unsigned', state: 'unsigned', dev: false },
  ];
  const devStatusOf: Record<State, 'fresh' | 'stale' | 'missing' | 'unknown'> = {
    fresh: 'fresh',
    diverged: 'stale',
    unrecorded: 'unknown',
    unsigned: 'missing',
  };

  for (const s of scenarios) {
    test(s.name, async () => {
      const unsigned = manifest({ ruleFiles: ['./src/assets/rules.ts'] });
      const { root, packRoot } = consumer({ 'src/assets/rules.ts': SRC }, unsigned);
      if (s.state !== 'unsigned') {
        const m = sign(packRoot, unsigned, { dev: s.dev, digests: s.state !== 'unrecorded' });
        if (s.state === 'fresh') {
          // Signed "long ago", files touched now: the old heuristics said stale.
          write(packRoot, 'manifest.json', JSON.stringify({ ...m, signature: { ...m.signature, signedAt: '2020-01-01T00:00:00.000Z' } }));
          const now = new Date();
          utimesSync(join(packRoot, 'src/assets/rules.ts'), now, now);
        }
        if (s.state === 'diverged') {
          // Content changed, mtime pushed into the past: the old heuristics said fresh.
          write(packRoot, 'src/assets/rules.ts', entry('CHANGED after signing'));
          utimesSync(join(packRoot, 'src/assets/rules.ts'), new Date('2000-01-01'), new Date('2000-01-01'));
        }
      }
      const inspection = await inspectSharkcraft({ cwd: root });
      const pack = inspection.packs.validPacks.find((p) => p.packageName === '@r75/fresh')!;
      const f = detectPackAssetFreshness(pack);
      expect(f.signature.state).toBe(s.state);

      const dev = await buildPackDevStatus({ packPath: packRoot });
      expect(dev.signatureStaleness).toBe(devStatusOf[s.state]);

      const sig = buildPackSignatureStatusReport(inspection).packs[0]!;
      const expectedStatus =
        s.state === 'unsigned'
          ? PackSignatureStatusKind.Missing
          : s.state === 'unrecorded'
            ? PackSignatureStatusKind.Unverified
            : s.state === 'diverged' && !s.dev
              ? PackSignatureStatusKind.Stale
              : PackSignatureStatusKind.Present;
      expect(sig.status).toBe(expectedStatus);

      const inv = await buildPackContributionsInventoryAsync(inspection);
      expect(inv.conflicts.some((c) => c.kind === ConflictKind.StaleSignature)).toBe(s.state === 'diverged' && !s.dev);
    });
  }
});
