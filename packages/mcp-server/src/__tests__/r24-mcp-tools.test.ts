import { describe, expect, test } from 'bun:test';
import { ALL_TOOLS } from '../tools/index.ts';

const R24_TOOLS = [
  'get_contract_status',
  'create_contract_approval_preview',
  'query_execution_graph',
] as const;

describe('r24 mcp tools', () => {
  test('all tools are registered', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    for (const expected of R24_TOOLS) {
      expect(names).toContain(expected);
    }
  });

  test('tools advertise read-only intent', () => {
    for (const name of R24_TOOLS) {
      const tool = ALL_TOOLS.find((t) => t.name === name)!;
      expect(tool.description.toLowerCase()).toContain('read-only');
    }
  });

  test('create_contract_approval_preview returns a preview and a nextCommand', async () => {
    const { inspectSharkcraft, buildAgentContract } = await import('@shrkcrft/inspector');
    const tmp = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = tmp.mkdtempSync(path.join(os.tmpdir(), 'shrk-r24-mcp-'));
    try {
      tmp.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'fixture', version: '0.0.0' }),
      );
      const inspection = await inspectSharkcraft({ cwd: root });
      const contract = await buildAgentContract('docs cleanup', inspection, { role: 'developer' });
      const contractPath = path.join(root, 'contract.json');
      tmp.writeFileSync(contractPath, JSON.stringify(contract));
      const ctx = { cwd: root, inspection };
      const tool = ALL_TOOLS.find((t) => t.name === 'create_contract_approval_preview')!;
      const result = await tool.handler(
        { contractPath, approvedBy: 'alice', reason: 'reviewed' },
        ctx as never,
      );
      expect(result.isError).not.toBe(true);
      const data = result.data as {
        approvalPreview: { approvedBy: string };
        nextCommand: string;
        note: string;
      };
      expect(data.approvalPreview.approvedBy).toBe('alice');
      expect(data.nextCommand).toContain('shrk contract approve');
      expect(data.note.toLowerCase()).toContain('mcp does not write');
    } finally {
      tmp.rmSync(root, { recursive: true, force: true });
    }
  });

  test('query_execution_graph rebuilds the graph and matches blocks:done', async () => {
    const { inspectSharkcraft } = await import('@shrkcrft/inspector');
    const tmp = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = tmp.mkdtempSync(path.join(os.tmpdir(), 'shrk-r24-mcp-q-'));
    try {
      tmp.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'fixture', version: '0.0.0' }),
      );
      const ctx = { cwd: root, inspection: await inspectSharkcraft({ cwd: root }) };
      const tool = ALL_TOOLS.find((t) => t.name === 'query_execution_graph')!;
      const result = await tool.handler(
        { task: 'release v1.0.0 with publish and tag', role: 'release-manager', query: 'blocks:done' },
        ctx as never,
      );
      expect(result.isError).not.toBe(true);
      const data = result.data as { matchedNodes: unknown[] };
      expect(Array.isArray(data.matchedNodes)).toBe(true);
    } finally {
      tmp.rmSync(root, { recursive: true, force: true });
    }
  });
});
