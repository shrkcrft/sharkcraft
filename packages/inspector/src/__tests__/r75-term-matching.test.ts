/**
 * r75 — THE term matcher (spec 2.5 / 2.5#2 / 2.5#3).
 *
 * Routing hints, playbooks, the recommender's built-in recipes and the
 * change-intent domain keywords all used raw `lower.includes(needle)`: `ci`
 * fired inside "pricing", `gate` inside "investigate", `pr` inside "pricing",
 * and a `capability-pack` tag never matched "capability pack". One matcher
 * (`match-terms.ts`, over THE identifier tokenizer) now answers for all of
 * them; `mode: 'substring'` keeps the legacy behaviour on request, and the
 * loader warns about a short needle in that mode. Load issues (hints and
 * playbooks) reach the self-config doctor. Real loaders, mkdtemp workspaces.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { TermMatchMode, validateTaskRoutingHint } from '@shrkcrft/plugin-api';
import { classifyChangeIntent } from '../change-intent.ts';
import { recommendCommands } from '../command-recommender.ts';
import { matchTerm, prepareTermQuery, termsAgree } from '../match-terms.ts';
import { loadPlaybooks, loadPlaybooksWithIssues, recommendPlaybooks } from '../playbook-registry.ts';
import { buildSelfConfigDoctorReportV2 } from '../self-config-doctor-v2.ts';
import { inspectSharkcraft, type ISharkcraftInspection } from '../sharkcraft-inspector.ts';
import { explainTaskRouting, listTaskRoutingHintIssues } from '../task-routing-hint-registry.ts';

const TIMEOUT_MS = 90_000;
const roots: string[] = [];

function workspace(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-terms-'));
  roots.push(root);
  const all: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'r75-terms', version: '0.0.0', private: true }),
    'src/billing/index.ts': 'export const billing = 1;\n',
    'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'r75-terms' };\n`,
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

const HINTS = `export default [
  { id: 'pricing-block', title: 'Pricing block kind', match: { keywords: ['pricing', 'block'] }, recommends: { commands: ['shrk gen pricing.block <name> --dry-run'] } },
  { id: 'billing-refactor', title: 'Billing refactor', match: { keywords: ['billing', 'refactor'], phrases: ['billing module'] }, recommends: { commands: ['shrk graph importers src/billing/index.ts'] } },
  { id: 'ci-setup', title: 'CI setup', match: { keywords: ['ci'] }, recommends: { commands: ['shrk ci scaffold --provider github'] } },
  { id: 'gate-hint', title: 'Gates', match: { keywords: ['gate'] }, recommends: { commands: ['shrk gates check'] } },
  { id: 'capability-pack-hint', title: 'Capability pack', match: { keywords: ['capability-pack'] }, recommends: { commands: ['shrk packs new <name>'] } },
  { id: 'auth-substring', title: 'Auth (infix on purpose)', match: { mode: 'substring', keywords: ['auth'] }, recommends: { commands: ['shrk graph hubs'] } },
  { id: 'ui-substring', title: 'UI (short, substring)', match: { mode: 'substring', keywords: ['ui'] }, recommends: { commands: ['shrk graph hubs'] } },
];
`;

const PLAYBOOKS = `export default [
  {
    id: 'add-capability-pack',
    title: 'Add a capability pack',
    description: 'Author and register a new capability pack with manifest and signing.',
    tags: ['capability-pack'],
    steps: [{ id: 's1', title: 'Scaffold pack', commands: ['shrk packs new <name>'] }],
  },
  {
    id: 'generic-capability',
    title: 'Generic capability work',
    description: 'Any capability-related change.',
    tags: ['capability'],
    steps: [{ id: 's1', title: 'Context', commands: ['shrk context --task "<task>"'] }],
  },
  {
    id: 'ci-playbook',
    title: 'Continuous integration',
    tags: ['ci'],
    steps: [{ id: 's1', title: 'CI', commands: ['shrk ci scaffold'] }],
  },
];
`;

let insp: ISharkcraftInspection;

beforeAll(async () => {
  insp = await inspectSharkcraft({
    cwd: workspace({ 'sharkcraft/task-routing-hints.ts': HINTS, 'sharkcraft/playbooks.ts': PLAYBOOKS }),
  });
}, TIMEOUT_MS);

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe('r75 matchTerm — tokens mode', () => {
  const cases: readonly (readonly [string, string, boolean])[] = [
    ['ci', 'add a pricing table', false],
    ['gate', 'investigate the crash', false],
    ['block', 'the blocker in billing', false],
    ['capability-pack', 'add a capability pack', true],
    ['capability pack', 'add a capability-pack', true],
    ['capability_pack', 'add a Capability Pack', true],
    ['refactor', 'refactoring billing', true],
    ['gate', 'the gates are red', true],
    ['pack', 'package the release', false],
    ['pr', 'review my PR', true],
    ['pr', 'add a pricing block', false],
    ['boundary', 'two boundaries', true],
    ['plan', 'planning the release', true],
    ['', 'anything at all', false],
  ];
  test.each(cases)('matchTerm(%p) in %p → %p', (needle, query, expected) => {
    expect(matchTerm(prepareTermQuery(query), needle)).toBe(expected);
  });

  test('a two-letter term matches only itself — it never inflects', () => {
    expect(termsAgree('ci', 'cis')).toBe(false);
    expect(termsAgree('pr', 'prs')).toBe(false);
    expect(termsAgree('gate', 'gated')).toBe(true);
  });

  test('substring mode reproduces the legacy `lower.includes` exactly', () => {
    const needles = ['ci', 'gate', 'block', 'capability-pack', 'pack', 'auth', '', 'PR'];
    const queries = ['add a pricing table', 'investigate the crash', 'the blocker', 'add a capability pack', 'package', 'Authentication', 'review my PR'];
    for (const n of needles) {
      for (const q of queries) {
        const legacy = q.toLowerCase().includes(n.toLowerCase());
        expect({ n, q, got: matchTerm(prepareTermQuery(q), n, TermMatchMode.Substring) }).toEqual({ n, q, got: legacy });
      }
    }
  });
});

describe('r75 routing hints — token matching through explainTaskRouting', () => {
  test('`ci` does not fire inside "pricing"; `gate` does not fire inside "investigate"', async () => {
    const pricing = await explainTaskRouting(insp, 'add a pricing table');
    expect(pricing.map((m) => m.hint.id)).not.toContain('ci-setup');
    expect(pricing.map((m) => m.hint.id)).toContain('pricing-block');
    expect(await explainTaskRouting(insp, 'investigate the crash')).toEqual([]);
  }, TIMEOUT_MS);

  test('a hyphenated keyword matches the same words typed with spaces', async () => {
    const m = await explainTaskRouting(insp, 'add a capability pack');
    expect(m.map((x) => x.hint.id)).toContain('capability-pack-hint');
  }, TIMEOUT_MS);

  test("mode: 'substring' keeps infix matching, and the reason records the mode", async () => {
    const m = (await explainTaskRouting(insp, 'harden authentication')).find((x) => x.hint.id === 'auth-substring');
    expect(m).toBeDefined();
    expect(m!.reasons).toEqual(['keyword: auth (substring)']);
    // Tokens mode (the default) would not match `auth` inside `authentication`.
    expect(matchTerm(prepareTermQuery('harden authentication'), 'auth')).toBe(false);
  }, TIMEOUT_MS);

  test('the validator refuses an unknown mode and non-string keyword arrays', () => {
    const bad = validateTaskRoutingHint({ id: 'x', title: 'X', match: { mode: 'fuzzy', keywords: ['ok', 3] }, recommends: {} });
    expect(bad.valid).toBe(false);
    expect(bad.issues.map((i) => i.field).sort()).toEqual(['match.keywords', 'match.mode']);
    expect(validateTaskRoutingHint({ id: 'x', title: 'X', match: { mode: 'tokens', keywords: ['ok'] }, recommends: {} }).valid).toBe(true);
  });

  test("a needle under 4 chars in substring mode is a load warning; the same needle in tokens mode is not", async () => {
    const issues = await listTaskRoutingHintIssues(insp);
    const short = issues.filter((i) => i.code === 'short-substring-keyword');
    // `ui` (2 chars, substring) warns; `auth` (4 chars) does not.
    expect(short.map((i) => [i.hintId, i.severity])).toEqual([['ui-substring', 'warning']]);
    expect(short[0]!.message).toContain('"ui" (2 chars)');
    // `ci` is 2 chars but in tokens mode — an exact term, no warning.
    expect(issues.some((i) => i.hintId === 'ci-setup')).toBe(false);
    // …and the hazard it names is real: `ui` fires inside "build".
    const m = await explainTaskRouting(insp, 'build the checkout');
    expect(m.map((x) => x.hint.id)).toContain('ui-substring');
  }, TIMEOUT_MS);
});

describe('r75 playbooks — token matching + title/description weight', () => {
  test('the precisely-tagged playbook outranks the generic one on a realistic phrasing', async () => {
    const playbooks = await loadPlaybooks(insp);
    const recs = recommendPlaybooks(playbooks, 'please add a new capability pack for payments');
    expect(recs[0]!.playbook.id).toBe('add-capability-pack');
    const generic = recs.find((r) => r.playbook.id === 'generic-capability');
    expect(generic).toBeDefined();
    expect(recs[0]!.score).toBeGreaterThan(generic!.score);
  }, TIMEOUT_MS);

  test('`ci` does not recommend the CI playbook for "add a pricing table", and one shared verb recommends nothing', async () => {
    const playbooks = await loadPlaybooks(insp);
    const recs = recommendPlaybooks(playbooks, 'add a pricing table');
    expect(recs.map((r) => r.playbook.id)).not.toContain('ci-playbook');
    // "add" alone appears in the add-capability-pack title — not a recommendation.
    expect(recs.map((r) => r.playbook.id)).not.toContain('add-capability-pack');
  }, TIMEOUT_MS);
});

describe('r75 built-in recipes and change-intent domains use THE matcher (2.5#2)', () => {
  test('`pr` no longer fires the review recipe inside "pricing"; "review my PR" still does', async () => {
    const pricing = await recommendCommands(insp, 'add a pricing block kind');
    expect(pricing.ranked.some((c) => c.command.startsWith('shrk review packet'))).toBe(false);
    const review = await recommendCommands(insp, 'review my PR');
    const row = review.recommendations.find((r) => r.command.startsWith('shrk review packet'));
    expect(row).toBeDefined();
    expect(row!.sourceId).toBe('review');
  }, TIMEOUT_MS);

  test('the pack recipe no longer fires on "package"', async () => {
    const r = await recommendCommands(insp, 'package the release notes');
    expect(r.ranked.some((c) => c.sourceId === 'packs')).toBe(false);
  }, TIMEOUT_MS);

  test('domain `ci` does not fire on "decide on a specific policy"; `mcp` still fires on its own term', async () => {
    const policy = await classifyChangeIntent('decide on a specific policy', insp);
    expect(policy.domains).not.toContain('ci');
    expect(policy.domains).toContain('safety');
    const mcp = await classifyChangeIntent('add a new MCP tool for compliance check', insp);
    expect(mcp.domains).toContain('mcp');
    const design = await classifyChangeIntent('design the pricing page', insp);
    expect(design.domains).not.toContain('pack'); // `sign` inside "design"
  }, TIMEOUT_MS);
});

describe('r75 hint + playbook load issues reach the self-config doctor (2.5#3)', () => {
  test('duplicate hint id, a short substring keyword and a broken playbooks.ts are all findings', async () => {
    const root = workspace({
      'sharkcraft/task-routing-hints.ts': `export default [
  { id: 'h.one', title: 'One', match: { keywords: ['alpha'] }, recommends: { commands: ['shrk doctor'] } },
  { id: 'h.one', title: 'One again', match: { keywords: ['beta'] }, recommends: { commands: ['shrk doctor'] } },
  { id: 'h.short', title: 'Short', match: { mode: 'substring', keywords: ['ci'] }, recommends: { commands: ['shrk doctor'] } },
];
`,
      // Two adjacent string literals inside an object: a hard syntax error.
      'sharkcraft/playbooks.ts': `export default [{ id: 'pb.broken' 'oops', title: 'Broken', steps: [] }];\n`,
    });
    const inspection = await inspectSharkcraft({ cwd: root });
    const loaded = await loadPlaybooksWithIssues(inspection);
    expect(loaded.files).toBe(1);
    expect(loaded.issues.map((i) => i.code)).toEqual(['load-failed']);
    const report = await buildSelfConfigDoctorReportV2(inspection);
    const codes = report.findings.map((f) => f.code);
    expect(codes).toContain('routing-hint-duplicate-id');
    expect(codes).toContain('routing-hint-short-substring-keyword');
    expect(codes).toContain('playbook-load-failed');
    const files = report.coverage.find((c) => c.subject === 'playbooks' && c.unit === 'playbook files');
    expect(files).toMatchObject({ expected: 1, examined: 0, unexamined: ['sharkcraft/playbooks.ts'] });
  }, TIMEOUT_MS);

  test('a broken playbooks.ts alone is NOT a healthy registry: the verdict is errors, like a broken hint file', async () => {
    // Round 11 (integration lane, item 7): playbook load failures now reach
    // the async inventory's load failures, so a broken playbook file gets the
    // same `pack-conflict:invalid-contribution` error a broken hint file gets
    // (it was only `unverified` through its file coverage).
    const root = workspace({
      'sharkcraft/playbooks.ts': `export default [{ id: 'pb.broken' 'oops', title: 'Broken', steps: [] }];\n`,
    });
    const report = await buildSelfConfigDoctorReportV2(await inspectSharkcraft({ cwd: root }));
    expect(report.findings.some((f) => f.code === 'playbook-load-failed')).toBe(true);
    expect(report.findings.some((f) => f.code === 'pack-conflict:invalid-contribution')).toBe(true);
    expect(report.verdict).toBe('errors');
  }, TIMEOUT_MS);

  test('a broken hint file is counted as an unexamined hint file', async () => {
    const root = workspace({
      'sharkcraft/task-routing-hints.ts': `export default [{ id: 'h.broken' 'x', title: 'B', match: {}, recommends: {} }];\n`,
    });
    const report = await buildSelfConfigDoctorReportV2(await inspectSharkcraft({ cwd: root }));
    expect(report.findings.some((f) => f.code === 'routing-hint-load-failed')).toBe(true);
    const files = report.coverage.find((c) => c.subject === 'routing hints' && c.unit === 'hint files');
    expect(files).toMatchObject({ expected: 1, examined: 0 });
    // Never a pass: the file coverage alone makes it `unverified`; the pack
    // inventory's invalid-contribution error (packs lane) makes it `errors`.
    expect(['errors', 'unverified']).toContain(report.verdict);
  }, TIMEOUT_MS);

  test('healthy files: full file coverage, no load findings', async () => {
    const report = await buildSelfConfigDoctorReportV2(insp);
    expect(report.findings.some((f) => f.code.endsWith('-load-failed'))).toBe(false);
    expect(report.coverage.find((c) => c.subject === 'playbooks')).toMatchObject({ expected: 1, examined: 1 });
    expect(report.coverage.find((c) => c.unit === 'hint files')).toMatchObject({ expected: 1, examined: 1 });
  }, TIMEOUT_MS);
});
