/**
 * Round 11 §3.6 — `helper list|get|plan|doctor` read the ONE helper catalog
 * (built-in ∪ pack/local). They used to read only the built-in set, which
 * ships empty: `helper list` printed 0 and `helper plan <pack-id>` said
 * "Unknown helper" while the inventory listed the helper as ok. `--source` is
 * a real flag now (it was documented and silently swallowed).
 *
 * The CLI is spawned from source against a real consumer repo.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const MAIN = resolve(import.meta.dir, '../main.ts');
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

function shrk(root: string, ...argv: string[]): { code: number; out: string; err: string } {
  const r = spawnSync('bun', [MAIN, '--cwd', root, ...argv], { encoding: 'utf8', timeout: 60_000 });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

const PACK_HELPER = `export default [{
  id: 'r75.add-route',
  title: 'Add route',
  description: 'Register a route',
  variables: [{ name: 'name', required: true, description: 'route name' }],
  operations: [{ kind: 'append-line', targetPath: 'src/routes.ts', snippet: "export const {{name}} = '{{name}}';", description: 'register the route' }],
  safety: { outputKind: 'plan' },
}];\n`;
const LOCAL_HELPER = `export default [{ id: 'r75.local-helper', title: 'Local', description: 'local helper', variables: [], safety: { outputKind: 'checklist' }, manualChecklist: ['do it'] }];\n`;

function consumer(opts: { broken?: boolean; empty?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-helper-cli-'));
  roots.push(root);
  write(root, 'package.json', JSON.stringify({ name: 'consumer', version: '0.0.0' }));
  write(root, 'sharkcraft/sharkcraft.config.ts', "export default { projectName: 'consumer' };\n");
  if (opts.empty) return root;
  write(root, 'sharkcraft/helpers.ts', LOCAL_HELPER);
  const pack = join(root, 'node_modules', '@r75', 'helpers');
  const helperFiles = ['./helpers.ts', ...(opts.broken ? ['./helpers-broken.ts'] : [])];
  write(pack, 'package.json', JSON.stringify({ name: '@r75/helpers', version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }));
  write(
    pack,
    'manifest.json',
    JSON.stringify({ schema: 'sharkcraft.pack/v1', info: { name: '@r75/helpers', version: '0.0.1' }, contributions: { helperFiles } }),
  );
  write(pack, 'helpers.ts', PACK_HELPER);
  if (opts.broken) write(pack, 'helpers-broken.ts', `export default [{ id: 'x', tags: ['a' 'b'] }];\n`);
  return root;
}

describe('shrk helper — one catalog', () => {
  const root = consumer();

  test('helper list shows pack AND local helpers with their source', () => {
    const r = shrk(root, 'helper', 'list');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Helpers (2)');
    expect(r.out).toMatch(/r75\.add-route\s+pack @r75\/helpers/);
    expect(r.out).toMatch(/r75\.local-helper\s+local/);
  });

  test('--source filters; an invalid --source is a usage error (3)', () => {
    const pack = shrk(root, 'helper', 'list', '--source', 'pack', '--json');
    expect(pack.code).toBe(0);
    expect((JSON.parse(pack.out) as { id: string }[]).map((h) => h.id)).toEqual(['r75.add-route']);
    const bogus = shrk(root, 'helper', 'list', '--source', 'bogus');
    expect(bogus.code).toBe(3);
    expect(bogus.err).toContain('builtin, local, pack');
  });

  test('helper get prints the pack helper: source, operations', () => {
    const r = shrk(root, 'helper', 'get', 'r75.add-route');
    expect(r.code).toBe(0);
    expect(r.out).toContain('pack @r75/helpers');
    expect(r.out).toContain('append-line src/routes.ts');
  });

  test('helper plan renders the declarative op with the substitution applied; a missing var is refused', () => {
    const r = shrk(root, 'helper', 'plan', 'r75.add-route', '--var', 'name=users');
    expect(r.code).toBe(0);
    expect(r.out).toContain("export const users = 'users';");
    const missing = shrk(root, 'helper', 'plan', 'r75.add-route');
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('--var name=');
  });

  test('--save-plan on a pack helper is refused loudly (2) and writes nothing', () => {
    const r = shrk(root, 'helper', 'plan', 'r75.add-route', '--var', 'name=x', '--save-plan', 'plan.json');
    expect(r.code).toBe(2);
    expect(r.err).toContain('Refusing --save-plan');
    expect(existsSync(join(root, 'plan.json'))).toBe(false);
  });

  test('helper doctor: clean → 0 ✓; a syntax-error helper file → load-failed, 1', () => {
    const clean = shrk(root, 'helper', 'doctor');
    expect(clean.code).toBe(0);
    expect(clean.out).toContain('Helpers OK');
    const broken = shrk(consumer({ broken: true }), 'helper', 'doctor');
    expect(broken.code).toBe(1);
    expect(broken.out).toContain('load-failed');
  });

  test('helper doctor over no helper files examined nothing → 2; --allow-empty accepts it → 0', () => {
    const empty = consumer({ empty: true });
    const r = shrk(empty, 'helper', 'doctor');
    expect(r.code).toBe(2);
    expect(r.out).toContain('NOT VERIFIED');
    expect(shrk(empty, 'helper', 'doctor', '--allow-empty').code).toBe(0);
  });
});
