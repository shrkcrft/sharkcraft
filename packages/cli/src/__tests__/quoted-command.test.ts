/**
 * Quoted multi-word command dispatch (main.ts).
 *
 * A multi-word command passed as a SINGLE quoted token — `shrk "graph status"`
 * — arrives as one argv element with internal whitespace. The trie has no
 * atomic `graph status` node, so the first descent misses; main.ts re-splits
 * the lone token on whitespace and retries the resolve. Net effect:
 * `shrk "graph status"` must behave identically to `shrk graph status`.
 *
 * The suite is self-contained: it indexes an empty temp dir (the repo's own
 * `.sharkcraft/` store is gitignored, so REPO_ROOT state is non-deterministic),
 * then exercises the quoted/unquoted forms against that fresh store.
 */
import { describe, expect, test, beforeAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

const CLI = nodePath.resolve(__dirname, '..', 'main.ts');

function shrk(args: readonly string[], cwd: string): { code: number; out: string; err: string } {
  const r = spawnSync('bun', [CLI, ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

describe('quoted multi-word command dispatch', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(nodePath.join(tmpdir(), 'shrk-quoted-'));
    // Build a fresh, empty graph store so `graph status` reports `fresh` (exit 0).
    const idx = shrk(['--cwd', dir, 'graph', 'index'], dir);
    expect(idx.code).toBe(0);
  });

  test('`shrk "graph status"` exits 0 with graph-status output', () => {
    const r = shrk(['--cwd', dir, 'graph status'], dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Graph status');
    // The reported self-contradiction: quoted form must NOT hit did-you-mean.
    expect(r.err).not.toContain("doesn't have");
  });

  test('quoted `"graph status"` is identical to unquoted `graph status`', () => {
    const quoted = shrk(['--cwd', dir, 'graph status'], dir);
    const unquoted = shrk(['--cwd', dir, 'graph', 'status'], dir);
    expect(quoted.code).toBe(unquoted.code);
    expect(quoted.out.trim()).toBe(unquoted.out.trim());
  });

  test('`shrk "graph index"` resolves to the graph-index verb', () => {
    const r = shrk(['--cwd', dir, 'graph index'], dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Graph index');
    expect(r.err).not.toContain("doesn't have");
  });

  test('a genuinely bogus quoted token still errors', () => {
    const r = shrk(['--cwd', dir, 'zzz qqq'], dir);
    expect(r.code).toBe(2);
    expect(r.err).toContain("doesn't have");
    // The split retry found no handler, so the original token is reported intact.
    expect(r.err).toContain('zzz qqq');
  });
});
