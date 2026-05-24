import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codeIntelCommand } from '../commands/code-intel.command.ts';

function makeArgs(positional: string[], flags: Record<string, string | boolean> = {}, cwd?: string): {
  positional: string[];
  flags: Map<string, string | boolean>;
  multiFlags: Map<string, string[]>;
} {
  const flagMap = new Map<string, string | boolean>();
  if (cwd) flagMap.set('cwd', cwd);
  for (const [k, v] of Object.entries(flags)) flagMap.set(k, v);
  return { positional, flags: flagMap, multiFlags: new Map() };
}

function capture(): { restore: () => string } {
  const orig = process.stdout.write.bind(process.stdout);
  let body = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  return {
    restore() {
      process.stdout.write = orig;
      return body;
    },
  };
}

function writeJson(root: string, rel: string, body: unknown): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, JSON.stringify(body, null, 2), 'utf8');
}

describe('shrk code-intel', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'shrk-code-intel-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('empty project — surfaces the graph "no index yet" info hint', async () => {
    const cap = capture();
    const code = await codeIntelCommand.run(makeArgs([], {}, root));
    const out = cap.restore();
    expect(code).toBe(0);
    expect(out).toContain('Code-intelligence state');
    // The doctor builds the graph Info check even when no state exists.
    expect(out).toContain('code-intelligence-graph');
    expect(out).toContain('No code graph indexed yet');
  });

  test('--json emits a stable schema with summary + checks', async () => {
    writeJson(root, '.sharkcraft/graph/meta.json', {
      schema: 'sharkcraft.graph/v1',
      lastIndexedAt: new Date().toISOString(),
      filesIndexed: 1,
      nodesByKind: { file: 1 },
      edgesByKind: {},
    });
    const cap = capture();
    const code = await codeIntelCommand.run(makeArgs([], { json: true }, root));
    const out = cap.restore();
    expect(code).toBe(0);
    const json = JSON.parse(out);
    expect(json.schema).toBe('sharkcraft.code-intelligence-state/v1');
    expect(json.summary).toBeDefined();
    expect(json.checks).toBeInstanceOf(Array);
    expect(json.checks.length).toBeGreaterThanOrEqual(1);
  });

  test('--check filters to a single id', async () => {
    writeJson(root, '.sharkcraft/graph/meta.json', {
      schema: 'sharkcraft.graph/v1',
      lastIndexedAt: new Date().toISOString(),
      filesIndexed: 1,
      nodesByKind: { file: 1 },
      edgesByKind: {},
    });
    writeJson(root, '.sharkcraft/quality-gates/last.json', {
      schema: 'sharkcraft.quality-gate-report/v1',
      overall: 'pass',
      startedAt: new Date().toISOString(),
      totalDurationMs: 50,
      counts: { pass: 1, fail: 0, warn: 0, skipped: 0 },
      gates: [],
      diagnostics: [],
    });
    const cap = capture();
    const code = await codeIntelCommand.run(
      makeArgs([], { json: true, check: 'code-intelligence-graph' }, root),
    );
    const out = cap.restore();
    expect(code).toBe(0);
    const json = JSON.parse(out);
    expect(json.totalChecks).toBe(1);
    expect(json.checks[0].id).toBe('code-intelligence-graph');
  });

  test('--only narrows by severity', async () => {
    writeJson(root, '.sharkcraft/graph/meta.json', {
      schema: 'sharkcraft.graph/v1',
      lastIndexedAt: new Date().toISOString(),
      filesIndexed: 1,
      nodesByKind: { file: 1 },
      edgesByKind: {},
    });
    const cap = capture();
    const code = await codeIntelCommand.run(makeArgs([], { json: true, only: 'ok' }, root));
    const out = cap.restore();
    expect(code).toBe(0);
    const json = JSON.parse(out);
    for (const c of json.checks) expect(c.severity).toBe('ok');
  });

  test('--markdown emits a sectioned PR-friendly report', async () => {
    writeJson(root, '.sharkcraft/graph/meta.json', {
      schema: 'sharkcraft.graph/v1',
      lastIndexedAt: new Date().toISOString(),
      filesIndexed: 1,
      nodesByKind: { file: 1 },
      edgesByKind: {},
    });
    const cap = capture();
    const code = await codeIntelCommand.run(makeArgs([], { markdown: true }, root));
    const out = cap.restore();
    expect(code).toBe(0);
    expect(out).toContain('# SharkCraft code-intelligence state');
    expect(out).toContain('| ok |');
    expect(out).toContain('### ✓ `code-intelligence-graph`');
  });

  test('--stale-days flips a fresh fixture to advisory when the threshold is tight', async () => {
    writeJson(root, '.sharkcraft/graph/meta.json', {
      schema: 'sharkcraft.graph/v1',
      lastIndexedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      filesIndexed: 1,
      nodesByKind: { file: 1 },
      edgesByKind: {},
    });
    const cap = capture();
    const code = await codeIntelCommand.run(
      makeArgs([], { json: true, 'stale-days': '1' }, root),
    );
    const out = cap.restore();
    expect(code).toBe(0);
    const json = JSON.parse(out);
    const graph = json.checks.find(
      (c: { id: string }) => c.id === 'code-intelligence-graph',
    );
    expect(graph.severity).toBe('warning');
  });
});
