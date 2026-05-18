/**
 * `ide project`, `ide symbol`, `impact --plan-format codemod`.
 *
 * Smokes the JSON shapes and exit codes for the new IDE data surface
 * and the codemod-handoff plan. These run against the repo itself (the
 * SharkCraft workspace) so they validate end-to-end behaviour, not
 * just data-model unit tests.
 */
import { describe, expect, test } from 'bun:test';
import { ideProjectCommand, ideSymbolCommand } from '../commands/ide.command.ts';
import { impactCommand } from '../commands/impact.command.ts';

async function capture(
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

describe('shrk ide project --json', () => {
  test('emits the v1 schema with workspace + doctor + signatureStatus', async () => {
    const { exit, out } = await capture(() =>
      ideProjectCommand.run({
        positional: [],
        flags: new Map<string, string | boolean>([
          ['cwd', process.cwd()],
          ['json', true],
        ]),
        multiFlags: new Map(),
      }),
    );
    expect(exit).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.schema).toBe('sharkcraft.ide.project/v1');
    expect(parsed.workspace).toBeDefined();
    expect(parsed.workspace.profiles).toBeInstanceOf(Array);
    expect(parsed.doctor).toBeDefined();
    expect(typeof parsed.doctor.passed).toBe('boolean');
    expect(parsed.signatureStatus).toBeDefined();
    expect(typeof parsed.signatureStatus.total).toBe('number');
    expect(typeof parsed.signatureStatus.dev).toBe('number');
    expect(parsed.suggestedCommands).toContain('shrk doctor');
  });
});

describe('shrk ide symbol <name> --json', () => {
  test('emits the v1 schema for an unknown symbol with notes', async () => {
    const { exit, out } = await capture(() =>
      ideSymbolCommand.run({
        positional: ['ThereIsNoSymbolWithThisName12345'],
        flags: new Map<string, string | boolean>([
          ['cwd', process.cwd()],
          ['json', true],
        ]),
        multiFlags: new Map(),
      }),
    );
    expect(exit).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.schema).toBe('sharkcraft.ide.symbol/v1');
    expect(parsed.symbol).toBe('ThereIsNoSymbolWithThisName12345');
    expect(parsed.references).toEqual([]);
    expect(parsed.suggestedCommands).toContain(
      'shrk impact --symbol ThereIsNoSymbolWithThisName12345',
    );
    expect(parsed.notes).toContain('no anchors / rules reference this symbol');
  });

  test('requires <name> positional', async () => {
    const { exit } = await capture(() =>
      ideSymbolCommand.run({
        positional: [],
        flags: new Map<string, string | boolean>([['cwd', process.cwd()]]),
        multiFlags: new Map(),
      }),
    );
    expect(exit).toBe(2);
  });
});

describe('shrk impact --plan-format', () => {
  test('emits the codemod-plan schema with stable fields', async () => {
    const { exit, out } = await capture(() =>
      impactCommand.run({
        positional: ['packages/cli/src/main.ts'],
        flags: new Map<string, string | boolean>([
          ['cwd', process.cwd()],
          ['plan-format', 'codemod'],
        ]),
        multiFlags: new Map(),
      }),
    );
    expect(exit).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.schema).toBe('sharkcraft.codemod-plan/v1');
    expect(parsed.format).toBe('codemod');
    expect(parsed.codemodStarterMetadata.dialect).toBe('codemod');
    expect(parsed.codemodStarterMetadata.starterPath).toBeNull();
    expect(parsed.suggestedOperationCategories).toContain('rename');
    expect(parsed.testRecommendations).toContain('bun test');
  });

  test('rejects an unknown plan-format', async () => {
    const { exit } = await capture(() =>
      impactCommand.run({
        positional: ['packages/cli/src/main.ts'],
        flags: new Map<string, string | boolean>([
          ['cwd', process.cwd()],
          ['plan-format', 'nonsense'],
        ]),
        multiFlags: new Map(),
      }),
    );
    expect(exit).toBe(2);
  });

  test('ts-morph dialect changes starter metadata', async () => {
    const { exit, out } = await capture(() =>
      impactCommand.run({
        positional: ['packages/cli/src/main.ts'],
        flags: new Map<string, string | boolean>([
          ['cwd', process.cwd()],
          ['plan-format', 'ts-morph'],
        ]),
        multiFlags: new Map(),
      }),
    );
    expect(exit).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.format).toBe('ts-morph');
    expect(parsed.codemodStarterMetadata.dialect).toBe('ts-morph');
  });
});
