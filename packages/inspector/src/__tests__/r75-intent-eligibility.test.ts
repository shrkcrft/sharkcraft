/**
 * r75 — ONE query-intent classifier gates recommendation eligibility (spec 2.3).
 *
 * A diagnostic or repair query used to get a create-new-thing scaffold as its
 * headline — `looksLikeScaffolding` read "build" (a noun) and "new" (an
 * adjective) as create verbs, and three classifiers answered the question.
 * `classifyQueryIntent` is the one authority now; a source-writing candidate
 * is ineligible for non-create work, and a ranker match needs ≥ 2 distinct
 * query terms. Real registries (mkdtemp workspace through inspectSharkcraft).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { recommendCommands } from '../command-recommender.ts';
import { classifyQueryIntent } from '../query-intent.ts';
import { QueryIntent } from '../query-intent-kind.ts';
import { rankRecommendationCandidates } from '../recommendation-ranking.ts';
import { intentIsRepairOrDiagnosis } from '../query-intent.ts';
import { buildTaskPacket } from '../task-packet.ts';
import { RecommendationSource } from '../recommendation-source.ts';
import { RecommendationSuppression } from '../recommendation-suppression.ts';
import { inspectSharkcraft, type ISharkcraftInspection } from '../sharkcraft-inspector.ts';

const TIMEOUT_MS = 90_000;
let root = '';
let insp: ISharkcraftInspection;

const SCAFFOLD = 'shrk gen billing.feature <name> --dry-run';

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'shrk-r75-intent-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'r75-intent', version: '0.0.0', private: true }),
    'src/billing/index.ts': 'export const billing = 1;\n',
    'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'r75-intent', templateFiles: ['templates.ts'], pipelineFiles: ['pipelines.ts'] };\n`,
    'sharkcraft/templates.ts': `export default [{
  id: 'billing.feature',
  name: 'Billing feature module',
  description: 'Creates a billing feature module under src/billing/.',
  tags: ['billing', 'feature'],
  scope: ['typescript'],
  appliesWhen: ['generate-code'],
  variables: [{ name: 'name', required: true, description: 'kebab-case name' }],
  targetPath: ({ name }: { name: string }) => \`src/billing/\${name}.ts\`,
  content: () => 'export const x = 1;\\n',
}];
`,
    'sharkcraft/pipelines.ts': `export default [{
  id: 'billing-create-feature',
  title: 'Billing: create new feature',
  description: 'Scaffold a new billing feature module with service, route and tests.',
  tags: ['feature', 'generation', 'billing'],
  inputs: [{ name: 'task', required: true }],
  steps: [
    { id: 'billing-scaffold', type: 'generate', references: ['billing.feature'], description: 'Generate the billing feature skeleton.', instruction: 'Run shrk gen billing.feature for the billing module.' },
    { id: 'billing-verify', type: 'validate', description: 'Verify the billing module builds and boundary checks pass.' },
  ],
}];
`,
    'sharkcraft/task-routing-hints.ts': `export default [
  { id: 'pricing-block', title: 'Pricing block kind', match: { keywords: ['pricing', 'block'] }, recommends: { commands: ['shrk gen pricing.block <name> --dry-run'] } },
  { id: 'billing-refactor', title: 'Billing refactor', match: { keywords: ['billing', 'refactor'], phrases: ['billing module'] }, recommends: { commands: ['shrk graph importers src/billing/index.ts', 'shrk check orphans'] } },
  { id: 'boundary-repair', title: 'Repair a boundary violation', match: { keywords: ['boundary', 'violation'], phrases: ['boundary violation'] }, recommends: { commands: ['shrk check boundaries --explain', 'shrk graph why <from> <to>'] } },
];
`,
  };
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  insp = await inspectSharkcraft({ cwd: root });
}, TIMEOUT_MS);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('r75 the task packet reads the same eligibility as recommend (R11-GAP-6)', () => {
  test('a repair query: no scaffold pipeline, no template, no suggested generation, no `gen` — and recommend agrees', async () => {
    const q = 'fix the broken billing build';
    expect(intentIsRepairOrDiagnosis(classifyQueryIntent(q))).toBe(true);
    const packet = buildTaskPacket(insp, q, { compact: false });
    expect(packet.recommendedPipelines.map((p) => p.pipelineId)).not.toContain('billing-create-feature');
    expect(packet.relevantTemplates).toEqual([]);
    expect(packet.suggestedGen).toBeUndefined();
    expect(packet.recommendedCliCommands.filter((c) => /\bshrk gen\b/.test(c))).toEqual([]);
    const ranked = await rankRecommendationCandidates(insp, q);
    expect(ranked.recommendations.some((r) => /^shrk gen\b/.test(r.command))).toBe(false);
  }, TIMEOUT_MS);

  test('a create query keeps them: the scaffold pipeline, the template and a suggested generation', async () => {
    const q = 'create a new billing feature module';
    expect(classifyQueryIntent(q).intent).toBe(QueryIntent.Create);
    const packet = buildTaskPacket(insp, q, { compact: false });
    expect(packet.relevantTemplates.map((t) => t.id)).toContain('billing.feature');
    expect(packet.recommendedPipelines.map((p) => p.pipelineId)).toContain('billing-create-feature');
    expect(packet.suggestedGen?.templateId).toBe('billing.feature');
  }, TIMEOUT_MS);
});

describe('r75 classifyQueryIntent — the one intent classifier', () => {
  // The DX#2 / R1 cases the CLI wrappers (looksLikePlanning / looksLikeCreateBuild) lock.
  const createCases: readonly (readonly [string, boolean])[] = [
    ['add a pricing-table block kind', true],
    ['create a new service', true],
    ['build the checkout flow', true],
    ['scaffold a plugin', true],
    ['implement the parser', true],
    ['please add a new block kind', true],
    ['I want to generate a route', true],
    ["let's add a pricing block", true],
    ['plan the billing module', false],
    ['review the migration', false],
    ['fix a typo', false],
    ['', false],
    ['the feature we should add later', false],
    // The 2.3 repros: a create word used as a noun / adjective in a repair query.
    ['fix the broken build in billing', false],
    ['why does the new billing route fail', false],
    ['build is broken', false],
  ];
  test.each(createCases)('createVerb(%p) defined → %p', (q, expected) => {
    expect(classifyQueryIntent(q).createVerb !== undefined).toBe(expected);
  });

  const planCases: readonly (readonly [string, boolean])[] = [
    ['plan billing module', true],
    ['design the API surface', true],
    ['review approach to authentication', true],
    ['help me plan a billing module', true],
    ['I want to design the api', true],
    ['we should review the migration', true],
    ['add new endpoint', false],
    ['refactor the billing module', false],
    ['add a feature that works according to the plan', false],
    ['build the system as designed by the architect', false],
    ['   ', false],
    ['Plan: billing module', true],
    ['"design the api"', true],
  ];
  test.each(planCases)('planVerb(%p) defined → %p', (q, expected) => {
    expect(classifyQueryIntent(q).planVerb !== undefined).toBe(expected);
  });

  const intentCases: readonly (readonly [string, QueryIntent])[] = [
    ['fix the broken build in billing', QueryIntent.Repair],
    ['fix the boundary violation in billing', QueryIntent.Repair],
    ['why does the new billing route fail', QueryIntent.Diagnose],
    ['investigate the crash', QueryIntent.Diagnose],
    ['add a fix for the crash', QueryIntent.Create],
    ['add error handling to the parser', QueryIntent.Create],
    ['review my PR', QueryIntent.Review],
    ['review approach to authentication', QueryIntent.Plan],
    ['analyze the billing dependencies', QueryIntent.Plan],
    ['plan to add a billing module', QueryIntent.Plan],
    ['refactor the billing module', QueryIntent.Refactor],
    ['publish alpha', QueryIntent.Release],
    ['where is the billing service used', QueryIntent.Explain],
    ['qwerty zxcvbn', QueryIntent.Unknown],
    ['', QueryIntent.Unknown],
  ];
  test.each(intentCases)('intent(%p) → %p', (q, expected) => {
    expect(classifyQueryIntent(q).intent).toBe(expected);
  });

  test('a vetoed create word names the marker that vetoed it', () => {
    expect(classifyQueryIntent('fix the broken build in billing').vetoedBy).toBe('fix');
    expect(classifyQueryIntent('why does the new billing route fail').vetoedBy).toBe('why');
    expect(classifyQueryIntent('add a pricing block').vetoedBy).toBeUndefined();
  });
});

describe('r75 eligibility — a scaffold never headlines non-create work', () => {
  const REPAIR = ['fix the broken build in billing', 'why does the new billing route fail', 'fix the boundary violation in billing'];

  test.each(REPAIR)('%p: no writes-source headline, and the scaffold is suppressed as non-create-intent', async (q) => {
    const r = await recommendCommands(insp, q);
    expect(r.intent.intent).not.toBe(QueryIntent.Create);
    expect(r.recommendations[0]?.safetyLevel).not.toBe('writes-source');
    expect(r.nextCommand).not.toMatch(/^shrk gen/);
    const scaffold = r.ranked.find((c) => c.command === SCAFFOLD);
    expect(scaffold).toBeDefined();
    expect(scaffold!.suppressedReason).toBe(RecommendationSuppression.NonCreateIntent);
  }, TIMEOUT_MS);

  test('"fix the boundary violation in billing" headlines the boundary-repair hint', async () => {
    const r = await recommendCommands(insp, 'fix the boundary violation in billing');
    expect(r.recommendations[0]!.command).toBe('shrk check boundaries --explain');
    expect(r.recommendations[0]!.sourceId).toBe('boundary-repair');
    expect(r.nextCommand).toBe('shrk check boundaries --explain');
  }, TIMEOUT_MS);

  test('"add a pricing block kind" headlines the pricing-block hint; the zero-overlap template is a single incidental term', async () => {
    const r = await recommendCommands(insp, 'add a pricing block kind');
    expect(r.recommendations[0]!.command).toBe('shrk gen pricing.block <name> --dry-run');
    expect(r.recommendations[0]!.source).toBe(RecommendationSource.RoutingHint);
    const scaffold = r.ranked.find((c) => c.command === SCAFFOLD)!;
    expect(scaffold.suppressedReason).toBe(RecommendationSuppression.SingleIncidentalTerm);
    expect(scaffold.matchedTerms).toEqual([]);
  }, TIMEOUT_MS);

  test('HARD RULE over a query matrix: intent ≠ create ⇒ no writes-source headline, no `shrk gen` next command', async () => {
    const matrix = [
      ...REPAIR,
      'refactor the billing module',
      'analyze the billing dependencies',
      'review the billing module',
      'explain the billing feature template',
      'where is the billing feature used',
      'the billing feature is slow',
    ];
    for (const q of matrix) {
      const r = await recommendCommands(insp, q);
      if (r.intent.intent === QueryIntent.Create) continue;
      expect({ q, headline: r.recommendations[0]?.safetyLevel }).not.toEqual({ q, headline: 'writes-source' });
      expect({ q, next: r.nextCommand.startsWith('shrk gen') }).toEqual({ q, next: false });
      expect(r.recommendations.some((x) => x.safetyLevel === 'writes-source')).toBe(false);
    }
  }, TIMEOUT_MS);

  test('scaffoldRequiresCreateIntent: false lifts the intent gate (and only that gate)', async () => {
    const gated = await rankRecommendationCandidates(insp, 'refactor the billing module');
    expect(gated.candidates.find((c) => c.command === SCAFFOLD)?.suppressedReason).toBe(
      RecommendationSuppression.NonCreateIntent,
    );
    const open = await rankRecommendationCandidates(insp, 'refactor the billing module', { scaffoldRequiresCreateIntent: false });
    expect(open.candidates.find((c) => c.command === SCAFFOLD)?.suppressedReason).not.toBe(
      RecommendationSuppression.NonCreateIntent,
    );
  }, TIMEOUT_MS);
});
