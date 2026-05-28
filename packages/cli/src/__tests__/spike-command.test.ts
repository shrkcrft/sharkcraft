import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spikeCommand } from '../commands/spike.command.ts';
import type { ParsedArgs } from '../command-registry.ts';

let tempRepo = '';

beforeEach(() => {
  tempRepo = mkdtempSync(join(tmpdir(), 'shrk-spike-'));
});

afterEach(() => {
  rmSync(tempRepo, { recursive: true, force: true });
});

function makeArgs(positional: string[], flags: Array<[string, string | boolean]>): ParsedArgs {
  return {
    positional,
    flags: new Map<string, string | boolean>(flags),
    multiFlags: new Map<string, string[]>(),
  };
}

const writeOut = process.stdout.write.bind(process.stdout);
const writeErr = process.stderr.write.bind(process.stderr);

async function captureStdio<T>(
  fn: () => T | Promise<T>,
): Promise<{ value: T; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  (process.stdout.write as unknown as (s: string) => boolean) = ((s: string) => {
    stdout += s;
    return true;
  }) as never;
  (process.stderr.write as unknown as (s: string) => boolean) = ((s: string) => {
    stderr += s;
    return true;
  }) as never;
  try {
    const value = await Promise.resolve(fn());
    return { value, stdout, stderr };
  } finally {
    process.stdout.write = writeOut as never;
    process.stderr.write = writeErr as never;
  }
}

function seedPlan(slug: string, plan: Record<string, unknown>): void {
  const dir = join(tempRepo, '.sharkcraft/smart-context');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.plan.json`), JSON.stringify(plan, null, 2), 'utf8');
}

describe('shrk spike', () => {
  test('exits 2 with usage when no slug is supplied', async () => {
    const { value, stderr } = await captureStdio(() =>
      spikeCommand.run(makeArgs([], [['cwd', tempRepo]])),
    );
    expect(value).toBe(2);
    expect(stderr).toContain('Usage: shrk spike');
  });

  test('exits 1 with a hint when no saved plan matches the slug', async () => {
    const { value, stderr } = await captureStdio(() =>
      spikeCommand.run(makeArgs(['no-such-slug'], [['cwd', tempRepo]])),
    );
    expect(value).toBe(1);
    expect(stderr).toContain('no-such-slug');
    expect(stderr).toContain('smart-context');
  });

  test('--dry-run reports files that would be created without writing them', async () => {
    seedPlan('a-plan', {
      task: 'add ctx feed',
      summary: 'Wire a watch-mode CLI',
      recommendedMvp: { architectureName: 'Watch-Mode CLI' },
      firstSpike: {
        proposedCommand: 'shrk context-feed start',
        proposedFiles: [
          { path: 'packages/cli/src/commands/context-feed.command.ts', purpose: 'CLI command' },
          { path: '.sharkcraft/feeds/README.md', purpose: 'Notes' },
        ],
        successCriteria: ['Outputs a packet every 5s'],
      },
    });

    const { value, stdout } = await captureStdio(() =>
      spikeCommand.run(
        makeArgs(['a-plan'], [
          ['cwd', tempRepo],
          ['dry-run', true],
        ]),
      ),
    );
    expect(value).toBe(0);
    expect(stdout).toContain('would be created');
    expect(stdout).toContain('packages/cli/src/commands/context-feed.command.ts');
    expect(stdout).toContain('.sharkcraft/feeds/README.md');
    expect(stdout).toContain('shrk context-feed start');
    expect(existsSync(join(tempRepo, 'packages/cli/src/commands/context-feed.command.ts'))).toBe(false);
    expect(existsSync(join(tempRepo, '.sharkcraft/feeds/README.md'))).toBe(false);
  });

  test('without --dry-run creates each proposed file with a starter header', async () => {
    seedPlan('b-plan', {
      task: 'build it',
      summary: 'Spike for build',
      firstSpike: {
        proposedFiles: [{ path: 'packages/cli/src/commands/foo.command.ts', purpose: 'foo cmd' }],
      },
    });
    const { value } = await captureStdio(() =>
      spikeCommand.run(makeArgs(['b-plan'], [['cwd', tempRepo]])),
    );
    expect(value).toBe(0);
    const file = join(tempRepo, 'packages/cli/src/commands/foo.command.ts');
    expect(existsSync(file)).toBe(true);
    const body = readFileSync(file, 'utf8');
    expect(body).toContain('Spike scaffold');
    expect(body).toContain('Purpose: foo cmd');
    expect(body).toContain('TODO(spike): implement.');
    expect(body).toContain('export {};');
  });

  test('skips files that already exist (never overwrites)', async () => {
    seedPlan('c-plan', {
      firstSpike: { proposedFiles: [{ path: 'src/existing.ts' }] },
    });
    mkdirSync(join(tempRepo, 'src'), { recursive: true });
    const existingPath = join(tempRepo, 'src/existing.ts');
    writeFileSync(existingPath, 'export const original = true;\n', 'utf8');

    const { value, stdout } = await captureStdio(() =>
      spikeCommand.run(makeArgs(['c-plan'], [['cwd', tempRepo]])),
    );
    expect(value).toBe(0);
    expect(stdout).toContain('Skipped (already exist)');
    expect(stdout).toContain('src/existing.ts');
    // File was not overwritten.
    expect(readFileSync(existingPath, 'utf8')).toBe('export const original = true;\n');
  });

  test('refuses placeholder paths like <timestamp>.json and paths that escape cwd', async () => {
    seedPlan('d-plan', {
      firstSpike: {
        proposedFiles: [
          { path: '.sharkcraft/feeds/<timestamp>.json' },
          { path: '../../../etc/passwd' },
        ],
      },
    });
    const { value, stdout } = await captureStdio(() =>
      spikeCommand.run(makeArgs(['d-plan'], [['cwd', tempRepo]])),
    );
    expect(value).toBe(0);
    expect(stdout).toContain('Skipped (unsafe)');
    expect(stdout).toContain('placeholder syntax');
    expect(stdout).toContain('escapes workspace');
    // No files created in the workspace.
    expect(existsSync(join(tempRepo, '.sharkcraft/feeds'))).toBe(false);
  });

  test('--json mode returns a structured report', async () => {
    seedPlan('e-plan', {
      firstSpike: {
        proposedCommand: 'shrk x',
        proposedFiles: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
      },
    });
    mkdirSync(join(tempRepo, 'src'), { recursive: true });
    writeFileSync(join(tempRepo, 'src/b.ts'), '', 'utf8'); // pre-existing

    const { value, stdout } = await captureStdio(() =>
      spikeCommand.run(
        makeArgs(['e-plan'], [
          ['cwd', tempRepo],
          ['json', true],
          ['dry-run', true],
        ]),
      ),
    );
    expect(value).toBe(0);
    const parsed = JSON.parse(stdout) as {
      created: string[];
      skippedExisting: string[];
      proposedCommand: string;
    };
    expect(parsed.created).toEqual(['src/a.ts']);
    expect(parsed.skippedExisting).toEqual(['src/b.ts']);
    expect(parsed.proposedCommand).toBe('shrk x');
  });
});
