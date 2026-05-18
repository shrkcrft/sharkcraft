import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AdoptionCategory,
  AdoptionKind,
  buildAdoptionMergePreview,
  buildAdoptionReport,
  renderAdoptionMergePreviewHtml,
  renderAdoptionMergePreviewMarkdown,
  renderAdoptionMergePreviewText,
  renderAdoptionReportHtml,
  renderAdoptionReportJson,
  renderAdoptionReportMarkdown,
  renderAdoptionReportText,
} from '../index.ts';
import type { IAdoptionPlan } from '../onboarding-adoption.ts';

function plan(): IAdoptionPlan {
  const safe = [
    {
      kind: AdoptionKind.Rule,
      id: 'rule.<a>',
      title: 'Rule with <html> chars',
      category: AdoptionCategory.SafeToAdopt,
      reason: 'inferred from "agents-md"',
      draftFile: 'inferred-rules.draft.ts',
      preview: 'preview',
    },
  ];
  return {
    confidence: 'high',
    included: [AdoptionKind.Rule],
    excluded: [],
    items: safe,
    summary: {
      [AdoptionCategory.SafeToAdopt]: 1,
      [AdoptionCategory.ManualReview]: 0,
      [AdoptionCategory.LowConfidence]: 0,
      [AdoptionCategory.Conflict]: 0,
      [AdoptionCategory.AlreadyCovered]: 0,
      [AdoptionCategory.Skipped]: 0,
    },
    byCategory: {
      [AdoptionCategory.SafeToAdopt]: safe,
      [AdoptionCategory.ManualReview]: [],
      [AdoptionCategory.LowConfidence]: [],
      [AdoptionCategory.Conflict]: [],
      [AdoptionCategory.AlreadyCovered]: [],
      [AdoptionCategory.Skipped]: [],
    },
  };
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-adopt-render-'));
  mkdirSync(join(root, 'sharkcraft', 'onboarding', 'adoption'), { recursive: true });
  return root;
}

describe('adoption merge preview', () => {
  test('renders text without an adoption state', () => {
    const p = buildAdoptionMergePreview({ projectRoot: makeRoot(), plan: plan() });
    const out = renderAdoptionMergePreviewText(p);
    expect(out).toContain('No adoption-state.json on disk');
  });

  test('renders markdown with three-way table once a state exists', () => {
    const root = makeRoot();
    writeFileSync(
      join(root, 'sharkcraft/onboarding/adoption/adoption-state.json'),
      JSON.stringify({
        schema: 'sharkcraft.adoption-state/v1',
        projectRoot: root,
        createdAt: 'x',
        updatedAt: 'x',
        sharkcraftVersion: '0.1',
        command: 'shrk onboard adopt --write-patch',
        sourceDraftFiles: [],
        targetFiles: [{ relativePath: 'sharkcraft/rules.ts', hash: '(missing)' }],
        generatedFiles: [],
        patchPath: 'p',
        summaryPath: 's',
        diffFormat: 'unified',
        confidenceThreshold: 'high',
        includedKinds: ['rule'],
        excludedKinds: [],
        categories: { 'safe-to-adopt': ['rule:rule.x'] },
        freshness: { status: 'fresh', staleReasons: [] },
        warnings: [],
        nextCommands: [],
      }),
    );
    const p = buildAdoptionMergePreview({ projectRoot: root, plan: plan() });
    const md = renderAdoptionMergePreviewMarkdown(p);
    expect(md).toContain('Three-way verdicts per target');
    expect(md).toContain('sharkcraft/rules.ts');
  });

  test('html escapes < / > when items are rendered', () => {
    // The merge-preview short-circuits when no adoption state exists, so this
    // assertion targets the report renderer which always renders items.
    const r = buildAdoptionReport({ projectRoot: makeRoot(), plan: plan(), state: null });
    const html = renderAdoptionReportHtml(r);
    expect(html).toContain('<!doctype html>');
    expect(html).not.toContain('Rule with <html>');
    expect(html).toContain('&lt;html&gt;');
  });
});

describe('adoption report renderers', () => {
  test('text/markdown/html/json all return non-empty', () => {
    const r = buildAdoptionReport({ projectRoot: makeRoot(), plan: plan(), state: null });
    expect(renderAdoptionReportText(r)).toContain('Onboarding adoption');
    expect(renderAdoptionReportMarkdown(r)).toContain('# SharkCraft onboarding adoption');
    const html = renderAdoptionReportHtml(r);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('MCP never writes');
    expect(JSON.parse(renderAdoptionReportJson(r)).schema).toBe('sharkcraft.adoption-report/v1');
  });
});
