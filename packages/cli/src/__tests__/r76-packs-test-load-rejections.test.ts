/**
 * r76 — `shrk packs test --load` runs THE runtime validator of every slot
 * (round 12, 12.1c / 12.1f).
 *
 * The round-12 report's pack: an UNANNOTATED convention literal missing its
 * required `severity`. `packs test --load` checked only that each entry of 8
 * slots carried a string `id` (`No issues found.`, exit 0), and `--typecheck`
 * could not help — tsc enforces only the types an author annotated.
 *
 *   - unannotated: `--load` exits 1 with `asset-entry-rejected … 'conv.b' …
 *     severity` — the SAME refusal the loader applies at runtime — and points
 *     at `satisfies IConvention[]` + `--typecheck`;
 *   - annotated with the local interface: `--typecheck` still reports TS2741
 *     (round 11 behaviour preserved), and the pointer is not repeated.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const TIMEOUT_MS = 300_000;
const roots: string[] = [];

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function shrk(cwd: string, argv: readonly string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('bun', ['run', CLI_MAIN, '--no-hints', ...argv], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const INTERFACE = 'interface ILocalConvention { id: string; title: string; kind: string; severity: string; rules: unknown[] }\n';
const ENTRIES =
  "  { id: 'conv.a', title: 'A', kind: 'naming', severity: 'warning', rules: [] },\n" +
  "  { id: 'conv.b', title: 'B', kind: 'naming', rules: [] },\n";

function pack(annotated: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r76-packtest-'));
  roots.push(root);
  const write = (rel: string, body: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  write('package.json', JSON.stringify({ name: '@r76/f1', version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }));
  write(
    'manifest.json',
    JSON.stringify({ schema: 'sharkcraft.pack/v1', info: { name: '@r76/f1', version: '0.0.1' }, contributions: { conventionFiles: ['./conventions.ts'] } }),
  );
  write(
    'conventions.ts',
    annotated
      ? `${INTERFACE}const conventions: ILocalConvention[] = [\n${ENTRIES}];\nexport default conventions;\n`
      : `${INTERFACE}export default [\n${ENTRIES}];\n`,
  );
  return root;
}

describe('r76 packs test --load validates through the runtime loader', () => {
  test(
    'an unannotated literal missing a required field → asset-entry-rejected, exit 1, with the build-time pointer',
    () => {
      const root = pack(false);
      const text = shrk(root, ['packs', 'test', '.', '--load']);
      expect(text.status).toBe(1);
      expect(text.stdout).toContain('asset-entry-rejected');
      expect(text.stdout).toContain("conventions.ts 'conv.b' (default[1]) — severity:");
      expect(text.stdout).toContain('satisfies IConvention[]');
      expect(text.stdout).not.toContain('No issues found.');
      const json = JSON.parse(shrk(root, ['packs', 'test', '.', '--load', '--json']).stdout) as {
        exitCode: number;
        issues: { code: string; message: string }[];
        modules: { relativePath: string; accepted?: number; rejected?: number }[];
      };
      expect(json.exitCode).toBe(1);
      expect(json.issues.filter((i) => i.code === 'asset-entry-rejected')).toHaveLength(1);
      expect(json.modules.find((m) => m.relativePath === 'conventions.ts')).toMatchObject({ accepted: 1, rejected: 1 });
    },
    TIMEOUT_MS,
  );

  test(
    'annotated with its interface: --typecheck still reports TS2741, and the pointer is not repeated',
    () => {
      const root = pack(true);
      const text = shrk(root, ['packs', 'test', '.', '--load', '--typecheck']);
      expect(text.status).toBe(1);
      expect(text.stdout).toContain('TS2741');
      expect(text.stdout).toContain('asset-entry-rejected');
      expect(text.stdout).not.toContain('satisfies IConvention[]');
    },
    TIMEOUT_MS,
  );
});
