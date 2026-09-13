/**
 * Round 11, 4.2 — declared cross-references, end to end through the CLI
 * (spawned from source) and the MCP `get_knowledge` handler.
 *
 * Before: `self-config doctor` / `broken-links` printed ✓ over ids no
 * registry had, `constructs related` rendered a dangling id exactly like a live
 * one, there was no way to ask which namespace an id lives in, `knowledge get`
 * rendered prose "SUPERSEDED — see x" that nothing checked, and `knowledge
 * remove` let an entry a construct relied on be removed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectSharkcraft, isCommandResolved, type ReferenceKind } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '@shrkcrft/mcp-server';
import { REFERENCE_KIND_VERBS } from '../commands/self-config-xrefs.command.ts';
import { buildRegistry } from '../main.ts';
import { buildCommandIndex } from '../surface/command-index.ts';
import { resolveCommandString } from '../surface/resolve-command-string.ts';

const REPO = join(import.meta.dir, '..', '..', '..', '..');
const MAIN = join(REPO, 'packages/cli/src/main.ts');
const T = 180_000;

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function shrk(cwd: string, argv: readonly string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('bun', [MAIN, '--cwd', cwd, ...argv], {
    cwd: REPO,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 150_000,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const k = (id: string, extra = ''): string =>
  `{ id: '${id}', title: 'T ${id}', type: 'architecture', priority: 'medium', scope: ['typescript'], tags: ['t'], appliesWhen: ['onboard'], content: 'Body of ${id}.'${extra ? `, ${extra}` : ''} }`;

/**
 * `full`: every field, dangling and live, plus error-severity declarations
 * (a dangling supersededBy, a supersession chain, an unknown facet kind).
 * `warnings`: only warning-severity dangling ids — the doctor passes unless --strict.
 */
function fixture(shape: 'full' | 'warnings'): string {
  const root = mkdtempSync(join(tmpdir(), `shrk-r75-xrefcli-${shape}-`));
  roots.push(root);
  const full = shape === 'full';
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: `r75-xrefcli-${shape}`, version: '0.0.0', private: true }),
    'src/index.ts': 'export const x = 1;\n',
    'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'xrefcli', knowledgeFiles: ['knowledge.ts'], ruleFiles: ['rules.ts'], templateFiles: ['templates.ts'] };\n`,
    'sharkcraft/rules.ts': `export default [{ id: 'fx.rule.one', title: 'Rule one', type: 'rule', priority: 'high', scope: ['typescript'], tags: ['rule'], appliesWhen: ['generate-code'], content: 'Rule one content.' }];\n`,
    'sharkcraft/knowledge.ts': `export default [
  ${k('app.overview', `related: ['app.ghost-entry']`)},
  ${k('app.valid', `related: ['app.overview', 'fx.rule.one', 'fx-construct']`)},
  ${full ? `${k('app.old-way', `supersededBy: ['app.new-way']`)},
  ${k('app.chain-a', `supersededBy: ['app.chain-b']`)},
  ${k('app.chain-b', `supersededBy: ['app.chain-c']`)},
  ${k('app.chain-c')},` : ''}
];
`,
    'sharkcraft/templates.ts': `export default [{ id: 'fx.service', name: 'Svc', description: 'Renders a service.', tags: [], scope: [], appliesWhen: [], variables: [], targetPath: 'src/svc.ts', content: 'export {};\\n', related: ['ghost.template-related'] }];\n`,
    'sharkcraft/constructs.ts': `export default [{
  id: 'fx-construct', type: 'service', title: 'Fixture construct', files: ['src/index.ts'], publicApi: ['src/index.ts'],
  relatedRules: ['ghost.rule-a', 'fx.service'],
  relatedKnowledge: ['ghost.knowledge-a'${full ? `, 'app.old-way'` : ''}],
  ${full ? `facets: { 'boundary-rules': [{ id: 'b1', value: 'ghost.boundary-a', resolvesAs: ['boundary-rule'] }], 'bad-kind': [{ id: 'k1', value: 'x', resolvesAs: ['bogus'] }] },` : ''}
}];
`,
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

let full: string;
let warn: string;
beforeAll(() => {
  full = fixture('full');
  warn = fixture('warnings');
});

describe('self-config doctor / broken-links report dangling ids', () => {
  test('a dangling related id is a warning: exit 0, --strict exits 1, text and JSON agree', () => {
    const text = shrk(warn, ['self-config', 'doctor']);
    expect(text.stdout).toContain('[xref-dangling]');
    expect(text.stdout).toContain('[xref-wrong-kind]');
    expect(text.stdout).toMatch(/xrefs\s+\d+ id\(s\) across \d+ field\(s\) · 4 dangling · 1 wrong-kind/);
    expect(text.status).toBe(0);
    expect(shrk(warn, ['self-config', 'doctor', '--strict']).status).toBe(1);
    const json = JSON.parse(shrk(warn, ['self-config', 'doctor', '--json']).stdout) as {
      exitCode: number;
      findings: { code: string; targetId: string }[];
    };
    expect(json.exitCode).toBe(0);
    expect(json.findings.filter((f) => f.code === 'xref-dangling').map((f) => f.targetId).sort()).toEqual([
      'app.ghost-entry',
      'ghost.knowledge-a',
      'ghost.rule-a',
      'ghost.template-related',
    ]);
  }, T);

  test('a dangling supersededBy / unknown facet kind is an ERROR: exit 1', () => {
    const res = shrk(full, ['self-config', 'doctor']);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('[xref-unknown-kind]');
    expect(res.stdout).toContain('[xref-superseded-chain]');
  }, T);

  test('broken-links lists the same dangling edges (it used to print ✓) and exits 1', () => {
    const res = shrk(warn, ['self-config', 'broken-links', '--json']);
    expect(res.status).toBe(1);
    const body = JSON.parse(res.stdout) as { brokenEdges: { to: { id: string }; relation: string }[]; exitCode: number };
    expect(body.exitCode).toBe(1);
    expect(body.brokenEdges.map((e) => e.to.id).sort()).toEqual(
      ['app.ghost-entry', 'fx.service', 'ghost.knowledge-a', 'ghost.rule-a', 'ghost.template-related'].sort(),
    );
    expect(body.brokenEdges.find((e) => e.to.id === 'ghost.rule-a')?.relation).toBe('relatedRules');
  }, T);
});

describe('the lookup verbs', () => {
  test('resolve: every namespace, most specific first, and who points at it', () => {
    const res = shrk(full, ['self-config', 'resolve', 'fx.rule.one']);
    expect(res.status).toBe(0);
    const ruleAt = res.stdout.indexOf('• rule');
    const knowledgeAt = res.stdout.indexOf('• knowledge');
    expect(ruleAt).toBeGreaterThan(0);
    expect(knowledgeAt).toBeGreaterThan(ruleAt);
    expect(res.stdout).toContain('shrk rules get fx.rule.one');
    expect(res.stdout).toContain('knowledge:app.valid related');
  }, T);

  test('resolve: an unknown id exits 1 with did-you-mean; no id exits 3', () => {
    const miss = shrk(full, ['self-config', 'resolve', 'fx.rule.onee', '--json']);
    expect(miss.status).toBe(1);
    const body = JSON.parse(miss.stdout) as { resolved: boolean; didYouMean: string[] };
    expect(body.resolved).toBe(false);
    expect(body.didYouMean).toContain('fx.rule.one');
    expect(shrk(full, ['self-config', 'resolve']).status).toBe(3);
  }, T);

  test('xrefs --source prints one asset\'s extracted set with statuses; a bad --source exits 3', () => {
    const res = shrk(full, ['self-config', 'xrefs', '--source', 'construct:fx-construct', '--json']);
    expect(res.status).toBe(0);
    const body = JSON.parse(res.stdout) as {
      rows: { field: string; targetId: string; status: string; resolvedAs: string[] }[];
      issues: { code: string }[];
    };
    const got = body.rows.map((r) => `${r.field}:${r.targetId}:${r.status}`).sort();
    expect(got).toEqual(
      [
        'relatedRules:ghost.rule-a:dangling',
        'relatedRules:fx.service:wrong-kind',
        'relatedKnowledge:ghost.knowledge-a:dangling',
        'relatedKnowledge:app.old-way:ok',
        'facets.boundary-rules:ghost.boundary-a:dangling',
      ].sort(),
    );
    expect(body.issues.map((i) => i.code)).toEqual(['xref-unknown-kind']);
    expect(shrk(full, ['self-config', 'xrefs', '--source', 'bogus:x']).status).toBe(3);
  }, T);

  test('constructs related: each id with its resolved namespace, or UNRESOLVED', () => {
    const text = shrk(full, ['constructs', 'related', 'fx-construct']);
    expect(text.stdout).toContain('[rule] ghost.rule-a  UNRESOLVED');
    expect(text.stdout).toContain('[rule] fx.service  WRONG KIND — resolves as template');
    const json = JSON.parse(shrk(full, ['constructs', 'related', 'fx-construct', '--json']).stdout) as {
      related: { id: string; kind: string; status: string; resolvedAs: string[] }[];
    };
    expect(json.related.find((r) => r.id === 'app.old-way')).toEqual({
      kind: 'knowledge',
      id: 'app.old-way',
      resolvedAs: ['knowledge'],
      status: 'ok',
    });
  }, T);

  test('every verb `resolve` prints for a kind resolves through the live command index', () => {
    // A renamed verb would otherwise be printed as a dead command.
    const index = buildCommandIndex(buildRegistry());
    const dead = Object.entries(REFERENCE_KIND_VERBS)
      .map(([kind, verb]) => ({ kind: kind as ReferenceKind, verb: verb.replace('<id>', 'x') }))
      .filter(({ verb }) => !isCommandResolved(resolveCommandString(index, verb)));
    expect(dead).toEqual([]);
    expect(Object.keys(REFERENCE_KIND_VERBS).length).toBeGreaterThanOrEqual(10);
  });
});

describe('supersededBy routes the reader; remove sees every namespace', () => {
  test('knowledge get: the banner names the (unresolved) successor; --follow renders the current entry', () => {
    const old = shrk(full, ['knowledge', 'get', 'app.old-way']);
    expect(old.status).toBe(0);
    expect(old.stdout.split('\n')[2]).toBe('SUPERSEDED by: app.new-way (UNRESOLVED — no registry has this id)');
    const follow = shrk(full, ['knowledge', 'get', 'app.chain-a', '--follow']);
    expect(follow.stdout).toContain('SUPERSEDED by: app.chain-b (knowledge — "T app.chain-b")  →  shrk knowledge get app.chain-b');
    expect(follow.stdout).toContain('--- following supersededBy: app.chain-a → app.chain-b → app.chain-c ---');
    expect(follow.stdout).toContain('# T app.chain-c');
    // --json is the entry itself, carrying the native field.
    const json = JSON.parse(shrk(full, ['knowledge', 'get', 'app.old-way', '--json']).stdout) as { supersededBy: string[] };
    expect(json.supersededBy).toEqual(['app.new-way']);
  }, T);

  test('knowledge remove is refused when only a construct points at the entry', () => {
    const res = shrk(full, ['knowledge', 'remove', 'app.old-way']);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('construct:fx-construct (relatedKnowledge)');
  }, T);

  test('MCP get_knowledge: the text form carries the banner (the data is the entry, unchanged)', async () => {
    const tool = ALL_TOOLS.find((t) => t.name === 'get_knowledge');
    expect(tool).toBeDefined();
    const inspection = await inspectSharkcraft({ cwd: full });
    const res = (await tool!.handler({ id: 'app.chain-b' }, { inspection, cwd: full } as never)) as {
      text?: string;
      data?: { id: string };
    };
    expect(res.text).toContain('SUPERSEDED by: app.chain-c (knowledge — "T app.chain-c")');
    expect(res.data?.id).toBe('app.chain-b');
  }, T);
});

describe('shrk quality', () => {
  test('carries a cross-references item whose repro computes the same report (`self-config xrefs`)', () => {
    const res = shrk(warn, ['quality', '--json']);
    const body = JSON.parse(res.stdout) as { items: { id: string; repro: string; status: string; severity: string }[] };
    const item = body.items.find((i) => i.id === 'cross-references');
    // Round 13: `self-config doctor` computes a different report than the item.
    expect(item?.repro).toBe('shrk self-config xrefs');
    // Warning-severity dangling ids: reported, non-blocking without --strict.
    expect(item?.status).toBe('failed');
    expect(item?.severity).toBe('warning');
  }, T);
});
