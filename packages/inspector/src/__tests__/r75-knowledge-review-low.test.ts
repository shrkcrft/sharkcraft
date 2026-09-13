/**
 * Round 11 review, low-severity findings — each on a real workspace through
 * the real config loader and inspector:
 *
 *   - `conventionFiles: ['conventions.ts']` naming the default file loads it
 *     ONCE (every doctor issue used to be listed twice);
 *   - a dangling cross-reference's did-you-mean never suggests the source's
 *     own id (that advice writes a self-supersession);
 *   - the member message picks its article from the words (`an object key`);
 *   - the engine's `count` never walks the sharkcraft dir unless asked.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadConventions } from '../convention-registry.ts';
import { buildDeclaredXrefReport } from '../declared-cross-references.ts';
import { DeclaredXrefStatus } from '../declared-xref-status.ts';
import { buildKnowledgeStaleReport } from '../knowledge-stale.ts';
import { inspectSharkcraft } from '../sharkcraft-inspector.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-klow-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const PKG = JSON.stringify({ name: 'klow', version: '0.0.0' });

function k(id: string, extra = ''): string {
  return `{ id: '${id}', title: '${id}', type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: 'About ${id}.'${extra ? `, ${extra}` : ''} }`;
}

describe('conventions: a file named twice is loaded once', () => {
  const CONVENTIONS =
    "export default [{ id: 'conv.bad', title: 'Bad', severity: 'critical', references: [{ kind: 'not-a-real-kind' }] }];\n";

  test('conventionFiles naming the default file: one file scanned, the issues of one load', async () => {
    const plain = tree({
      'package.json': PKG,
      'sharkcraft/conventions.ts': CONVENTIONS,
      'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'klow' };\n",
    });
    const named = tree({
      'package.json': PKG,
      'sharkcraft/conventions.ts': CONVENTIONS,
      'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'klow', conventionFiles: ['conventions.ts'] };\n",
    });
    const once = await loadConventions(await inspectSharkcraft({ cwd: plain }));
    const twice = await loadConventions(await inspectSharkcraft({ cwd: named }));
    expect(twice.files.discovered).toBe(1);
    expect(twice.files.discovered).toBe(once.files.discovered);
    expect(twice.issues.length).toBe(once.issues.length);
    expect(twice.issues.length).toBeGreaterThan(0);
  }, 60_000);
});

describe('cross-references: did-you-mean never names the source itself', () => {
  test('app.old supersededBy a dangling id is never told "did you mean app.old"', async () => {
    const root = tree({
      'package.json': PKG,
      'sharkcraft/knowledge.ts': `export default [${k('app.old', "supersededBy: ['app.gone']")}];\n`,
      'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'klow', knowledgeFiles: ['knowledge.ts'] };\n",
    });
    const report = await buildDeclaredXrefReport(await inspectSharkcraft({ cwd: root }));
    const row = report.rows.find((r) => r.sourceId === 'app.old' && r.field === 'supersededBy');
    expect(row?.status).toBe(DeclaredXrefStatus.Dangling);
    expect(row?.didYouMean).not.toContain('app.old');
    expect(row?.message).not.toContain('did you mean "app.old"');
  }, 60_000);
});

describe('stale engine', () => {
  test('a bare object-key member reads "is an object key of", never "is a object-key"', async () => {
    const root = tree({
      'package.json': PKG,
      'src/reg.ts': 'export const registry = { alpha: 1, beta: 2 };\n',
      'sharkcraft/knowledge.ts': `export default [${k('k.member', "references: [{ kind: 'symbol', path: 'src/reg.ts', symbol: 'alpha' }]")}];\n`,
      'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'klow', knowledgeFiles: ['knowledge.ts'] };\n",
    });
    const report = buildKnowledgeStaleReport(await inspectSharkcraft({ cwd: root }));
    const msg = report.referenceChecks[0]!.message;
    expect(msg).toContain('is an object key of `registry`');
    expect(msg).not.toContain('is a object-key');
  }, 60_000);

  test('count: the sharkcraft dir is excluded by default, and walked when a caller passes excludeDirs: []', async () => {
    const root = tree({
      'package.json': PKG,
      'src/a.ts': 'registerService("alpha");\nregisterService("beta");\n',
      'sharkcraft/knowledge.ts':
        String.raw`export default [{ id: 'k.count', title: 'Count', type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: 'Each via registerService("<name>").', references: [{ kind: 'file', path: 'src/a.ts', count: { source: { files: ['**/*.ts'], pattern: 'registerService\\("([a-z<>]+)"\\)' }, expected: 2, measure: 'ids' } }] }];` +
        '\n',
      'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'klow', knowledgeFiles: ['knowledge.ts'] };\n",
    });
    const inspection = await inspectSharkcraft({ cwd: root });
    expect(buildKnowledgeStaleReport(inspection).referenceChecks[0]).toMatchObject({ outcome: 'ok', actual: 2 });
    // An explicit (empty) exclusion list is honoured verbatim — the prose then counts itself.
    expect(buildKnowledgeStaleReport(inspection, { excludeDirs: [] }).referenceChecks[0]).toMatchObject({ actual: 3 });
  }, 60_000);
});
