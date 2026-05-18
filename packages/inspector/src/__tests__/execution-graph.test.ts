import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import {
  EXECUTION_GRAPH_SCHEMA,
  ExecutionNodeKind,
  buildTaskExecutionGraph,
  inspectSharkcraft,
  renderExecutionGraphMermaid,
} from '../index.ts';

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-r23-exec-'));
  try {
    writeFileSync(
      nodePath.join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '0.0.0' }),
    );
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('execution graph', () => {
  it('graph contains task / intent / risk / contract / validation nodes', async () => {
    await withRoot(async (root) => {
      const inspection = await inspectSharkcraft({ cwd: root });
      const g = await buildTaskExecutionGraph('add a CLI subcommand', inspection, { role: 'developer' });
      expect(g.schema).toBe(EXECUTION_GRAPH_SCHEMA);
      const kinds = new Set(g.nodes.map((n) => n.kind));
      expect(kinds.has(ExecutionNodeKind.Task)).toBe(true);
      expect(kinds.has(ExecutionNodeKind.Intent)).toBe(true);
      expect(kinds.has(ExecutionNodeKind.Risk)).toBe(true);
      expect(kinds.has(ExecutionNodeKind.Contract)).toBe(true);
      expect(kinds.has(ExecutionNodeKind.Validation)).toBe(true);
    });
  });

  it('high-risk release task includes a human-approval gate', async () => {
    await withRoot(async (root) => {
      const inspection = await inspectSharkcraft({ cwd: root });
      const g = await buildTaskExecutionGraph(
        'release v1.0.0 with publish and tag — architecture-impacting',
        inspection,
        { role: 'release-manager' },
      );
      const hasApproval = g.nodes.some((n) => n.kind === ExecutionNodeKind.HumanApproval);
      expect(hasApproval).toBe(true);
    });
  });

  it('mermaid output escapes labels', async () => {
    await withRoot(async (root) => {
      const inspection = await inspectSharkcraft({ cwd: root });
      const g = await buildTaskExecutionGraph('docs update with "quotes" | pipes', inspection, {
        role: 'developer',
      });
      const m = renderExecutionGraphMermaid(g);
      // No unescaped raw quotes break the mermaid label format.
      expect(m).not.toContain('"quotes"');
      // Pipes inside labels should be converted (we use them as edge syntax).
      const taskNodeLine = m.split('\n').find((l) => l.includes('Task: docs update'))!;
      expect(taskNodeLine.includes('|')).toBe(false);
    });
  });
});
