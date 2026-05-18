/**
 * Rounds capture + diff verbs.
 *
 * - `rounds capture --id ` writes a snapshot.json + meta.json under
 *     .sharkcraft/rounds/<id>/.
 *   - `diff rounds --from <a> --to <b>` returns added/removed deltas.
 *   - --json shape stays stable across capture / show / diff.
 *   - missing round returns a structured error envelope, not a crash.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import * as nodePath from 'node:path';
import {
  captureRoundSnapshot,
  diffRounds,
  loadRoundSnapshot,
  ROUND_SNAPSHOT_SCHEMA,
  ROUNDS_DIFF_SCHEMA,
  writeRoundSnapshot,
} from '@shrkcrft/inspector';
import {
  diffRoundsCommand,
  roundsCaptureCommand,
  roundsListCommand,
  roundsShowCommand,
} from '../commands/rounds.command.ts';
import type { ParsedArgs } from '../command-registry.ts';

const TMP_BASE = nodePath.join('/tmp', 'r58-rounds');
let projectRoot: string;
let captured: string;
let originalWrite: typeof process.stdout.write;

function captureStdout(): void {
  captured = '';
  originalWrite = process.stdout.write.bind(process.stdout);
  const override = (chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  };
  process.stdout.write = override as typeof process.stdout.write;
}

function restoreStdout(): void {
  if (originalWrite) process.stdout.write = originalWrite;
}

function makeArgs(
  positional: string[] = [],
  flags: Record<string, string | boolean> = {},
): ParsedArgs {
  const m = new Map<string, string | boolean>();
  for (const [k, v] of Object.entries(flags)) m.set(k, v);
  return {
    positional,
    flags: m,
    multiFlags: new Map(),
    globalCwd: projectRoot,
  };
}

beforeEach(() => {
  projectRoot = nodePath.join(
    TMP_BASE,
    `proj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => {
  restoreStdout();
  if (projectRoot && existsSync(projectRoot)) {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

describe('rounds capture + diff', () => {
  test('captureRoundSnapshot freezes the surface and is deterministic in shape', () => {
    const snap = captureRoundSnapshot({
      projectRoot,
      id: 'TEST-1',
      title: 'demo',
      commands: [{ name: 'foo', description: 'F' }],
      mcpTools: [{ name: 'tool_foo', description: 'T' }],
    });
    expect(snap.schema).toBe(ROUND_SNAPSHOT_SCHEMA);
    expect(snap.id).toBe('TEST-1');
    expect(snap.title).toBe('demo');
    expect(snap.commands.length).toBe(1);
    expect(snap.mcpTools.length).toBe(1);
    expect(snap.docs.length).toBe(0);
  });

  test('writeRoundSnapshot persists snapshot.json + meta.json', () => {
    const snap = captureRoundSnapshot({
      projectRoot,
      id: 'TEST-2',
      commands: [{ name: 'foo', description: 'F' }],
      mcpTools: [],
    });
    const { snapshotFile, metaFile } = writeRoundSnapshot(projectRoot, snap);
    expect(existsSync(snapshotFile)).toBe(true);
    expect(existsSync(metaFile)).toBe(true);
    const parsed = JSON.parse(readFileSync(snapshotFile, 'utf8'));
    expect(parsed.schema).toBe(ROUND_SNAPSHOT_SCHEMA);
    const loaded = loadRoundSnapshot(projectRoot, 'TEST-2')!;
    expect(loaded.id).toBe('TEST-2');
  });

  test('diffRounds reports commands/MCP tools/docs added and removed', () => {
    const from = captureRoundSnapshot({
      projectRoot,
      id: 'A',
      commands: [
        { name: 'kept', description: 'K' },
        { name: 'gone', description: 'G' },
      ],
      mcpTools: [{ name: 'tool_old', description: 'O' }],
    });
    const to = captureRoundSnapshot({
      projectRoot,
      id: 'B',
      commands: [
        { name: 'kept', description: 'K' },
        { name: 'fresh', description: 'F' },
      ],
      mcpTools: [{ name: 'tool_new', description: 'N' }],
    });
    const diff = diffRounds(from, to);
    expect(diff.schema).toBe(ROUNDS_DIFF_SCHEMA);
    expect(diff.commandsAdded.map((c) => c.name)).toEqual(['fresh']);
    expect(diff.commandsRemoved.map((c) => c.name)).toEqual(['gone']);
    expect(diff.mcpToolsAdded.map((t) => t.name)).toEqual(['tool_new']);
    expect(diff.mcpToolsRemoved.map((t) => t.name)).toEqual(['tool_old']);
  });

  test('shrk rounds capture --id <id> --json writes a snapshot file', async () => {
    captureStdout();
    const rc = await roundsCaptureCommand.run(makeArgs([], { id: 'R58X', json: true }));
    restoreStdout();
    expect(rc).toBe(0);
    const payload = JSON.parse(captured);
    expect(payload.snapshot.schema).toBe(ROUND_SNAPSHOT_SCHEMA);
    expect(payload.files.snapshotFile).toContain('.sharkcraft/rounds/R58X/snapshot.json');
    expect(existsSync(payload.files.snapshotFile)).toBe(true);
  });

  test('shrk rounds list reports captured rounds', async () => {
    await roundsCaptureCommand.run(makeArgs([], { id: 'R58A' }));
    await roundsCaptureCommand.run(makeArgs([], { id: 'R58B' }));
    captureStdout();
    const rc = await roundsListCommand.run(makeArgs([], { json: true }));
    restoreStdout();
    expect(rc).toBe(0);
    const payload = JSON.parse(captured);
    expect(payload.rounds.sort()).toEqual(['R58A', 'R58B']);
  });

  test('shrk diff rounds --from --to returns delta + stable --json schema', async () => {
    await roundsCaptureCommand.run(makeArgs([], { id: 'PREV' }));
    // Mutate the catalog state? We can't easily, but capture again with the
    // same surface — delta will be empty but the envelope should still be
    // valid.
    await roundsCaptureCommand.run(makeArgs([], { id: 'NEXT' }));
    captureStdout();
    const rc = await diffRoundsCommand.run(
      makeArgs([], { from: 'PREV', to: 'NEXT', json: true }),
    );
    restoreStdout();
    expect(rc).toBe(0);
    const payload = JSON.parse(captured);
    expect(payload.schema).toBe(ROUNDS_DIFF_SCHEMA);
    expect(payload.fromId).toBe('PREV');
    expect(payload.toId).toBe('NEXT');
    expect(Array.isArray(payload.commandsAdded)).toBe(true);
  });

  test('missing round returns a structured JSON error envelope', async () => {
    captureStdout();
    const rc = await diffRoundsCommand.run(
      makeArgs([], { from: 'NONE', to: 'STILL-NONE', json: true }),
    );
    restoreStdout();
    expect(rc).toBe(1);
    const payload = JSON.parse(captured);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('round-not-found');
  });

  test('shrk rounds show <id> returns the snapshot via --json', async () => {
    await roundsCaptureCommand.run(makeArgs([], { id: 'R58Y' }));
    captureStdout();
    const rc = await roundsShowCommand.run(makeArgs(['R58Y'], { json: true }));
    restoreStdout();
    expect(rc).toBe(0);
    const payload = JSON.parse(captured);
    expect(payload.id).toBe('R58Y');
    expect(payload.schema).toBe(ROUND_SNAPSHOT_SCHEMA);
  });
});
