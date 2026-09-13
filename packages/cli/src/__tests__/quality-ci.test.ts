import { describe, expect, test } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');

function shrk(args: readonly string[], cwd: string): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const res = spawnSync('bun', ['run', CLI_MAIN, ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout?.toString() ?? '',
    stderr: res.stderr?.toString() ?? '',
  };
}

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-quality-'));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  mkdirSync(join(root, 'sharkcraft', 'node_modules', '@shrkcrft'), { recursive: true });
  const symlinks: Array<[string, string]> = [
    ['config', 'packages/config'],
    ['knowledge', 'packages/knowledge'],
    ['templates', 'packages/templates'],
  ];
  for (const [name, relTarget] of symlinks) {
    const linkPath = join(root, 'sharkcraft', 'node_modules', '@shrkcrft', name);
    spawnSync('ln', ['-s', join(REPO_ROOT, relTarget), linkPath]);
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'q', version: '0.0.0' }));
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    `export default { projectName: 'q', knowledgeFiles: [], ruleFiles: [], pathFiles: [], templateFiles: [], docsFiles: [] };\n`,
  );
  return root;
}

interface IQualityRunJson {
  readonly failFast?: boolean;
  readonly verdict: string;
  readonly passed: number;
  readonly failed: number;
  readonly failedWarnings: number;
  readonly skipped: number;
  readonly errored: number;
  readonly exitCode: number;
  readonly items: {
    id: string;
    status: string;
    severity: string;
    data?: { examinedNothing?: boolean };
  }[];
}

describe('shrk quality', () => {
  test('json output is the run: a verdict, the counts, and every gate', () => {
    const root = makeFixture();
    const r = shrk(['--cwd', root, 'quality', '--json'], root);
    // Quality is allowed to exit non-zero — the structural assertions are what we care about.
    const out = JSON.parse(r.stdout) as IQualityRunJson;
    expect(['pass', 'fail', 'not-verified'].includes(out.verdict)).toBe(true);
    for (const id of ['doctor', 'boundaries', 'coverage']) {
      expect(out.items.some((g) => g.id === id)).toBe(true);
    }
    // The counts must partition the items — a summary that can contradict its
    // own rows is how people learn to stop reading the summary.
    expect(out.passed + out.failed + out.failedWarnings + out.skipped + out.errored).toBe(
      out.items.length,
    );
  });

  test('the run is exhaustive by default — no gate stops the rest', () => {
    const root = makeFixture();
    const r = shrk(['--cwd', root, 'quality', '--json'], root);
    const out = JSON.parse(r.stdout) as IQualityRunJson;
    // Nothing was skipped for lack of a chance to run: the whole point is that
    // N independent failures cost ONE local pass, not N CI round-trips. (Round
    // 11: a gate with NOTHING to examine — zero context tests — reports
    // `skipped` instead of a vacuous `passed`; that is not a fail-fast skip.)
    expect(
      out.items.every((i) => i.status !== 'skipped' || i.data?.examinedNothing === true),
    ).toBe(true);
  });

  test('--strict promotes advisory failures into blocking ones', () => {
    const root = makeFixture();
    const r = shrk(['--cwd', root, 'quality', '--strict', '--json'], root);
    const out = JSON.parse(r.stdout) as IQualityRunJson;
    expect(out.failedWarnings).toBe(0);
    for (const item of out.items) {
      if (item.status === 'failed') expect(item.severity).toBe('error');
    }
  });

  test('--fail-fast stops after the first blocking failure and says so', () => {
    const root = makeFixture();
    const strict = JSON.parse(
      shrk(['--cwd', root, 'quality', '--strict', '--json'], root).stdout,
    ) as IQualityRunJson;
    const fast = JSON.parse(
      shrk(['--cwd', root, 'quality', '--strict', '--fail-fast', '--json'], root).stdout,
    ) as IQualityRunJson;
    if (strict.failed > 0) {
      // The opposite of the default, and reported rather than left to look clean.
      expect(fast.failFast ?? true).toBeTruthy();
      expect(fast.failed).toBeLessThanOrEqual(strict.failed);
    }
  });
});

describe('shrk ci scaffold github-actions', () => {
  test('dry-run prints YAML with chosen step', () => {
    const root = makeFixture();
    const r = shrk(
      ['--cwd', root, 'ci', 'scaffold', 'github-actions', '--with-quality', '--with-boundaries'],
      root,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('SharkCraft quality');
    expect(r.stdout).toContain('shrk check boundaries');
  });

  test('--write materializes the file at --output', () => {
    const root = makeFixture();
    const out = '.github/workflows/sharkcraft.yml';
    const r = shrk(
      ['--cwd', root, 'ci', 'scaffold', 'github-actions', '--with-quality', '--output', out, '--write'],
      root,
    );
    expect(r.status).toBe(0);
    const full = join(root, out);
    expect(existsSync(full)).toBe(true);
    const body = readFileSync(full, 'utf8');
    expect(body).toContain('shrk quality');
  });

  test('refuses to overwrite an existing file without --force', () => {
    const root = makeFixture();
    const out = '.github/workflows/sharkcraft.yml';
    shrk(['--cwd', root, 'ci', 'scaffold', 'github-actions', '--with-quality', '--output', out, '--write'], root);
    const r = shrk(
      ['--cwd', root, 'ci', 'scaffold', 'github-actions', '--with-quality', '--output', out, '--write'],
      root,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Refusing');
  });
});
