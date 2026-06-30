/**
 * Status-freshness signal for the status-like commands.
 *
 * Backstop for the change that gives `context status` (and the sibling
 * status verbs) the same `state: fresh | stale` + drift line that
 * `graph status` exposes. The contract under test:
 *
 *   - After a source file changes *post-build* (its mtime is newer than the
 *     stored `lastBuilt`), `context status` reports `state: 'stale'` and a
 *     `nextCommand` hint in --json, and a `! stale …` warn line in human
 *     output.
 *   - When the build is newer than every source file, it reports
 *     `state: 'fresh'` and no warn line.
 *
 * The build timestamp is derived from the fixture file's real mtime (rather
 * than wall-clock now) so the stale/fresh boundary is deterministic.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextStatusCommand } from '../commands/task-context.command.ts';
import type { ParsedArgs } from '../command-registry.ts';

const writeOut = process.stdout.write.bind(process.stdout);

async function captureStdout(
  fn: () => number | Promise<number>,
): Promise<{ code: number; out: string }> {
  let out = '';
  (process.stdout.write as unknown as (s: string) => boolean) = ((s: string) => {
    out += s;
    return true;
  }) as never;
  try {
    const code = await fn();
    return { code, out };
  } finally {
    process.stdout.write = writeOut as never;
  }
}

function makeArgs(cwd: string, json: boolean): ParsedArgs {
  const flags = new Map<string, string | boolean>([['cwd', cwd]]);
  if (json) flags.set('json', true);
  return { positional: ['status'], flags, multiFlags: new Map<string, string[]>() };
}

/** Seed a workspace with a single source file and a context manifest whose
 *  `lastBuilt` is offset from that file's mtime by `buildOffsetMs`
 *  (negative → built before the file → stale; positive → built after → fresh). */
function seedWorkspace(buildOffsetMs: number): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-status-freshness-'));
  const srcDir = join(root, 'src');
  mkdirSync(srcDir, { recursive: true });
  const srcFile = join(srcDir, 'feature.ts');
  writeFileSync(srcFile, 'export const x = 1;\n', 'utf8');
  const mtimeMs = statSync(srcFile).mtimeMs;
  const lastBuilt = new Date(mtimeMs + buildOffsetMs).toISOString();

  const ctxDir = join(root, '.sharkcraft', 'context');
  mkdirSync(ctxDir, { recursive: true });
  writeFileSync(
    join(ctxDir, 'status.json'),
    JSON.stringify({ lastTask: 'add feature', lastBuilt, bundles: [] }),
    'utf8',
  );
  return root;
}

describe('context status freshness', () => {
  const roots: string[] = [];
  afterEach(() => {
    while (roots.length > 0) {
      const r = roots.pop();
      if (r) rmSync(r, { recursive: true, force: true });
    }
  });

  test('reports state:stale when a source file is newer than the build (--json)', async () => {
    const root = seedWorkspace(-60_000); // built 60s BEFORE the source mtime
    roots.push(root);
    const { code, out } = await captureStdout(() => contextStatusCommand.run(makeArgs(root, true)));
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as {
      state: string;
      lastChangedAt: string | null;
      behindMs: number;
      nextCommand?: string;
    };
    expect(parsed.state).toBe('stale');
    expect(parsed.behindMs).toBeGreaterThan(0);
    expect(parsed.lastChangedAt).not.toBeNull();
    expect(parsed.nextCommand).toBe('shrk context refresh');
  });

  test('human output carries a stale warn line', async () => {
    const root = seedWorkspace(-60_000);
    roots.push(root);
    const { out } = await captureStdout(() => contextStatusCommand.run(makeArgs(root, false)));
    expect(out).toContain('state');
    expect(out).toContain('stale');
    expect(out).toContain('shrk context refresh');
  });

  test('reports state:fresh when the build is newer than every source file', async () => {
    const root = seedWorkspace(60_000); // built 60s AFTER the source mtime
    roots.push(root);
    const { code, out } = await captureStdout(() => contextStatusCommand.run(makeArgs(root, true)));
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as { state: string; behindMs: number; nextCommand?: string };
    expect(parsed.state).toBe('fresh');
    expect(parsed.behindMs).toBe(0);
    expect(parsed.nextCommand).toBeUndefined();
  });
});
