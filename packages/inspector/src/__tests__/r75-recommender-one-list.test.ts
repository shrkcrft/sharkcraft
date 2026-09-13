/**
 * r75 — ONE ranked recommendation list (spec 2.1 / 2.1#3 / 2.2).
 *
 * A routing hint could match at score 7 and be discarded before the headline
 * for every non-create intent, while the uncertainty line said "No recipe
 * matched" — three threshold pairs, two promotion paths, and a confidence
 * ladder keyed on which code path fired. Now every source proposes into one
 * list, normalised by its own floor; confidence (`deriveRecommendationConfidence`)
 * and `nextCommand` derive from it. These are PROPERTIES over a query matrix
 * on a real fixture (production loaders), plus the minScore precedence.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MatchConfidenceVerdict } from '@shrkcrft/core';
import { recommendCommands } from '../command-recommender.ts';
import { commandSafetyLevel } from '../command-safety-level.ts';
import { QueryIntent } from '../query-intent-kind.ts';
import {
  countsTowardConfidence,
  deriveRecommendationConfidence,
  rankRecommendationCandidates,
  RECOMMEND_SOURCE_FLOORS,
} from '../recommendation-ranking.ts';
import { RecommendationSource } from '../recommendation-source.ts';
import { inspectSharkcraft, type ISharkcraftInspection } from '../sharkcraft-inspector.ts';
import { explainTaskRouting } from '../task-routing-hint-registry.ts';

const TIMEOUT_MS = 120_000;
const roots: string[] = [];

const MATRIX = [
  'add a pricing block kind',
  'refactor the billing module',
  'analyze the billing dependencies',
  'fix the boundary violation in billing',
];
const EXTRA = ['fix the broken build in billing', 'add a table', 'qwerty zxcvbn', 'review my PR', 'plan the billing module'];

function fixture(config = `{ projectName: 'r75-onelist', templateFiles: ['templates.ts'], pipelineFiles: ['pipelines.ts'] }`): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-onelist-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'r75-onelist', version: '0.0.0', private: true }),
    'src/billing/index.ts': 'export const billing = 1;\n',
    'sharkcraft/sharkcraft.config.ts': `export default ${config};\n`,
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
  { id: 'pricing-block', title: 'Pricing block kind (create)', match: { keywords: ['pricing', 'block'] }, recommends: { commands: ['shrk gen pricing.block <name> --dry-run'] } },
  { id: 'billing-refactor', title: 'Billing refactor playbook', match: { keywords: ['billing', 'refactor'], phrases: ['billing module'] }, recommends: { commands: ['shrk graph importers src/billing/index.ts', 'shrk check orphans'] } },
  { id: 'billing-analyze', title: 'Billing dependency analysis', match: { keywords: ['billing', 'dependencies'], phrases: ['billing dependencies'] }, recommends: { commands: ['shrk graph hubs --scope src/billing'] } },
  { id: 'boundary-repair', title: 'Repair a boundary violation', match: { keywords: ['boundary', 'violation'], phrases: ['boundary violation'] }, recommends: { commands: ['shrk check boundaries --explain', 'shrk graph why <from> <to>'] } },
  { id: 'ci-setup', title: 'CI setup', match: { keywords: ['ci'] }, recommends: { commands: ['shrk ci scaffold --provider github'] } },
  { id: 'gate-hint', title: 'Gates', match: { keywords: ['gate'] }, recommends: { commands: ['shrk gates check'] } },
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
  insp = await inspectSharkcraft({ cwd: fixture() });
}, TIMEOUT_MS);

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe('r75 one list — routing hints reach the headline', () => {
  test('PROPERTY: every matched hint at/above its floor has its first command in the list, attributed, above every weaker fallback/recipe row', async () => {
    const hintFloor = RECOMMEND_SOURCE_FLOORS[RecommendationSource.RoutingHint];
    let checked = 0;
    for (const q of MATRIX) {
      const report = await recommendCommands(insp, q);
      for (const m of await explainTaskRouting(insp, q)) {
        const first = m.hint.recommends.commands?.[0];
        if (!first || m.score < hintFloor * report.floor) continue;
        if (commandSafetyLevel(first) === 'writes-source' && report.intent.intent !== QueryIntent.Create) continue;
        checked += 1;
        const at = report.recommendations.findIndex((r) => r.command === first);
        expect({ q, hint: m.hint.id, found: at >= 0 }).toEqual({ q, hint: m.hint.id, found: true });
        const row = report.recommendations[at]!;
        expect(row.source).toBe(RecommendationSource.RoutingHint);
        expect(row.sourceId).toBe(m.hint.id);
        report.recommendations.forEach((other, i) => {
          const weaker =
            (other.source === RecommendationSource.IntentFallback || other.source === RecommendationSource.Recipe) &&
            (other.score ?? 0) < (row.score ?? 0);
          if (weaker) expect({ q, other: other.command, below: i > at }).toEqual({ q, other: other.command, below: true });
        });
      }
    }
    expect(checked).toBeGreaterThanOrEqual(4); // non-vacuous: all four matrix hints were checked
  }, TIMEOUT_MS);

  test('PROPERTY: a hint at/above the floor never coexists with "no recipe matched" / low confidence', async () => {
    for (const q of MATRIX) {
      const report = await recommendCommands(insp, q);
      const hintStrong = report.ranked.some(
        (c) => c.source === RecommendationSource.RoutingHint && !c.suppressedReason && c.normalisedScore >= report.floor,
      );
      if (!hintStrong) continue;
      expect(report.uncertainty.reasons.some((r) => /No recipe matched/.test(r))).toBe(false);
      const ids = report.uncertainty.missingSignals.map((s) => s.id);
      expect(ids).not.toContain('no-recipe-match');
      expect(ids).not.toContain('no-confident-match');
      expect({ q, confidence: report.uncertainty.confidence === 'low' }).toEqual({ q, confidence: false });
    }
  }, TIMEOUT_MS);

  test('the refactor query headlines the billing-refactor hint, not the intent fallback', async () => {
    const report = await recommendCommands(insp, 'refactor the billing module');
    expect(report.recommendations[0]!.command).toBe('shrk graph importers src/billing/index.ts');
    expect(report.recommendations.some((r) => r.command === 'shrk check boundaries --json')).toBe(false);
    expect(report.uncertainty.reasons[0]).toBe(
      'Routing hint "billing-refactor" matched (score 7, floor 3: keyword billing, keyword refactor, phrase billing module).',
    );
  }, TIMEOUT_MS);
});

describe('r75 one list — confidence is a function of the ranked scores', () => {
  test('PROPERTY: confident ⇔ an eligible counting candidate cleared the floor; high|medium ⇔ confident; one authority', async () => {
    for (const q of [...MATRIX, ...EXTRA]) {
      const report = await recommendCommands(insp, q);
      const derived = report.ranked.some(
        (c) => !c.suppressedReason && countsTowardConfidence(c.source) && c.normalisedScore >= report.floor,
      );
      expect({ q, confident: report.confident }).toEqual({ q, confident: derived });
      const level = report.uncertainty.confidence;
      expect({ q, strongLevel: level === 'high' || level === 'medium' }).toEqual({ q, strongLevel: report.confident });
      // THE authority, recomputed from the report's own list, agrees.
      expect(deriveRecommendationConfidence(report.ranked, report.floor).confident).toBe(report.confident);
    }
  }, TIMEOUT_MS);

  test('PROPERTY (2.1#3): confident ⇒ nextCommand is row 1; never a writes-source guess otherwise', async () => {
    for (const q of [...MATRIX, ...EXTRA]) {
      const report = await recommendCommands(insp, q);
      if (report.confident) {
        expect({ q, next: report.nextCommand }).toEqual({ q, next: report.recommendations[0]!.command });
      } else {
        expect(commandSafetyLevel(report.nextCommand)).not.toBe('writes-source');
      }
    }
  }, TIMEOUT_MS);

  test('"add a table": no confident match, no writes-source row, the fallback carries no second confidence label', async () => {
    const report = await recommendCommands(insp, 'add a table');
    expect(report.confident).toBe(false);
    expect(report.verdict).toBe(MatchConfidenceVerdict.NoConfidentMatch);
    expect(report.recommendations.some((r) => r.safetyLevel === 'writes-source')).toBe(false);
    expect(report.uncertainty.missingSignals.map((s) => s.id)).toEqual(['no-confident-match']);
    const fallback = report.recommendations.find((r) => r.source === RecommendationSource.IntentFallback)!;
    expect(fallback.why).toBe('Intent fallback (feature).');
    expect(fallback.weak).toBe(true);
    expect(report.nextCommand).toBe('shrk start-here');
  }, TIMEOUT_MS);

  test('nothing shares a term → verdict no-match', async () => {
    const report = await recommendCommands(insp, 'qwerty zxcvbn');
    expect(report.confident).toBe(false);
    expect(report.verdict).toBe(MatchConfidenceVerdict.NoMatch);
    expect(report.bestScore).toBe(0);
  }, TIMEOUT_MS);

  test('a planning query pins grounding first, and it is the next command', async () => {
    const report = await recommendCommands(insp, 'analyze the billing dependencies');
    expect(report.recommendations[0]!.command).toBe('shrk grounding "analyze the billing dependencies" --json');
    expect(report.recommendations[0]!.source).toBe(RecommendationSource.Planning);
    expect(report.recommendations[1]!.sourceId).toBe('billing-analyze');
    expect(report.nextCommand).toBe(report.recommendations[0]!.command);
  }, TIMEOUT_MS);
});

describe('r75 one list — the floor (config recommend.minScore < explicit minScore)', () => {
  test('config minScore 2: the refactor query (hint 7/3 = 2.33) stays confident; the analyze query\'s one-keyword rows go weak', async () => {
    const strict = await inspectSharkcraft({
      cwd: fixture(
        `{ projectName: 'r75-onelist', templateFiles: ['templates.ts'], pipelineFiles: ['pipelines.ts'], recommend: { minScore: 2 } }`,
      ),
    });
    expect(strict.configLoadError).toBeUndefined();
    const refactor = await recommendCommands(strict, 'refactor the billing module');
    expect(refactor.floor).toBe(2);
    expect(refactor.confident).toBe(true);
    const analyze = await recommendCommands(strict, 'analyze the billing dependencies');
    const weakRefactorRows = analyze.recommendations.filter((r) => r.sourceId === 'billing-refactor');
    expect(weakRefactorRows.length).toBeGreaterThan(0);
    for (const r of weakRefactorRows) expect(r.weak).toBe(true);
    // The explicit option beats the config.
    const explicit = await rankRecommendationCandidates(strict, 'refactor the billing module', { minScore: 3 });
    expect(explicit.floor).toBe(3);
    expect(explicit.confidence.confident).toBe(false);
  }, TIMEOUT_MS);

  test('default floor is 1', async () => {
    const report = await recommendCommands(insp, 'refactor the billing module');
    expect(report.floor).toBe(1);
  }, TIMEOUT_MS);
});
