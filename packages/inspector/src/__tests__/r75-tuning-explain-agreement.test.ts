/**
 * r75 — explain ≡ ranker, and ONE trigger tokenizer (spec 1.6#3).
 *
 * `shrk why` handed the tuning matcher BARE ids, so it reported a dead bare
 * boost as applied and hid the live prefixed ones; and five call sites
 * tokenized the query for the same matcher five ways, so a hyphenated trigger
 * (`changed-only`) fired in `shrk search` and never in `shrk task` /
 * `shrk context`. Real registries only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectSharkcraft, type ISharkcraftInspection } from '../sharkcraft-inspector.ts';
import { buildSearchIndex, searchIndex } from '../search-index.ts';
import { explainRankerDecision } from '../ranker-explainability.ts';
import { rankAll } from '../task-ranker.ts';
import { contextTuningBoostFor } from '../context-tuning.ts';
import { listSearchTuning, loadSearchTuning, SEARCH_TUNING_TOTAL_CAP } from '../search-tuning-registry.ts';
import { tuningQueryTokens } from '../tuning-query-tokens.ts';

const TIMEOUT_MS = 60_000;
const roots: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-explain-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'fx', knowledgeFiles: ['knowledge.ts'], ruleFiles: ['rules.ts'] };\n`,
    'sharkcraft/knowledge.ts': `export default [
  { id: 'alpha.entry', title: 'Alpha entry', type: 'architecture', priority: 'high', tags: ['alpha'], content: 'Alpha content about widgets.' },
  { id: 'gamma.entry', title: 'Gamma entry', type: 'architecture', priority: 'low', tags: ['captag'], content: 'Gamma content about widgets.' },
];
`,
    'sharkcraft/rules.ts': `export default [
  { id: 'fx.cob', title: 'Changed-only boundary scoping', type: 'rule', priority: 'high', scope: [], tags: ['boundaries'], appliesWhen: [], content: 'Scope the boundary check to the changed widgets.' },
];
`,
    'sharkcraft/search-tuning.ts': `export default [
  { id: 't.alpha', boostIds: { 'knowledge:alpha.entry': 3 }, taskHints: [{ whenTokens: ['widgets'], boostIds: { 'knowledge:alpha.entry': 2 } }] },
  { id: 't.bare', boostIds: { 'gamma.entry': 3 } },
  { id: 't.cap', boostTags: { captag: 5 }, boostIds: { 'knowledge:gamma.entry': 5 }, taskHints: [{ whenTokens: ['gamma'], boostIds: { 'knowledge:gamma.entry': 5 } }] },
  { id: 't.hyphen', taskHints: [{ whenTokens: ['changed-only'], boostIds: { 'rule:fx.cob': 4 } }] },
];
`,
  };
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

let insp: ISharkcraftInspection;

beforeAll(async () => {
  insp = await inspectSharkcraft({ cwd: workspace() });
  await loadSearchTuning(insp);
}, TIMEOUT_MS);

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function searchDelta(query: string, docId: string): number {
  const index = buildSearchIndex(insp);
  const tuned = searchIndex(index, { query, limit: 100 }, insp).hits.find((h) => h.document.id === docId);
  const base = searchIndex(index, { query, limit: 100, tuning: [] }).hits.find((h) => h.document.id === docId);
  expect(tuned).toBeDefined();
  expect(base).toBeDefined();
  return tuned!.score - base!.score;
}

describe('explain ≡ ranker', () => {
  test.each([
    ['alpha.entry', 'knowledge:alpha.entry', 'alpha widgets'],
    ['gamma.entry', 'knowledge:gamma.entry', 'gamma widgets'],
    ['fx.cob', 'rule:fx.cob', 'changed-only boundary widgets'],
  ])('%s: the tuning delta `why` reports is the delta search applies', (id, docId, query) => {
    const report = explainRankerDecision(insp, { id, query });
    expect(report.found).toBe(true);
    const raw = report.tuningTrace.reduce((sum, t) => sum + t.delta, 0);
    const applied = Math.max(-SEARCH_TUNING_TOTAL_CAP, Math.min(SEARCH_TUNING_TOTAL_CAP, raw));
    expect(searchDelta(query, docId)).toBeCloseTo(applied, 1);
  });

  test('the dead bare key is NOT in the trace; the live prefixed ones are', () => {
    const report = explainRankerDecision(insp, { id: 'gamma.entry', query: 'gamma widgets' });
    const reasons = report.tuningTrace.map((t) => `${t.tuningId} ${t.reasons.join(' ')}`);
    expect(reasons.some((r) => r.startsWith('t.bare'))).toBe(false);
    expect(reasons.some((r) => r.includes('id:knowledge:gamma.entry'))).toBe(true);
    // A search-document id names the same entry.
    const prefixed = explainRankerDecision(insp, { id: 'knowledge:gamma.entry', query: 'gamma widgets' });
    expect(prefixed.found).toBe(true);
    expect(prefixed.tuningTrace).toEqual(report.tuningTrace);
  });
});

describe('one trigger tokenizer', () => {
  test('a hyphenated whenToken fires in search, the task ranker AND the context re-ranker', () => {
    const query = 'changed-only boundary';
    const index = buildSearchIndex(insp);
    const hit = searchIndex(index, { query, limit: 50, explain: true }, insp).hits.find((h) => h.document.id === 'rule:fx.cob');
    expect(hit?.reasons.some((r) => r.includes('task-hint:id:rule:fx.cob'))).toBe(true);
    const ranked = rankAll(insp, query, 20, listSearchTuning(insp)).rules.find((r) => r.item.id === 'fx.cob');
    expect(ranked?.reasons.some((r) => r.includes('task-hint:id:rule:fx.cob'))).toBe(true);
    const boost = contextTuningBoostFor(insp, query)!;
    expect(boost({ id: 'fx.cob', type: 'rule' })).toBeGreaterThan(0);
  });

  test('superset: every token a former tokenizer produced is still produced', () => {
    const legacy = [
      (q: string) => q.toLowerCase().split(/[\s,.;:/]+/).map((t) => t.trim()).filter((t) => t.length > 1),
      (q: string) => q.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1),
      (q: string) => q.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3),
    ];
    const corpus = [
      'changed-only boundary',
      'Add a new MCP tool, read-only',
      'stale-check the knowledge; ci gate',
      'port c# / dotnet services to go',
      'min-severity: warning for template drift',
      'foo_bar.baz qux-quux (x) a',
      'PR summary for pull request #42',
    ];
    for (const q of corpus) {
      const now = new Set(tuningQueryTokens(q));
      for (const tokenize of legacy) {
        for (const t of tokenize(q)) expect({ q, t, kept: now.has(t) }).toEqual({ q, t, kept: true });
      }
    }
  });

  test('lock: every tuning caller reads THE tokenizer and THE codec', () => {
    const src = (f: string): string => readFileSync(join(import.meta.dir, '..', f), 'utf8');
    for (const f of ['search-index.ts', 'task-ranker.ts', 'context-tuning.ts', 'ranker-explainability.ts', 'search-tuning-explain.ts']) {
      expect({ f, reads: src(f).includes('tuningQueryTokens(') }).toEqual({ f, reads: true });
    }
    // The task ranker keeps its own SCORING tokenizer; its TUNING tokens come
    // from THE tuning tokenizer.
    expect(src('task-ranker.ts')).toMatch(/const tuningTokens = tuningQueryTokens\(task\);/);
    expect(src('context-tuning.ts')).not.toMatch(/\.split\(/);
    expect(src('search-tuning-explain.ts')).not.toMatch(/\.split\(/);
    const trace = src('ranker-explainability.ts');
    const body = trace.slice(trace.indexOf('function gatherTuningTrace'));
    const fn = body.slice(0, body.indexOf('\n}\n'));
    expect(fn).toContain('tuningQueryTokens(');
    expect(fn).not.toContain('tokenize(');
    // The `<prefix>:<id>` format is written by the codec only.
    const handWritten = /`(?:knowledge|rule|path|template|pipeline|preset|pack|boundary|bundle|session|construct|facet|playbook|doc):\$\{/;
    for (const f of ['search-index.ts', 'task-ranker.ts', 'context-tuning.ts', 'ranker-explainability.ts']) {
      expect({ f, handWritten: handWritten.test(src(f)) }).toEqual({ f, handWritten: false });
    }
  });
});
