/**
 * `shrk schemas emit` surface tests.
 *
 *   - default preview lists the diff but writes nothing
 *   - --write produces one schema file per entry + INDEX.md
 *   - INDEX.md lists every emitted schema
 *   - --check fails (exit 1) when docs/schemas/ is stale
 *   - --check passes (exit 0) after a fresh --write
 *   - --json keeps the same shape across preview / write / check
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as nodePath from 'node:path';
import {
  schemasEmitCommand,
  SCHEMAS_EMIT_SCHEMA,
} from '../commands/schemas.command.ts';
import { ALL_SCHEMAS } from '../schemas/json-schemas.ts';
import type { ParsedArgs } from '../command-registry.ts';

const TMP_BASE = nodePath.join('/tmp', 'r58-schemas-emit');
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

function makeArgs(flags: Record<string, string | boolean> = {}): ParsedArgs {
  const flagMap = new Map<string, string | boolean>();
  for (const [k, v] of Object.entries(flags)) flagMap.set(k, v);
  return {
    positional: [],
    flags: flagMap,
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

describe('shrk schemas emit', () => {
  test('default preview writes nothing and lists diffs', async () => {
    captureStdout();
    const rc = await schemasEmitCommand.run(makeArgs());
    restoreStdout();
    expect(rc).toBe(0);
    expect(captured).toContain('preview only');
    expect(existsSync(nodePath.join(projectRoot, 'docs', 'schemas'))).toBe(false);
  });

  test('--write produces one schema file per entry + INDEX.md', async () => {
    captureStdout();
    const rc = await schemasEmitCommand.run(makeArgs({ write: true }));
    restoreStdout();
    expect(rc).toBe(0);
    const outDir = nodePath.join(projectRoot, 'docs', 'schemas');
    const files = readdirSync(outDir).sort();
    expect(files).toContain('INDEX.md');
    const expectedCount = Object.keys(ALL_SCHEMAS).length + 1;
    expect(files.length).toBe(expectedCount);
    const indexBody = readFileSync(nodePath.join(outDir, 'INDEX.md'), 'utf8');
    for (const name of Object.keys(ALL_SCHEMAS)) {
      expect(indexBody).toContain(name);
    }
  });

  test('--check passes after a fresh --write', async () => {
    captureStdout();
    await schemasEmitCommand.run(makeArgs({ write: true }));
    restoreStdout();
    captureStdout();
    const rc = await schemasEmitCommand.run(makeArgs({ check: true }));
    restoreStdout();
    expect(rc).toBe(0);
    expect(captured).toContain('matches');
  });

  test('--check fails when docs/schemas/ is stale (missing files)', async () => {
    // No write — directory is empty.
    captureStdout();
    const rc = await schemasEmitCommand.run(makeArgs({ check: true }));
    restoreStdout();
    expect(rc).toBe(1);
    expect(captured).toContain('drifted');
  });

  test('--check fails when an emitted file is hand-edited', async () => {
    captureStdout();
    await schemasEmitCommand.run(makeArgs({ write: true }));
    restoreStdout();
    const outDir = nodePath.join(projectRoot, 'docs', 'schemas');
    const someSchema = readdirSync(outDir).find((f) => f.endsWith('.schema.json'))!;
    writeFileSync(nodePath.join(outDir, someSchema), '{\n  "tampered": true\n}\n', 'utf8');
    captureStdout();
    const rc = await schemasEmitCommand.run(makeArgs({ check: true }));
    restoreStdout();
    expect(rc).toBe(1);
    expect(captured).toContain('changed');
  });

  test('--json envelope is stable across preview / write / check', async () => {
    // preview
    captureStdout();
    await schemasEmitCommand.run(makeArgs({ json: true }));
    restoreStdout();
    const preview = JSON.parse(captured);
    expect(preview.schema).toBe(SCHEMAS_EMIT_SCHEMA);
    expect(preview.mode).toBe('preview');
    // write
    captureStdout();
    await schemasEmitCommand.run(makeArgs({ write: true, json: true }));
    restoreStdout();
    const written = JSON.parse(captured);
    expect(written.schema).toBe(SCHEMAS_EMIT_SCHEMA);
    expect(written.mode).toBe('write');
    expect(written.written.length).toBe(Object.keys(ALL_SCHEMAS).length + 1);
    // check
    captureStdout();
    await schemasEmitCommand.run(makeArgs({ check: true, json: true }));
    restoreStdout();
    const checked = JSON.parse(captured);
    expect(checked.schema).toBe(SCHEMAS_EMIT_SCHEMA);
    expect(checked.mode).toBe('check');
    expect(checked.drifted).toBe(0);
  });

  test('--write and --check together are rejected', async () => {
    captureStdout();
    const rc = await schemasEmitCommand.run(makeArgs({ write: true, check: true }));
    restoreStdout();
    expect(rc).toBe(2);
  });
});
