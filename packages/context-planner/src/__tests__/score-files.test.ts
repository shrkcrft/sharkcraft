import { describe, expect, test } from 'bun:test';
import { GraphQueryApi, NodeKind, type IGraphSnapshot, type INode } from '@shrkcrft/graph';
import { scoreFiles } from '../ranker/score-files.ts';

/**
 * Build a GraphQueryApi over an in-memory node set. scoreFiles only reads
 * `allFiles()` + `symbolsIn()`, so an edge-less snapshot is enough — no disk,
 * no indexer.
 */
function makeApi(nodes: readonly INode[]): GraphQueryApi {
  const nodeMap = new Map<string, INode>();
  for (const n of nodes) nodeMap.set(n.id, n);
  const snap = {
    manifest: {},
    nodes: nodeMap,
    edges: new Map(),
    files: new Map(),
  } as unknown as IGraphSnapshot;
  return new GraphQueryApi(snap);
}

const TEST_FILE: INode = {
  id: 'file:packages/ui/src/widget.test.ts',
  kind: NodeKind.File,
  label: 'widget.test.ts',
  path: 'packages/ui/src/widget.test.ts',
  tags: ['test'],
};

describe('scoreFiles — bug-fix unblocks the test boost', () => {
  test('bug-fix scores a co-located test file strictly higher than feature', () => {
    const api = makeApi([TEST_FILE]);
    const task = 'improve widget rendering';

    const bugFix = scoreFiles(api, { task, intent: 'bug-fix' });
    const feature = scoreFiles(api, { task, intent: 'feature' });

    const bugHit = bugFix.find((f) => f.node.id === TEST_FILE.id);
    const featureHit = feature.find((f) => f.node.id === TEST_FILE.id);
    expect(bugHit).toBeDefined();
    expect(featureHit).toBeDefined();

    // bug-fix turns the signed test weight into a boost; feature keeps the
    // penalty — so the same file ranks strictly higher under bug-fix.
    expect(bugHit!.score).toBeGreaterThan(featureHit!.score);
    expect(bugHit!.reasons).toContain('test (intent-relevant boost)');
    expect(featureHit!.reasons).toContain('test (intent-mismatched penalty)');
  });
});
