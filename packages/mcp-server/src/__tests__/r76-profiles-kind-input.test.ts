/**
 * r76 — MCP `list_profiles` / `get_profile` take `kind` as a closed enum
 * (round 12, 12.3a).
 *
 * An unknown `kind` was dropped silently and EVERY kind was listed, and
 * neither tool had a strict zod entry. The input is validated in TWO places —
 * the advertised inputSchema and the wire validator — so both are exercised,
 * and the call goes through the REAL wire (the server spawned over stdio), not
 * the bare handler, which would bypass the validator.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { inspectSharkcraft, ProfileKind } from '@shrkcrft/inspector';
import { WorkspaceProfile } from '@shrkcrft/workspace';
import { getProfileTool, listProfilesTool } from '../tools/r32-profiles.tool.ts';
import { TOOL_INPUT_SCHEMAS, validateToolInput } from '../server/tool-input-validators.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const SERVER_MAIN = join(REPO_ROOT, 'packages/mcp-server/src/main.ts');
const TIMEOUT_MS = 120_000;
const roots: string[] = [];

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r76-mcp-profiles-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0', devDependencies: { typescript: '^5.0.0' } }),
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx' };\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const argsFor = (tool: string, kind: string): Record<string, unknown> =>
  tool === 'get_profile' ? { id: 'has-typescript', kind } : { kind };

function textOf(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  return ((Array.isArray(content) ? content : []) as { type: string; text?: string }[]).map((c) => c.text ?? '').join('\n');
}

describe('r76 profile tools — the kind enum', () => {
  test('the inputSchema enum and the strict zod validator list the same kinds', () => {
    for (const tool of [listProfilesTool, getProfileTool]) {
      const kind = (tool.inputSchema.properties as Record<string, { enum?: readonly string[] }>)['kind'];
      expect([...(kind?.enum ?? [])].sort()).toEqual([...Object.values(ProfileKind)].sort());
      expect(TOOL_INPUT_SCHEMAS[tool.name]).toBeDefined();
      for (const k of Object.values(ProfileKind)) expect(validateToolInput(tool.name, argsFor(tool.name, k)).ok).toBe(true);
      expect(validateToolInput(tool.name, argsFor(tool.name, 'bogus')).ok).toBe(false);
    }
    expect(validateToolInput('list_profiles', {}).ok).toBe(true);
    expect(validateToolInput('list_profiles', { other: 1 }).ok).toBe(false);
    expect(validateToolInput('get_profile', { kind: 'workspace' }).ok).toBe(false);
  });

  test('a direct (validator-bypassing) call still refuses an unknown kind instead of listing everything', async () => {
    const inspection = await inspectSharkcraft({ cwd: workspace() });
    const res = await listProfilesTool.handler({ kind: 'bogus' }, { inspection, cwd: inspection.projectRoot } as never);
    expect(res.isError).toBe(true);
    expect(res.error?.code).toBe('invalid-input');
    const ok = await listProfilesTool.handler({ kind: 'workspace' }, { inspection, cwd: inspection.projectRoot } as never);
    expect((ok.data as { id: string }[]).map((e) => e.id).sort()).toEqual([...Object.values(WorkspaceProfile)].sort());
  }, TIMEOUT_MS);

  test('over the wire: {kind:"workspace"} returns the builtin entries; {kind:"bogus"} is rejected by the validator', async () => {
    const transport = new StdioClientTransport({ command: 'bun', args: ['run', SERVER_MAIN, '--cwd', workspace()] });
    const client = new Client({ name: 'shrk-r76-client', version: '0.0.0' });
    try {
      await client.connect(transport);
      const ok = await client.callTool({ name: 'list_profiles', arguments: { kind: 'workspace' } });
      expect(ok.isError).not.toBe(true);
      const text = textOf(ok);
      for (const id of Object.values(WorkspaceProfile)) expect(text).toContain(id);
      const bad = await client.callTool({ name: 'list_profiles', arguments: { kind: 'bogus' } });
      expect(bad.isError).toBe(true);
      expect(textOf(bad)).toContain('Invalid input for "list_profiles"');
      const get = await client.callTool({ name: 'get_profile', arguments: { id: 'has-typescript', kind: 'workspace' } });
      expect(get.isError).not.toBe(true);
      expect(textOf(get)).toContain('uses TypeScript');
    } finally {
      await client.close().catch(() => undefined);
    }
  }, TIMEOUT_MS);
});
