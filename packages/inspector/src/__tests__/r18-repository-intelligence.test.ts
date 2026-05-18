import { describe, expect, test } from 'bun:test';
import {
  buildRepositoryIntelligenceGraph,
  explainRepositoryNode,
  findRepositoryPath,
  getRepositoryNode,
  inspectSharkcraft,
  RepoNodeKind,
} from '../index.ts';

describe('r18 repository intelligence graph', () => {
  test('contains package, file, construct nodes', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const graph = await buildRepositoryIntelligenceGraph(inspection);
    expect(graph.schema).toBe('sharkcraft.repository-intelligence/v1');
    expect(graph.summaries.packages).toBeGreaterThan(0);
    expect(graph.nodes.some((n) => n.kind === RepoNodeKind.Package)).toBe(true);
    expect(graph.nodes.some((n) => n.kind === RepoNodeKind.File || n.kind === RepoNodeKind.Test)).toBe(true);
  });
  test('edges include file -> package belongs-to', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const graph = await buildRepositoryIntelligenceGraph(inspection);
    const belongs = graph.edges.filter((e) => e.kind === 'belongs-to');
    expect(belongs.length).toBeGreaterThan(0);
  });
  test('path query finds connection between a file and its package', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const graph = await buildRepositoryIntelligenceGraph(inspection);
    const pkg = graph.nodes.find((n) => n.kind === RepoNodeKind.Package)!;
    const file = graph.nodes.find(
      (n) => (n.kind === RepoNodeKind.File || n.kind === RepoNodeKind.Test) && graph.edges.some((e) => e.from === n.id && e.to === pkg.id),
    );
    expect(file).toBeDefined();
    const path = findRepositoryPath(graph, file!.id, pkg.id);
    expect(path).toBeDefined();
    expect(path!.length).toBeGreaterThanOrEqual(2);
  });
  test('explain node returns incoming/outgoing summary', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const graph = await buildRepositoryIntelligenceGraph(inspection);
    const pkg = graph.nodes.find((n) => n.kind === RepoNodeKind.Package)!;
    const e = explainRepositoryNode(graph, pkg.id)!;
    expect(e).toBeDefined();
    expect(e.node.id).toBe(pkg.id);
    expect(e.neighborCount).toBeGreaterThan(0);
  });
  test('truncation metadata is present', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const graph = await buildRepositoryIntelligenceGraph(inspection);
    expect(typeof graph.truncation.files).toBe('number');
    expect(typeof graph.truncation.filesCap).toBe('number');
    expect(typeof graph.truncation.filesCapped).toBe('boolean');
  });
  test('unknown node id returns undefined', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const graph = await buildRepositoryIntelligenceGraph(inspection);
    expect(getRepositoryNode(graph, 'pkg:nope')).toBeUndefined();
  });
});
