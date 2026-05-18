/**
 * Phase 3 bridge tests.
 * Covers `shrk eslint scaffold|report` and `shrk biome scaffold`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { eslintCommand } from '../commands/eslint.command.ts';
import { biomeCommand } from '../commands/biome.command.ts';

let tmpRoot = '';

beforeAll(() => {
  tmpRoot = mkdtempSync(nodePath.join(tmpdir(), 'shrk-r45-bridge-'));
});

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

function makeFixture(name: string, files: Record<string, string>): string {
  const dir = nodePath.join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = nodePath.join(dir, rel);
    mkdirSync(nodePath.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

async function captureStdout(
  fn: () => Promise<number> | number,
): Promise<{ exit: number; out: string }> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout.write as unknown) = (c: any): boolean => {
    chunks.push(typeof c === 'string' ? c : c.toString('utf8'));
    return true;
  };
  try {
    const exit = await fn();
    return { exit, out: chunks.join('') };
  } finally {
    (process.stdout.write as unknown) = orig;
  }
}

describe('ESLint bridge', () => {
  test('eslint scaffold dry-run emits a flat-config snippet with ignores + boundary note', async () => {
    const dir = makeFixture('eslint-scaffold-empty', {
      'package.json': JSON.stringify({ name: 'e', version: '0.1.0' }),
    });
    const result = await captureStdout(() =>
      eslintCommand.run({
        positional: ['scaffold'],
        flags: new Map<string, string | boolean>([['cwd', dir]]),
        multiFlags: new Map(),
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.out).toContain('ESLint scaffold — dry-run');
    expect(result.out).toContain('export default');
    expect(result.out).toContain('ignores');
    expect(result.out).toContain('shrk check boundaries');
  });

  test('eslint report converts boundaries.json to the ESLint result format (JSON)', async () => {
    const dir = makeFixture('eslint-report-fixture', {
      'boundaries.json': JSON.stringify({
        violations: [
          {
            source: '@x/a',
            target: '@x/b',
            reason: 'cross-feature',
            file: 'src/a.ts',
            line: 9,
            column: 2,
          },
        ],
      }),
    });

    const result = await captureStdout(() =>
      eslintCommand.run({
        positional: ['report'],
        flags: new Map<string, string | boolean>([
          ['cwd', dir],
          ['from', 'boundaries.json'],
          ['json', true],
        ]),
        multiFlags: new Map(),
      }),
    );

    // Violations present → non-zero exit.
    expect(result.exit).toBe(1);
    const parsed = JSON.parse(result.out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toMatchObject({
      messages: [
        {
          ruleId: 'sharkcraft/boundary-violation',
          severity: 2,
          line: 9,
          column: 2,
        },
      ],
      errorCount: 1,
    });
  });

  test('eslint report exits 0 and reports "no violations" for an empty boundary report', async () => {
    const dir = makeFixture('eslint-report-empty', {
      'boundaries.json': JSON.stringify({ violations: [] }),
    });
    const result = await captureStdout(() =>
      eslintCommand.run({
        positional: ['report'],
        flags: new Map<string, string | boolean>([
          ['cwd', dir],
          ['from', 'boundaries.json'],
        ]),
        multiFlags: new Map(),
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.out).toContain('no violations');
  });
});

describe('Biome bridge', () => {
  test('biome scaffold dry-run emits a JSON config with linter + organizeImports + ignores', async () => {
    const dir = makeFixture('biome-scaffold-empty', {
      'package.json': JSON.stringify({ name: 'b', version: '0.1.0' }),
    });
    const result = await captureStdout(() =>
      biomeCommand.run({
        positional: ['scaffold'],
        flags: new Map<string, string | boolean>([['cwd', dir]]),
        multiFlags: new Map(),
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.out).toContain('Biome scaffold — dry-run');
    expect(result.out).toContain('"linter"');
    expect(result.out).toContain('"organizeImports"');
    expect(result.out).toContain('shrk check boundaries');
  });
});
