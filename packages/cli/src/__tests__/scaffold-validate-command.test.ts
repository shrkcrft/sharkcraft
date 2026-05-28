import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffoldValidateCommand } from '../commands/scaffold-validate.command.ts';
import type { ParsedArgs } from '../command-registry.ts';

let tempRepo = '';

beforeEach(() => {
  tempRepo = mkdtempSync(join(tmpdir(), 'shrk-scaffold-validate-'));
});

afterEach(() => {
  rmSync(tempRepo, { recursive: true, force: true });
});

const writeOut = process.stdout.write.bind(process.stdout);
const writeErr = process.stderr.write.bind(process.stderr);

async function captureStdio<T>(fn: () => T | Promise<T>): Promise<{ value: T; stdout: string; stderr: string }> {
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

function makeArgs(positional: string[], flags: Array<[string, string | boolean]>): ParsedArgs {
  return {
    positional,
    flags: new Map<string, string | boolean>(flags),
    multiFlags: new Map<string, string[]>(),
  };
}

function writePlan(planPath: string, plan: object): void {
  mkdirSync(join(planPath, '..'), { recursive: true });
  writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n', 'utf8');
}

describe('shrk scaffold-validate', () => {
  test('exits 2 with usage when no plan file is given', async () => {
    const { value, stderr } = await captureStdio(() =>
      scaffoldValidateCommand.run(makeArgs([], [['cwd', tempRepo]])),
    );
    expect(value).toBe(2);
    expect(stderr).toContain('Usage: shrk scaffold-validate');
  });

  test('exits 1 when the plan file does not exist', async () => {
    const { value, stderr } = await captureStdio(() =>
      scaffoldValidateCommand.run(makeArgs(['no-such.json'], [['cwd', tempRepo]])),
    );
    expect(value).toBe(1);
    expect(stderr).toContain('Plan file not found');
  });

  test('reports compliant + missing files correctly', async () => {
    const planPath = join(tempRepo, '.sharkcraft/plans/sample.json');
    writeFileSync(join(tempRepo, 'created.ts'), 'export const a = 1;\n');
    writePlan(planPath, {
      schema: 'sharkcraft.plan/v1',
      templateId: 't1',
      variables: {},
      projectRoot: tempRepo,
      createdAt: new Date().toISOString(),
      expectedChanges: [
        { type: 'create', relativePath: 'created.ts', sizeBytes: 20 },
        { type: 'create', relativePath: 'missing.ts', sizeBytes: 100 },
      ],
    });
    const { value, stdout } = await captureStdio(() =>
      scaffoldValidateCommand.run(
        makeArgs([planPath], [['cwd', tempRepo], ['json', true]]),
      ),
    );
    expect(value).toBe(1); // failed because one is missing
    const parsed = JSON.parse(stdout) as {
      totals: { compliant: number; missing: number };
      findings: Array<{ relativePath: string; status: string }>;
      status: string;
    };
    expect(parsed.totals.compliant).toBe(1);
    expect(parsed.totals.missing).toBe(1);
    expect(parsed.status).toBe('failed');
    expect(parsed.findings.find((f) => f.relativePath === 'created.ts')?.status).toBe('compliant');
    expect(parsed.findings.find((f) => f.relativePath === 'missing.ts')?.status).toBe('missing');
  });

  test('flags files that shrank past the tolerance', async () => {
    const planPath = join(tempRepo, '.sharkcraft/plans/sample.json');
    writeFileSync(join(tempRepo, 'tiny.ts'), 'x'); // 1 byte
    writePlan(planPath, {
      schema: 'sharkcraft.plan/v1',
      templateId: 't1',
      variables: {},
      projectRoot: tempRepo,
      createdAt: new Date().toISOString(),
      expectedChanges: [{ type: 'create', relativePath: 'tiny.ts', sizeBytes: 500 }],
    });
    const { value, stdout } = await captureStdio(() =>
      scaffoldValidateCommand.run(
        makeArgs([planPath], [
          ['cwd', tempRepo],
          ['json', true],
          ['shrink-tolerance', '0.25'],
        ]),
      ),
    );
    expect(value).toBe(0); // shrink is a warning, not failure
    const parsed = JSON.parse(stdout) as { totals: { shrunk: number }; status: string };
    expect(parsed.totals.shrunk).toBe(1);
    expect(parsed.status).toBe('partial');
  });

  test('compliance: file present at the expected size envelope', async () => {
    const planPath = join(tempRepo, '.sharkcraft/plans/sample.json');
    const body = Array.from({ length: 200 }, () => 'export const x = 1;\n').join('');
    writeFileSync(join(tempRepo, 'big.ts'), body);
    writePlan(planPath, {
      schema: 'sharkcraft.plan/v1',
      templateId: 't1',
      variables: {},
      projectRoot: tempRepo,
      createdAt: new Date().toISOString(),
      expectedChanges: [{ type: 'create', relativePath: 'big.ts', sizeBytes: body.length }],
    });
    const { value, stdout } = await captureStdio(() =>
      scaffoldValidateCommand.run(
        makeArgs([planPath], [['cwd', tempRepo], ['json', true]]),
      ),
    );
    expect(value).toBe(0);
    const parsed = JSON.parse(stdout) as { status: string; totals: { compliant: number } };
    expect(parsed.status).toBe('ok');
    expect(parsed.totals.compliant).toBe(1);
  });

  test('delete plan: passes when file is gone, fails when still present', async () => {
    const planPath = join(tempRepo, '.sharkcraft/plans/sample.json');
    writePlan(planPath, {
      schema: 'sharkcraft.plan/v1',
      templateId: 't1',
      variables: {},
      projectRoot: tempRepo,
      createdAt: new Date().toISOString(),
      expectedChanges: [{ type: 'delete', relativePath: 'gone.ts', sizeBytes: 0 }],
    });
    // file is absent → compliant
    const r1 = await captureStdio(() =>
      scaffoldValidateCommand.run(makeArgs([planPath], [['cwd', tempRepo], ['json', true]])),
    );
    expect(r1.value).toBe(0);
    // file is present → unexpected-type
    writeFileSync(join(tempRepo, 'gone.ts'), 'still here\n');
    const r2 = await captureStdio(() =>
      scaffoldValidateCommand.run(makeArgs([planPath], [['cwd', tempRepo], ['json', true]])),
    );
    expect(r2.value).toBe(1);
    const parsed = JSON.parse(r2.stdout) as { totals: { unexpectedType: number } };
    expect(parsed.totals.unexpectedType).toBe(1);
  });
});
