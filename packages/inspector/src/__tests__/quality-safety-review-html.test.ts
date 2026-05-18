import { describe, expect, test } from 'bun:test';
import { renderQualityHtml } from '../quality-html.ts';
import { renderSafetyHtml } from '../safety-html.ts';
import { renderReviewHtml } from '../review-html.ts';

const fakeQuality = {
  overall: 'warn' as const,
  blockers: 0,
  warnings: 3,
  score: 82,
  gates: [
    { id: 'doctor', label: 'Project doctor', passed: true, blocking: true, runsShell: false, executed: true, notes: [] },
    { id: 'drift', label: 'Drift report', passed: false, blocking: false, runsShell: false, executed: true, notes: ['3 warnings'] },
  ],
  nextRecommendations: ['Run shrk check boundaries'],
};

const fakeSafety = {
  mcp: { anyWritable: false, tools: [{ name: 'get_quality_report', description: 'q', canWrite: false }] },
  commands: {
    writesSource: [],
    writesDrafts: [],
    writesSession: [],
    runsShell: [],
    requiresReview: [],
    readOnly: [{ command: 'doctor', description: 'd', category: 'core', safetyLevel: 'read-only' }],
  },
  verifications: { trusted: [], pack: [], untrusted: [] },
  packs: { discovered: 0, signedAndVerified: 0, signedNotVerified: 0, unsigned: 0, invalid: 0, items: [] },
  planSigning: { secretConfigured: false, secretEnv: 'SHARKCRAFT_PLAN_SECRET' },
  recommendations: ['Set SHARKCRAFT_PLAN_SECRET'],
};

const fakeReview = {
  changedFiles: ['src/a.ts', 'src/b.ts'],
  affectedPaths: ['paths.src'],
  relevantRules: [{ id: 'rule.tests-required', title: 'Tests required', reason: '<scope match>' }],
  relevantTemplates: [],
  relevantPipelines: [],
  boundaryViolations: [],
  missingTestsHeuristic: ['src/a.ts'],
  verificationCommands: ['bun test'],
  reviewerInstructions: '<important>',
};

describe('quality / safety / review HTML', () => {
  test('quality html includes score and gate badges', () => {
    const html = renderQualityHtml(fakeQuality);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('82');
    expect(html).toContain('drift');
  });

  test('safety html shows MCP read-only invariant', () => {
    const html = renderSafetyHtml(fakeSafety);
    expect(html).toContain('MCP read-only invariant');
    expect(html).toContain('b-ok'); // because anyWritable=false
  });

  test('review html escapes <important>', () => {
    const html = renderReviewHtml(fakeReview);
    expect(html).toContain('&lt;important&gt;');
    expect(html).not.toContain('<important>');
  });

  test('review html collapse-long-sections wraps when over threshold', () => {
    const many = { ...fakeReview, changedFiles: Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`) };
    const html = renderReviewHtml(many, { collapseLongSections: true });
    expect(html).toContain('<details>');
  });
});
