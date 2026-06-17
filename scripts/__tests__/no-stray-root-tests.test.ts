import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

// Guards against the failure that shipped in v0.1.0-alpha.16: a `git add -A`
// release commit swept debug scratch (`test_marker.ts`, `test_var_re.{ts,js}`,
// and a broken `test_triple_quote_issue.test.ts`) into the repo root. Because
// Bun's default runner collects `*.test.{ts,js}` recursively from the root, the
// broken file failed `bun test` — and therefore `release:preflight` — from
// inside a tagged release.
//
// Every real test in this repo lives under `packages/*/src/__tests__/`,
// `scripts/__tests__/`, `tools/*/__tests__/`, or `examples/`. Nothing legitimate
// sits at the repo root, so any root-level test or scratch file is a mistake.
const REPO_ROOT = join(import.meta.dir, '..', '..');

// `test/` (the dir holding test/preload-env.ts) and `bunfig.toml` are infra, not
// scratch — they don't match these patterns.
const FORBIDDEN_ROOT_PATTERNS: ReadonlyArray<RegExp> = [
  /\.test\.[mc]?[tj]s$/, // any collectable test file at the root
  /^test_.*\.[mc]?[tj]s$/, // `test_*.ts` / `test_*.js` scratch
  /^_tmp_/, // `_tmp_*` scratch harnesses
];

describe('no stray scratch / test files at the repo root', () => {
  test('the repo root contains no root-level *.test.* or test_* / _tmp_* scratch', () => {
    const entries = readdirSync(REPO_ROOT, { withFileTypes: true });
    const offenders = entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .filter((name) => FORBIDDEN_ROOT_PATTERNS.some((re) => re.test(name)));

    expect(
      offenders,
      offenders.length > 0
        ? `Remove these root-level files (they belong under packages/*/src/__tests__/ ` +
            `or are debug scratch): ${offenders.join(', ')}`
        : undefined,
    ).toEqual([]);
  });
});
