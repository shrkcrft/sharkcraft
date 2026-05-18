import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import {
  buildResourceList,
  knowledgeUri,
  OVERVIEW_URI,
  parseResourceUri,
  readResource,
  templateUri
} from '../index.ts';

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-resources-test-'));
  mkdirSync(join(root, 'sharkcraft', 'docs'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', version: '1.0.0' }),
  );
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    `export default {\n  projectName: 'demo',\n  knowledgeFiles: ['knowledge.ts'],\n  templateFiles: [],\n  docsFiles: ['docs/overview.md'],\n};\n`,
  );
  writeFileSync(
    join(root, 'sharkcraft', 'knowledge.ts'),
    `export default [{\n  id: 'sample.rule',\n  title: 'Sample rule',\n  type: 'rule',\n  priority: 'high',\n  scope: ['ts'],\n  tags: ['demo'],\n  appliesWhen: ['demo-action'],\n  content: 'always do the right thing.',\n}];\n`,
  );
  writeFileSync(
    join(root, 'sharkcraft', 'docs', 'overview.md'),
    `# Demo\n\nA tiny test fixture.\n`,
  );
  return root;
}

describe('parseResourceUri', () => {
  test('parses overview', () => {
    const r = parseResourceUri(OVERVIEW_URI);
    expect(r.kind).toBe('overview');
  });
  test('parses knowledge with id', () => {
    const r = parseResourceUri(knowledgeUri('foo.bar'));
    expect(r.kind).toBe('knowledge');
    expect(r.id).toBe('foo.bar');
  });
  test('parses template with id', () => {
    const r = parseResourceUri(templateUri('typescript.service'));
    expect(r.kind).toBe('template');
    expect(r.id).toBe('typescript.service');
  });
  test('parses docs path', () => {
    const r = parseResourceUri('sharkcraft://docs/docs/overview.md');
    expect(r.kind).toBe('docs');
    expect(r.path).toBe('docs/overview.md');
  });
  test('returns unknown for foreign scheme', () => {
    expect(parseResourceUri('file:///etc/passwd').kind).toBe('unknown');
  });
});

describe('buildResourceList + readResource', () => {
  test('list contains overview + agent-instructions + each knowledge entry + each doc', async () => {
    const root = makeProject();
    const inspection = await inspectSharkcraft({ cwd: root });
    const list = buildResourceList(inspection);
    expect(list.some((r) => r.uri === OVERVIEW_URI)).toBe(true);
    expect(list.some((r) => r.uri === 'sharkcraft://agent-instructions')).toBe(true);
    expect(list.some((r) => r.uri === knowledgeUri('sample.rule'))).toBe(true);
    expect(list.some((r) => r.uri.startsWith('sharkcraft://docs/'))).toBe(true);
  });

  test('reads overview text', async () => {
    const root = makeProject();
    const inspection = await inspectSharkcraft({ cwd: root });
    const result = readResource(inspection, OVERVIEW_URI);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contents[0]?.mimeType).toBe('text/plain');
      expect(result.contents[0]?.text).toContain('demo');
    }
  });

  test('reads a knowledge entry', async () => {
    const root = makeProject();
    const inspection = await inspectSharkcraft({ cwd: root });
    const result = readResource(inspection, knowledgeUri('sample.rule'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contents[0]?.text).toContain('Sample rule');
    }
  });

  test('reads a doc markdown file', async () => {
    const root = makeProject();
    const inspection = await inspectSharkcraft({ cwd: root });
    const result = readResource(inspection, 'sharkcraft://docs/docs/overview.md');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contents[0]?.text).toContain('Demo');
    }
  });

  test('rejects doc paths escaping sharkcraft/', async () => {
    const root = makeProject();
    const inspection = await inspectSharkcraft({ cwd: root });
    const result = readResource(inspection, 'sharkcraft://docs/../../etc/passwd');
    expect(result.ok).toBe(false);
  });

  test('errors on missing knowledge id', async () => {
    const root = makeProject();
    const inspection = await inspectSharkcraft({ cwd: root });
    const result = readResource(inspection, knowledgeUri('nope.nope'));
    expect(result.ok).toBe(false);
  });
});
