import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import {
  buildTaskExecutionGraph,
  ExecutionEdgeKind,
  ExecutionNodeKind,
  inspectSharkcraft,
  queryExecutionGraph,
  renderExecutionGraphDot,
} from '../index.ts';

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-r24-exec-dot-'));
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

describe('execution graph DOT + query', () => {
  it('DOT output starts with digraph and lists nodes and edges', async () => {
    await withRoot(async (root) => {
      const inspection = await inspectSharkcraft({ cwd: root });
      const g = await buildTaskExecutionGraph('add a new CLI subcommand', inspection, { role: 'developer' });
      const dot = renderExecutionGraphDot(g);
      expect(dot.startsWith('digraph TaskExecutionGraph')).toBe(true);
      expect(dot).toContain('task ->');
    });
  });

  it('query blocks:done returns the upstream gating subgraph', async () => {
    await withRoot(async (root) => {
      const inspection = await inspectSharkcraft({ cwd: root });
      const g = await buildTaskExecutionGraph(
        'release v1.0.0 with publish and tag',
        inspection,
        { role: 'release-manager' },
      );
      const r = queryExecutionGraph(g, 'blocks:done');
      expect(r.matchedNodes.length).toBeGreaterThan(0);
      // Edges of kind requires/blocks/validates should be present.
      const okEdges = r.matchedEdges.every((e) =>
        [ExecutionEdgeKind.Requires, ExecutionEdgeKind.Blocks, ExecutionEdgeKind.Validates].includes(e.kind),
      );
      expect(okEdges).toBe(true);
    });
  });

  it('query kind:human-approval returns approval nodes for high-risk task', async () => {
    await withRoot(async (root) => {
      const inspection = await inspectSharkcraft({ cwd: root });
      const g = await buildTaskExecutionGraph(
        'release v1.0.0 with publish and tag',
        inspection,
        { role: 'release-manager' },
      );
      const r = queryExecutionGraph(g, 'kind:human-approval');
      expect(r.matchedNodes.length).toBeGreaterThan(0);
      expect(r.matchedNodes.every((n) => n.kind === ExecutionNodeKind.HumanApproval)).toBe(true);
    });
  });

  it('query text:<substr> finds nodes by label/id/detail', async () => {
    await withRoot(async (root) => {
      const inspection = await inspectSharkcraft({ cwd: root });
      const g = await buildTaskExecutionGraph('docs cleanup', inspection, { role: 'developer' });
      const r = queryExecutionGraph(g, 'text:Validation');
      // At least one validation-named node will exist.
      expect(r.matchedNodes.length).toBeGreaterThan(0);
    });
  });
});
