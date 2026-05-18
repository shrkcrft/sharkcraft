/**
 * CLI surface tests.
 *
 * Covers:
 *   - `shrk inspect` Detected block (workspace flavor, configs, recommended preset).
 *   - `shrk inspect --no-config` keeps the Detected block, suppresses missing-folder warnings.
 *   - `shrk init --zero-config` picks the canonical preset for each TS stack fixture.
 *   - `shrk presets explain <id>` returns composition chain + appliesTo natural language.
 *   - `shrk eslint rules` + `shrk eslint explain-limitations` return the bridge inventory.
 *   - `shrk biome report` + `shrk biome explain-limitations`.
 *   - `shrk checks import / aggregate / report / convert` round-trip ESLint JSON.
 * - CI scaffold quickstart prints the "exact path / next command / Explanation of gates" block.
 *   - `shrk doctor --no-config` returns exit code 0 on a no-sharkcraft repo.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { inspectCommand } from '../commands/inspect.command.ts';
import { initCommand } from '../commands/init.command.ts';
import { doctorCommand } from '../commands/doctor.command.ts';
import {
  presetsExplainCommand,
} from '../commands/presets.command.ts';
import { eslintCommand } from '../commands/eslint.command.ts';
import { biomeCommand } from '../commands/biome.command.ts';
import {
  checksImportCommand,
  checksAggregateCommand,
  checksReportCommand,
  checksConvertCommand,
} from '../commands/checks.command.ts';
import { ciCommand } from '../commands/ci.command.ts';

let tmpRoot = '';

beforeAll(() => {
  tmpRoot = mkdtempSync(nodePath.join(tmpdir(), 'shrk-r47-'));
});

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

function makeFixture(name: string, files: Record<string, string>, dirs: string[] = []): string {
  const dir = nodePath.join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  for (const sub of dirs) mkdirSync(nodePath.join(dir, sub), { recursive: true });
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

function flags(entries: [string, string | boolean][]): Map<string, string | boolean> {
  return new Map<string, string | boolean>(entries);
}

describe('adoption top-5', () => {
  describe('inspect: Detected block', () => {
    test('reports workspace flavor, configs, and recommended preset for a Next.js fixture', async () => {
      const dir = makeFixture(
        'inspect-next',
        {
          'package.json': JSON.stringify({
            name: 'inspect-next',
            version: '0.1.0',
            dependencies: { next: '14.0.0', react: '18.0.0' },
            devDependencies: { typescript: '5.0.0', eslint: '9.0.0' },
          }),
          'tsconfig.json': '{"compilerOptions":{"strict":true}}',
        },
        ['src', '.github/workflows'],
      );
      const result = await captureStdout(() =>
        inspectCommand.run({
          positional: [],
          flags: flags([['cwd', dir]]),
          multiFlags: new Map(),
        }),
      );
      expect(result.exit).toBe(0);
      expect(result.out).toContain('=== Detected ===');
      expect(result.out).toContain('workspace flavor');
      expect(result.out).toContain('single package');
      expect(result.out).toContain('recommended preset   next-app');
      expect(result.out).toContain('configs');
      // No sharkcraft folder — next step pointer is the zero-config init.
      expect(result.out).toContain('shrk init --zero-config');
    });

    test('--no-config suppresses the "No sharkcraft/ folder found" warning', async () => {
      const dir = makeFixture('inspect-noconfig', {
        'package.json': JSON.stringify({ name: 'noconfig', version: '0.1.0' }),
      });
      const result = await captureStdout(() =>
        inspectCommand.run({
          positional: [],
          flags: flags([
            ['cwd', dir],
            ['no-config', true],
          ]),
          multiFlags: new Map(),
        }),
      );
      expect(result.exit).toBe(0);
      // The Detected block is still printed.
      expect(result.out).toContain('=== Detected ===');
      // The canonical missing-folder warning is filtered.
      expect(result.out).not.toContain('No sharkcraft/ folder found');
    });
  });

  describe('init --zero-config: canonical preset auto-pick per stack', () => {
    test('typescript-library for a strict TS library fixture', async () => {
      const dir = makeFixture('init-tslib', {
        'package.json': JSON.stringify({
          name: 'tslib',
          version: '0.1.0',
          main: 'dist/index.js',
          types: 'dist/index.d.ts',
          devDependencies: { typescript: '5.0.0' },
        }),
        'tsconfig.json': '{"compilerOptions":{"strict":true}}',
      });
      const result = await captureStdout(() =>
        initCommand.run({
          positional: [],
          flags: flags([
            ['cwd', dir],
            ['zero-config', true],
          ]),
          multiFlags: new Map(),
        }),
      );
      expect(result.exit).toBe(0);
      expect(result.out).toContain('Picked preset: typescript-library');
      // Detected block surfaces in the dry-run.
      expect(result.out).toContain('=== Detected ===');
    });

    test('react-app for a React-only repo (NOT next-app)', async () => {
      const dir = makeFixture('init-react', {
        'package.json': JSON.stringify({
          name: 'react-only',
          version: '0.1.0',
          dependencies: { react: '18.0.0', 'react-dom': '18.0.0' },
          devDependencies: { typescript: '5.0.0', vite: '5.0.0' },
        }),
        'tsconfig.json': '{"compilerOptions":{"strict":true}}',
      });
      const result = await captureStdout(() =>
        initCommand.run({
          positional: [],
          flags: flags([
            ['cwd', dir],
            ['zero-config', true],
          ]),
          multiFlags: new Map(),
        }),
      );
      expect(result.exit).toBe(0);
      // Critical: the recommender miss-penalty must keep next-app from
      // dominating a React-only repo just because of its higher base weight.
      expect(result.out).toContain('Picked preset: react-app');
      expect(result.out).not.toContain('Picked preset: next-app');
    });

    test('nest-service (canonical alias) for a NestJS service fixture', async () => {
      const dir = makeFixture(
        'init-nest',
        {
          'package.json': JSON.stringify({
            name: 'nest',
            version: '0.1.0',
            // Crucial: no `main` field — `main` triggers is-library and
            // disqualifies is-service in the profile detector.
            dependencies: {
              '@nestjs/core': '10.0.0',
              '@nestjs/common': '10.0.0',
            },
            scripts: { start: 'nest start', build: 'nest build' },
            devDependencies: { typescript: '5.0.0', jest: '29.0.0' },
          }),
          'tsconfig.json': '{"compilerOptions":{"strict":true}}',
        },
        ['src'],
      );
      const result = await captureStdout(() =>
        initCommand.run({
          positional: [],
          flags: flags([
            ['cwd', dir],
            ['zero-config', true],
          ]),
          multiFlags: new Map(),
        }),
      );
      expect(result.exit).toBe(0);
      expect(result.out).toContain('Picked preset: nest-service');
    });

    test('nx-monorepo for an Nx workspace fixture', async () => {
      const dir = makeFixture(
        'init-nx',
        {
          'package.json': JSON.stringify({
            name: 'nx-fixture',
            version: '0.1.0',
            workspaces: ['apps/*', 'libs/*'],
            devDependencies: { nx: '18.0.0', typescript: '5.0.0' },
          }),
          'nx.json': '{"$schema":"./node_modules/nx/schemas/nx-schema.json"}',
          'tsconfig.base.json': '{"compilerOptions":{"strict":true}}',
        },
        ['apps', 'libs'],
      );
      const result = await captureStdout(() =>
        initCommand.run({
          positional: [],
          flags: flags([
            ['cwd', dir],
            ['zero-config', true],
          ]),
          multiFlags: new Map(),
        }),
      );
      expect(result.exit).toBe(0);
      expect(result.out).toContain('Picked preset: nx-monorepo');
    });
  });

  describe('presets: aliases + explain verb', () => {
    test('presets explain nest-service returns the composition chain', async () => {
      const dir = makeFixture('presets-explain-nest', {
        'package.json': JSON.stringify({ name: 'x', version: '0.1.0' }),
      });
      const result = await captureStdout(() =>
        presetsExplainCommand.run({
          positional: ['nest-service'],
          flags: flags([['cwd', dir]]),
          multiFlags: new Map(),
        }),
      );
      expect(result.exit).toBe(0);
      expect(result.out).toContain('Preset explain: nest-service');
      expect(result.out).toContain('Composed from');
      expect(result.out).toContain('nestjs-service');
      expect(result.out).toContain('uses NestJS');
    });

    test('presets explain angular-app surfaces the appliesTo natural-language clauses', async () => {
      const dir = makeFixture('presets-explain-angular', {
        'package.json': JSON.stringify({ name: 'x', version: '0.1.0' }),
      });
      const result = await captureStdout(() =>
        presetsExplainCommand.run({
          positional: ['angular-app'],
          flags: flags([['cwd', dir]]),
          multiFlags: new Map(),
        }),
      );
      expect(result.exit).toBe(0);
      expect(result.out).toContain('uses Angular');
      expect(result.out).toContain('modern-angular');
    });
  });

  describe('eslint: rules + explain-limitations', () => {
    test('eslint rules emits bridgeable/adjacent/not-bridgeable buckets', async () => {
      const dir = makeFixture('eslint-rules-empty', {
        'package.json': JSON.stringify({ name: 'e', version: '0.1.0' }),
      });
      const result = await captureStdout(() =>
        eslintCommand.run({
          positional: ['rules'],
          flags: flags([['cwd', dir]]),
          multiFlags: new Map(),
        }),
      );
      expect(result.exit).toBe(0);
      expect(result.out).toContain('ESLint bridge inventory');
      expect(result.out).toContain('[not-bridgeable]');
      expect(result.out).toContain('plan-signing');
    });

    test('eslint explain-limitations prints the honest list', async () => {
      const dir = makeFixture('eslint-explain', {
        'package.json': JSON.stringify({ name: 'e', version: '0.1.0' }),
      });
      const result = await captureStdout(() =>
        eslintCommand.run({
          positional: ['explain-limitations'],
          flags: flags([['cwd', dir]]),
          multiFlags: new Map(),
        }),
      );
      expect(result.exit).toBe(0);
      expect(result.out).toContain('What the bridge **cannot** express');
      expect(result.out).toContain('Plan safety');
    });
  });

  describe('biome: report + explain-limitations', () => {
    test('biome report converts boundary JSON to a Biome-adjacent shape', async () => {
      const dir = makeFixture('biome-report', {
        'boundaries.json': JSON.stringify({
          violations: [
            {
              source: '@x/a',
              target: '@x/b',
              reason: 'cross-layer',
              file: 'src/x.ts',
              line: 12,
            },
          ],
        }),
      });
      const result = await captureStdout(() =>
        biomeCommand.run({
          positional: ['report'],
          flags: flags([
            ['cwd', dir],
            ['from', 'boundaries.json'],
          ]),
          multiFlags: new Map(),
        }),
      );
      // Violations present → exit 1.
      expect(result.exit).toBe(1);
      const parsed = JSON.parse(result.out);
      expect(parsed.schema).toBe('sharkcraft.biome-adjacent/v1');
      expect(parsed.diagnostics[0]).toMatchObject({
        category: 'sharkcraft/boundary-violation',
        severity: 'error',
        location: { line: 12 },
      });
    });

    test('biome explain-limitations lists what cannot be bridged', async () => {
      const dir = makeFixture('biome-explain', {
        'package.json': JSON.stringify({ name: 'b', version: '0.1.0' }),
      });
      const result = await captureStdout(() =>
        biomeCommand.run({
          positional: ['explain-limitations'],
          flags: flags([['cwd', dir]]),
          multiFlags: new Map(),
        }),
      );
      expect(result.exit).toBe(0);
      expect(result.out).toContain('cross-layer / cross-package boundary rules');
      expect(result.out).toContain('Plan safety');
    });
  });

  describe('checks: universal protocol round-trip', () => {
    test('checks convert eslint emits sharkcraft.check-result/v1 JSON', async () => {
      const dir = makeFixture('checks-convert', {
        'eslint.json': JSON.stringify([
          {
            filePath: '/tmp/file.ts',
            messages: [
              {
                ruleId: 'no-unused-vars',
                severity: 2,
                message: 'y is defined but never used',
                line: 3,
                column: 7,
              },
            ],
            errorCount: 1,
            warningCount: 0,
          },
        ]),
      });
      const result = await captureStdout(() =>
        checksConvertCommand.run({
          positional: ['eslint', 'eslint.json'],
          flags: flags([['cwd', dir]]),
          multiFlags: new Map(),
        }),
      );
      // Has errors → exit 1.
      expect(result.exit).toBe(1);
      const parsed = JSON.parse(result.out);
      expect(parsed.schema).toBe('sharkcraft.check-result/v1');
      expect(parsed.tool).toBe('eslint');
      expect(parsed.status).toBe('fail');
      expect(parsed.findings).toHaveLength(1);
      expect(parsed.findings[0]).toMatchObject({
        severity: 'error',
        ruleId: 'no-unused-vars',
        line: 3,
      });
    });

    test('checks import + aggregate roll up to fail when any input has errors', async () => {
      const dir = makeFixture('checks-roundtrip', {
        'eslint.json': JSON.stringify([
          {
            filePath: '/tmp/file.ts',
            messages: [
              {
                ruleId: 'rule-x',
                severity: 2,
                message: 'broken',
                line: 1,
                column: 1,
              },
            ],
            errorCount: 1,
            warningCount: 0,
          },
        ]),
      });
      const importResult = await captureStdout(() =>
        checksImportCommand.run({
          positional: ['eslint.json'],
          flags: flags([
            ['cwd', dir],
            ['as', 'eslint'],
          ]),
          multiFlags: new Map(),
        }),
      );
      expect(importResult.exit).toBe(1);
      expect(existsSync(nodePath.join(dir, '.sharkcraft', 'checks'))).toBe(true);

      const aggregateResult = await captureStdout(() =>
        checksAggregateCommand.run({
          positional: [],
          flags: flags([['cwd', dir]]),
          multiFlags: new Map(),
        }),
      );
      expect(aggregateResult.exit).toBe(1);
      expect(aggregateResult.out).toContain('Check aggregate (fail)');
      expect(aggregateResult.out).toContain('eslint');
    });

    test('checks aggregate on an empty .sharkcraft/checks/ returns unknown (not pass)', async () => {
      const dir = makeFixture('checks-empty', {
        'package.json': JSON.stringify({ name: 'x', version: '0.1.0' }),
      });
      const result = await captureStdout(() =>
        checksAggregateCommand.run({
          positional: [],
          flags: flags([['cwd', dir]]),
          multiFlags: new Map(),
        }),
      );
      expect(result.exit).toBe(0);
      expect(result.out).toContain('Check aggregate (unknown)');
    });

    test('checks report --format markdown renders a markdown table', async () => {
      const dir = makeFixture('checks-report-md', {
        '.sharkcraft/checks/aggregate.json': JSON.stringify({
          schema: 'sharkcraft.check-aggregate/v1',
          generatedAt: '2026-05-16T00:00:00.000Z',
          overall: 'warn',
          total: { errors: 0, warnings: 2, infos: 0, total: 2 },
          entries: [
            {
              tool: 'eslint',
              status: 'warn',
              summary: { errors: 0, warnings: 2, infos: 0, total: 2 },
              sourceReportPath: '/abs/source.json',
            },
          ],
          findings: [],
        }),
      });
      const result = await captureStdout(() =>
        checksReportCommand.run({
          positional: [],
          flags: flags([
            ['cwd', dir],
            ['format', 'markdown'],
          ]),
          multiFlags: new Map(),
        }),
      );
      expect(result.exit).toBe(0);
      expect(result.out).toContain('# Check aggregate');
      expect(result.out).toContain('| Tool | Status | Errors | Warnings | Source |');
      expect(result.out).toContain('| `eslint` | warn |');
    });
  });

  describe('CI scaffold: quickstart annotations', () => {
    test('quickstart dry-run prints exact path, next command, and gates block', async () => {
      const dir = makeFixture('ci-quickstart', {
        'package.json': JSON.stringify({ name: 'q', version: '0.1.0' }),
      });
      const result = await captureStdout(() =>
        ciCommand.run({
          positional: ['scaffold', 'github-actions'],
          flags: flags([
            ['cwd', dir],
            ['quickstart', true],
          ]),
          multiFlags: new Map(),
        }),
      );
      expect(result.exit).toBe(0);
      expect(result.out).toContain('exact path');
      expect(result.out).toContain('next command');
      expect(result.out).toContain('shrk ci scaffold github-actions --quickstart --write');
      expect(result.out).toContain('=== Explanation of gates ===');
      expect(result.out).toContain('check boundaries --changed-only');
    });
  });

  describe('doctor: --no-config lenience', () => {
    test('exit code stays 0 on a repo with no sharkcraft/', async () => {
      const dir = makeFixture('doctor-noconfig', {
        'package.json': JSON.stringify({ name: 'd', version: '0.1.0' }),
      });
      const result = await captureStdout(() =>
        doctorCommand.run({
          positional: [],
          flags: flags([
            ['cwd', dir],
            ['no-config', true],
          ]),
          multiFlags: new Map(),
        }),
      );
      expect(result.exit).toBe(0);
      expect(result.out).toContain('--no-config mode');
    });
  });
});
