import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const SERVER_MAIN = join(REPO_ROOT, 'packages/mcp-server/src/main.ts');
const DOGFOOD_TARGET = join(REPO_ROOT, 'examples/dogfood-target');

/**
 * Integration test: spawn the SharkCraft MCP server as a subprocess, connect
 * the SDK Client via stdio, exercise initialize → tools/list → tools/call →
 * resources/list → close. Validates that the live wire protocol works
 * end-to-end against our server.
 */
describe('MCP stdio client integration', () => {
  test('initialize → tools/list → tools/call → resources/list → close', async () => {
    const transport = new StdioClientTransport({
      command: 'bun',
      args: ['run', SERVER_MAIN, '--cwd', DOGFOOD_TARGET],
    });
    const client = new Client({ name: 'shrk-test-client', version: '0.0.0' });

    try {
      await client.connect(transport);

      const tools = await client.listTools();
      expect(Array.isArray(tools.tools)).toBe(true);
      expect(tools.tools.length).toBeGreaterThan(20);
      const toolNames = tools.tools.map((t) => t.name);
      expect(toolNames).toContain('inspect_workspace');
      expect(toolNames).toContain('list_pipelines');
      expect(toolNames).toContain('list_packs');
      expect(toolNames).toContain('get_action_hints');
      expect(toolNames).toContain('get_ai_readiness_report');

      const result = await client.callTool({ name: 'inspect_workspace', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(Array.isArray(result.content)).toBe(true);

      const resources = await client.listResources();
      expect(Array.isArray(resources.resources)).toBe(true);
      expect(resources.resources.length).toBeGreaterThan(0);
      const overview = resources.resources.find((r) => r.uri === 'sharkcraft://overview');
      expect(overview).toBeDefined();
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 15000);
});
