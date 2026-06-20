import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// Guards against the failure that shipped in v0.1.0-alpha.16: a `git add -A`
// release commit swept debug scratch (`test_marker.ts`, `test_var_re.{ts,js}`,
// and a broken `test_triple_quote_issue.test.ts`) into the repo root. Because
// Bun's default runner collects `*.test.{ts,js}` recursively from the root, the
// broken file failed `bun test` — and therefore `release:preflight` — from
// inside a tagged release.
//
// We check GIT-TRACKED files only: that is exactly what shipped. Local,
// gitignored working-tree scratch (e.g. `_tmp_*` a tool wrote) is fine and must
// not flake this guard — the `.gitignore` rules already make such files
// un-committable, which is the real protection. Every legitimate test lives
// under `packages/*/src/__tests__/`, `scripts/__tests__/`, `tools/*/__tests__/`,
// or `examples/`; nothing belongs at the repo root.
const REPO_ROOT = join(import.meta.dir, '..', '..');

const FORBIDDEN_ROOT_PATTERNS: ReadonlyArray<RegExp> = [
  /\.test\.[mc]?[tj]s$/, // any collectable test file at the root
  /^test_.*\.[mc]?[tj]s$/, // `test_*.ts` / `test_*.js` scratch
  /^_tmp_/, // `_tmp_*` scratch harnesses
];

describe('no stray scratch / test files committed at the repo root', () => {
  test('git tracks no root-level *.test.* or test_* / _tmp_* scratch', () => {
    const res = spawnSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' });
    // If git is unavailable (no repo / no binary), the guard can't run — pass
    // rather than flake; `.gitignore` is the primary defense.
    if (res.status !== 0 || typeof res.stdout !== 'string') return;

    const rootFiles = res.stdout
      .split('\0')
      .filter((p) => p.length > 0 && !p.includes('/')); // repo-root files only
    const offenders = rootFiles.filter((name) =>
      FORBIDDEN_ROOT_PATTERNS.some((re) => re.test(name)),
    );

    expect(
      offenders,
      offenders.length > 0
        ? `Untrack these root-level files (debug scratch or misplaced tests; ` +
            `they belong under packages/*/src/__tests__/): ${offenders.join(', ')}`
        : undefined,
    ).toEqual([]);
  });
});
