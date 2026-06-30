import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex, EdgeKind } from '@shrkcrft/graph';
import { runExtractors, FrameworkQueryApi, reactExtractor } from '../index.ts';

function setupReactFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-fw-react-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
  );
  mkdirSync(join(root, 'packages', 'ui', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'ui', 'package.json'),
    JSON.stringify({ name: '@demo/ui', main: 'src/index.ts' }, null, 2),
  );
  writeFileSync(
    join(root, 'packages', 'ui', 'src', 'Button.tsx'),
    [
      "import React, { useState } from 'react';",
      "export function Button({ label }: { label: string }) {",
      "  const [count, setCount] = useState(0);",
      "  return <button onClick={() => setCount(count + 1)}>{label} {count}</button>;",
      "}",
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'packages', 'ui', 'src', 'Counter.tsx'),
    [
      "import React, { useEffect } from 'react';",
      "export const Counter = ({ initial }: { initial: number }) => {",
      "  useEffect(() => { console.log('mount'); }, []);",
      "  return <div>{initial}</div>;",
      "};",
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'packages', 'ui', 'src', 'utils.ts'),
    "export function add(a: number, b: number) { return a + b; }",
  );
  return root;
}

describe('react extractor', () => {
  test('detects function + arrow components and hook usages', () => {
    const root = setupReactFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const r = runExtractors({ projectRoot: root, only: ['react'] });
      expect(r.manifest.countsBySubtype['react:component']).toBe(2);
      expect(r.manifest.countsBySubtype['react:hook-usage']).toBeGreaterThanOrEqual(2);
      const api = FrameworkQueryApi.fromStore(root);
      const components = api.list({ framework: 'react', subtype: 'component' });
      const names = components.map((c) => c.label).sort();
      expect(names).toEqual(['Button', 'Counter']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('skips files with no React signal', () => {
    const root = setupReactFixture();
    try {
      buildFullIndex({ projectRoot: root });
      runExtractors({ projectRoot: root, only: ['react'] });
      const api = FrameworkQueryApi.fromStore(root);
      expect(api.forFile('packages/ui/src/utils.ts').length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('uses-hook edges from component → hook-usage', () => {
    const root = setupReactFixture();
    try {
      buildFullIndex({ projectRoot: root });
      runExtractors({ projectRoot: root, only: ['react'] });
      const api = FrameworkQueryApi.fromStore(root);
      const hookEdges = api.edges().filter((e) => e.kind === EdgeKind.UsesHook);
      expect(hookEdges.length).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('react default-export components', () => {
  function extract(filePath: string, lines: string[]) {
    return reactExtractor.extract({
      filePath,
      content: lines.join('\n'),
      fileNodeId: `file:${filePath}`,
    });
  }
  function componentNodes(out: ReturnType<typeof reactExtractor.extract>) {
    return out.nodes.filter((n) => n.data?.['subtype'] === 'component');
  }

  test('arrow default export yields exactly one component', () => {
    const out = extract('packages/ui/src/Page.tsx', ['export default () => <div />;']);
    const components = componentNodes(out);
    expect(components.length).toBe(1);
    expect(components[0]!.data?.['name']).toBe('Page');
  });

  test('anonymous function default export yields exactly one component', () => {
    const out = extract('packages/ui/src/about.tsx', [
      'export default function () {',
      '  return <div>about</div>;',
      '}',
    ]);
    const components = componentNodes(out);
    expect(components.length).toBe(1);
    // PascalCase synthesized from the file basename.
    expect(components[0]!.data?.['name']).toBe('About');
  });

  test('hook call inside an arrow default export produces a UsesHook edge', () => {
    const out = extract('packages/ui/src/Widget.tsx', [
      "import { useState } from 'react';",
      'export default () => {',
      '  const [n, setN] = useState(0);',
      '  return <div>{n}</div>;',
      '};',
    ]);
    expect(componentNodes(out).length).toBe(1);
    const hookEdges = out.edges.filter((e) => e.kind === EdgeKind.UsesHook);
    expect(hookEdges.length).toBe(1);
  });

  test('arrow default export without JSX is not a component', () => {
    // Guard: a non-JSX default export (e.g. a config object factory) must
    // not be swept up as a component.
    const out = extract('packages/ui/src/config.ts', ['export default () => 42;']);
    expect(componentNodes(out).length).toBe(0);
  });
});
