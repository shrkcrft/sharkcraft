/**
 * Tests for the two agent-self-service MCP tools added alongside
 * `shrk diff-check` (Phase 2) and the `get_file_advice` companion
 * (Phase 3 — `shrk advise` ended up redundant with `shrk why`, so
 * the only Phase-3 surface is the MCP tool).
 *
 *   - Both tools are registered in ALL_TOOLS.
 *   - Both appear in the primary tools allowlist (so they show up in
 *     `tools/list` without `SHRK_MCP_FULL_TOOLS=1`).
 *   - `get_diff_check_report` returns the documented envelope.
 *   - `get_file_advice` returns a structured per-file report.
 */

import { describe, expect, test } from 'bun:test';
import * as nodePath from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '../tools/index.ts';
import { PRIMARY_MCP_TOOLS } from '../tools/primary-tools.ts';

const DOGFOOD_CWD = nodePath.resolve(__dirname, '../../../../examples/dogfood-target');

describe('MCP tool: get_diff_check_report', () => {
  test('is registered + in primary tools', () => {
    const names = new Set(ALL_TOOLS.map((t) => t.name));
    expect(names.has('get_diff_check_report')).toBe(true);
    expect(PRIMARY_MCP_TOOLS.has('get_diff_check_report')).toBe(true);
  });

  test('returns a v1 envelope shape', async () => {
    const tool = ALL_TOOLS.find((t) => t.name === 'get_diff_check_report')!;
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const res = await tool.handler({}, { inspection, cwd: DOGFOOD_CWD } as never);
    const data = res.data as {
      schema?: string;
      verdict?: string;
      summary?: string;
      nextAction?: string;
      scope?: { mode?: string; fileCount?: number };
      boundaries?: { ran?: boolean; counts?: Record<string, number> };
      imports?: { ran?: boolean; verdict?: string };
    };
    expect(data.schema).toBe('sharkcraft.diff-check/v1');
    expect(typeof data.verdict).toBe('string');
    expect(['ok', 'warnings', 'errors']).toContain(data.verdict as string);
    expect(typeof data.summary).toBe('string');
    expect(typeof data.nextAction).toBe('string');
    expect(typeof data.scope?.fileCount).toBe('number');
    expect(typeof data.boundaries?.ran).toBe('boolean');
    expect(typeof data.imports?.ran).toBe('boolean');
  });

  test('explicit `files` scope reports scope.mode="files"', async () => {
    const tool = ALL_TOOLS.find((t) => t.name === 'get_diff_check_report')!;
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const res = await tool.handler(
      { files: ['nonexistent.ts'] },
      { inspection, cwd: DOGFOOD_CWD } as never,
    );
    const data = res.data as { scope?: { mode?: string } };
    expect(data.scope?.mode).toBe('files');
  });
});

describe('MCP tool: get_file_advice', () => {
  test('is registered + in primary tools', () => {
    const names = new Set(ALL_TOOLS.map((t) => t.name));
    expect(names.has('get_file_advice')).toBe(true);
    expect(PRIMARY_MCP_TOOLS.has('get_file_advice')).toBe(true);
  });

  test('returns a structured error when `file` is missing', async () => {
    const tool = ALL_TOOLS.find((t) => t.name === 'get_file_advice')!;
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const res = await tool.handler({}, { inspection, cwd: DOGFOOD_CWD } as never);
    const data = res.data as { error?: string };
    expect(data.error).toBe('missing-argument');
  });

  test('returns an IWhyReport for an existing file', async () => {
    const tool = ALL_TOOLS.find((t) => t.name === 'get_file_advice')!;
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    // Pick a file that should be inside the dogfood example.
    const res = await tool.handler(
      { file: 'sharkcraft/knowledge.ts' },
      { inspection, cwd: DOGFOOD_CWD } as never,
    );
    const data = res.data as {
      schema?: string;
      target?: { relativePath?: string; kind?: string };
      pathConventions?: unknown[];
      rules?: unknown[];
      boundaries?: unknown[];
      knowledge?: unknown[];
      suggestedNext?: unknown[];
    };
    expect(typeof data.schema).toBe('string');
    expect(typeof data.target?.relativePath).toBe('string');
    // The four per-category arrays must always be present, even if empty.
    expect(Array.isArray(data.pathConventions)).toBe(true);
    expect(Array.isArray(data.rules)).toBe(true);
    expect(Array.isArray(data.boundaries)).toBe(true);
    expect(Array.isArray(data.knowledge)).toBe(true);
    expect(Array.isArray(data.suggestedNext)).toBe(true);
  });

  test('text summary names the file and counts matches', async () => {
    const tool = ALL_TOOLS.find((t) => t.name === 'get_file_advice')!;
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const res = await tool.handler(
      { file: 'sharkcraft/knowledge.ts' },
      { inspection, cwd: DOGFOOD_CWD } as never,
    );
    expect(typeof res.text).toBe('string');
    expect(res.text).toContain('File:');
    expect(res.text).toContain('Matches:');
  });

  test('honours the limit option', async () => {
    const tool = ALL_TOOLS.find((t) => t.name === 'get_file_advice')!;
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const res = await tool.handler(
      { file: 'sharkcraft/knowledge.ts', limit: 2 },
      { inspection, cwd: DOGFOOD_CWD } as never,
    );
    const data = res.data as { rules?: unknown[]; knowledge?: unknown[] };
    // Limit caps rules + knowledge (per buildWhyReport semantics).
    expect((data.rules ?? []).length).toBeLessThanOrEqual(2);
    expect((data.knowledge ?? []).length).toBeLessThanOrEqual(2);
  });
});
