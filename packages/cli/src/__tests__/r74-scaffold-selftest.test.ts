/**
 * Round 74 — scaffolding a rule's `selfTest`.
 *
 * The trust layer asks every rule to carry a selfTest so a stale glob fails
 * loud. In practice it is the step that gets skipped, because authoring the
 * fixture inline is a blank page at the moment the author just wants the rule
 * to work — and a rule with no selfTest is invisible to the stale-glob
 * detector. The scaffolder has to produce a fixture that is actually good:
 * a floor with headroom, and anchor ids that were not always going to churn.
 */
import { describe, expect, test } from 'bun:test';
import type { IGateCoverage } from '../gates/rule-coverage.ts';
import { insertSelfTest, scaffoldSelfTest } from '../gates/scaffold-selftest.ts';

function coverage(ids: string[]): IGateCoverage {
  return {
    id: 'handlers',
    plane: 'registry',
    status: 'ok',
    filesMatched: ids.length,
    unitsMatched: ids.length,
    unitLabel: 'ids',
    sampleIds: ids.slice(0, 5),
    allIds: ids,
    failOnEmpty: false,
    expectationFailures: [],
  };
}

describe('scaffoldSelfTest', () => {
  test('the floor sits BELOW the current count so a normal addition is not a failure', () => {
    const s = scaffoldSelfTest(coverage(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']), 20);
    expect(s.currentCount).toBe(10);
    expect(s.expectMatchesAtLeast).toBe(8);
    expect(s.expectMatchesAtLeast).toBeLessThan(s.currentCount);
  });

  test('the floor never drops to zero — that would assert nothing', () => {
    expect(scaffoldSelfTest(coverage(['ONLY']), 90).expectMatchesAtLeast).toBe(1);
  });

  test('anchors avoid obviously temporary and generated names', () => {
    const s = scaffoldSelfTest(
      coverage(['tmpScratch', 'AlphaHandler', 'route3', 'BetaHandler', 'a1b2c3d4e5', 'GammaHandler']),
      20,
    );
    expect(s.expectIds).toEqual(['AlphaHandler', 'BetaHandler', 'GammaHandler']);
  });

  test('selection is deterministic — the same tree scaffolds the same fixture', () => {
    const ids = ['Delta', 'Alpha', 'Charlie', 'Bravo'];
    expect(scaffoldSelfTest(coverage(ids), 20).expectIds).toEqual(
      scaffoldSelfTest(coverage([...ids].reverse()), 20).expectIds,
    );
  });

  test('the snippet is a pasteable block naming all three fields', () => {
    const s = scaffoldSelfTest(coverage(['Alpha', 'Bravo']), 20);
    expect(s.snippet).toContain('selfTest: {');
    expect(s.snippet).toContain('expectMatchesAtLeast:');
    expect(s.snippet).toContain('expectIds:');
    expect(s.snippet).toContain('expectNotIds: []');
  });
});

describe('insertSelfTest — refuses rather than guesses', () => {
  const snippet = "selfTest: {\n  expectMatchesAtLeast: 2,\n},";

  test('inserts under the matching id line, at its indentation', () => {
    const config = ["export default {", "  wiringRules: [", "    {", "      id: 'alpha',", "    },", "  ],", "};"].join('\n');
    const res = insertSelfTest(config, 'alpha', snippet);
    expect(res.ok).toBe(true);
    expect(res.text).toContain("      id: 'alpha',\n      selfTest: {");
  });

  test('a registry rule is keyed by `name` and is found the same way', () => {
    const config = ["export default {", "  registries: [", "    {", "      name: 'handlers',", "    },", "  ],", "};"].join('\n');
    expect(insertSelfTest(config, 'handlers', snippet).ok).toBe(true);
  });

  test('a duplicated id is refused — a write into the wrong rule silently re-points an assertion', () => {
    const config = ["    id: 'dup',", "    id: 'dup',"].join('\n');
    const res = insertSelfTest(config, 'dup', snippet);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('refusing to guess');
  });

  test('an id that is not in the local config is refused, not appended somewhere', () => {
    const res = insertSelfTest("export default {};", 'ghost', snippet);
    expect(res.ok).toBe(false);
    expect(res.text).toBeUndefined();
  });
});
