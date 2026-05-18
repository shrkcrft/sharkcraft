import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import {
  buildTaskExecutionGraph,
  inspectSharkcraft,
  queryExecutionGraph,
  renderExecutionGraphClusteredDot,
  renderExecutionGraphDot,
} from '../index.ts';

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-r25-dot-'));
  try {
    writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('execution graph DOT clustering', () => {
  it('renderExecutionGraphClusteredDot emits subgraph clusters', async () => {
    await withRoot(async (root) => {
      const inspection = await inspectSharkcraft({ cwd: root });
      const graph = await buildTaskExecutionGraph('do a thing', inspection);
      const dot = renderExecutionGraphClusteredDot(graph);
      expect(dot).toContain('subgraph cluster_intent_risk');
      expect(dot).toContain('subgraph cluster_validation');
      expect(dot).toContain('subgraph cluster_done');
    });
  });

  it('clustered output still escapes labels', async () => {
    await withRoot(async (root) => {
      const inspection = await inspectSharkcraft({ cwd: root });
      const graph = await buildTaskExecutionGraph('add "quoted" feature', inspection);
      const dot = renderExecutionGraphClusteredDot(graph);
      expect(dot).not.toMatch(/[^\\]"quoted"/);
    });
  });

  it('non-cluster output is unchanged', async () => {
    await withRoot(async (root) => {
      const inspection = await inspectSharkcraft({ cwd: root });
      const graph = await buildTaskExecutionGraph('a simple task', inspection);
      const plain = renderExecutionGraphDot(graph);
      expect(plain).toContain('digraph TaskExecutionGraph');
      expect(plain).not.toContain('subgraph');
    });
  });

  it('query still works after building a graph', async () => {
    await withRoot(async (root) => {
      const inspection = await inspectSharkcraft({ cwd: root });
      const graph = await buildTaskExecutionGraph('a simple task', inspection);
      const q = queryExecutionGraph(graph, 'kind:task');
      expect(q.matchedNodes.length).toBeGreaterThan(0);
    });
  });
});
