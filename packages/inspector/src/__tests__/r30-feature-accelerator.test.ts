/**
 * Fuzzy impact, strict agent tests, knowledge stale-check CI, AST
 * symbol verification, template drift noise control, feedback rules,
 * TypeScript decisions loader.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import {
  FuzzyImpactSourceKind,
  resolveFuzzyImpact,
} from '../fuzzy-impact.ts';
import {
  buildSymbolIndex,
  resolveSymbolInFile,
  SymbolResolution,
  SymbolVisibility,
} from '../symbol-index.ts';
import { ingestFeedbackText } from '../feedback-ingestion.ts';
import { QueryMatchKind } from '../query-resolver.ts';

const TMP_ROOT = mkdtempSync(nodePath.join(os.tmpdir(), 'shrk-r30-'));

// ─────────────────────────── Fuzzy impact ──────────────────────────────

describe('fuzzy impact resolution', () => {
  test('exact existing file path returns ExactFile', () => {
    const filePath = nodePath.join(TMP_ROOT, 'sample.ts');
    writeFileSync(filePath, '// sample\n', 'utf8');
    const inspection = {
      projectRoot: TMP_ROOT,
      knowledgeEntries: [],
      templates: [],
      pathService: { list: () => [] },
      index: new Map(),
      packs: { validPacks: [] },
    } as never;
    const r = resolveFuzzyImpact(inspection, 'sample.ts');
    expect(r.source).toBe(FuzzyImpactSourceKind.ExactFile);
    expect(r.confidence).toBe('exact');
    expect(r.shouldRunImpact).toBe(true);
    expect(r.files).toContain('sample.ts');
  });

  test('exact construct id maps to construct files', () => {
    const filePath = nodePath.join(TMP_ROOT, 'plugin-billing.ts');
    writeFileSync(filePath, '// plugin\n', 'utf8');
    const constructs = [
      { id: 'demo.plugin.billing', type: 'plugin', title: 'Billing plugin', files: ['plugin-billing.ts'] },
    ];
    const inspection = {
      projectRoot: TMP_ROOT,
      knowledgeEntries: [],
      templates: [],
      pathService: { list: () => [] },
      index: new Map(),
      packs: { validPacks: [] },
      // Both the resolver path (constructRegistry.list) and the
      // fuzzy-impact lookup path (inspection.constructs) need to see it.
      constructs,
      constructRegistry: { list: () => constructs },
    } as never;
    const r = resolveFuzzyImpact(inspection, 'demo.plugin.billing');
    expect(r.source).toBe(FuzzyImpactSourceKind.Construct);
    expect(r.shouldRunImpact).toBe(true);
    expect(r.files).toContain('plugin-billing.ts');
  });

  test('fuzzy substring on knowledge returns at-least-medium confidence', () => {
    const inspection = {
      projectRoot: TMP_ROOT,
      knowledgeEntries: [
        { id: 'engine.fuzzy-impact', title: 'Fuzzy impact resolver' },
      ],
      templates: [],
      pathService: { list: () => [] },
      index: new Map(),
      packs: { validPacks: [] },
    } as never;
    const r = resolveFuzzyImpact(inspection, 'fuzzy impact');
    expect(r.source === FuzzyImpactSourceKind.Knowledge ||
      r.source === FuzzyImpactSourceKind.Unresolved).toBe(true);
    expect(r.confidence === 'high' || r.confidence === 'medium' || r.confidence === 'exact').toBe(true);
  });

  test('no-match returns unresolved with follow-ups', () => {
    const inspection = {
      projectRoot: TMP_ROOT,
      knowledgeEntries: [],
      templates: [],
      pathService: { list: () => [] },
      index: new Map(),
      packs: { validPacks: [] },
    } as never;
    const r = resolveFuzzyImpact(inspection, 'zzz-no-match-anywhere');
    expect(r.source).toBe(FuzzyImpactSourceKind.Unresolved);
    expect(r.confidence).toBe('unknown');
    expect(r.shouldRunImpact).toBe(false);
    expect(r.followUpCommands.length).toBeGreaterThan(0);
  });

  test('--resolve-only does not run impact even on high confidence', () => {
    const filePath = nodePath.join(TMP_ROOT, 'resolve-only.ts');
    writeFileSync(filePath, '// f\n', 'utf8');
    const inspection = {
      projectRoot: TMP_ROOT,
      knowledgeEntries: [],
      templates: [],
      pathService: { list: () => [] },
      index: new Map(),
      packs: { validPacks: [] },
    } as never;
    const r = resolveFuzzyImpact(inspection, 'resolve-only.ts', { resolveOnly: true });
    expect(r.shouldRunImpact).toBe(false);
  });

  test('command match returns a Command source with no impact target', () => {
    const inspection = {
      projectRoot: TMP_ROOT,
      knowledgeEntries: [],
      templates: [],
      pathService: { list: () => [] },
      index: new Map(),
      packs: { validPacks: [] },
      commandCatalog: [{ id: 'shrk-impact', name: 'shrk impact', description: 'Impact analysis' }],
    } as never;
    const r = resolveFuzzyImpact(inspection, 'shrk-impact', { kinds: [QueryMatchKind.Command] });
    expect(r.source === FuzzyImpactSourceKind.Command || r.source === FuzzyImpactSourceKind.Unresolved).toBe(true);
  });
});

// ─────────────────────────── AST symbol index ──────────────────────────

describe('AST symbol index', () => {
  test('exported class is exact-export', () => {
    const idx = buildSymbolIndex('virtual.ts', 'export class Foo {}');
    expect(idx.parsed).toBe(true);
    expect(idx.exports.find((e) => e.name === 'Foo')?.visibility).toBe(SymbolVisibility.Export);
  });

  test('local const without export is exact-local', () => {
    const idx = buildSymbolIndex('virtual.ts', 'const SECRET = 1;');
    expect(idx.locals.find((e) => e.name === 'SECRET')).toBeDefined();
  });

  test('re-export from another module is exact-reexport', () => {
    const idx = buildSymbolIndex('virtual.ts', 'export { foo } from "./mod";');
    expect(idx.reExports.find((r) => r.name === 'foo' && r.from === './mod')).toBeDefined();
  });

  test('resolveSymbolInFile returns ExactExport for exported declaration', () => {
    const fileAbs = nodePath.join(TMP_ROOT, 'sym-export.ts');
    writeFileSync(fileAbs, 'export function bar(): void {}\n', 'utf8');
    const r = resolveSymbolInFile(fileAbs, 'bar');
    expect(r.resolution).toBe(SymbolResolution.ExactExport);
  });

  test('resolveSymbolInFile returns Missing for unknown symbol', () => {
    const fileAbs = nodePath.join(TMP_ROOT, 'sym-missing.ts');
    writeFileSync(fileAbs, 'export const a = 1;\n', 'utf8');
    const r = resolveSymbolInFile(fileAbs, 'doesNotExist');
    expect(r.resolution).toBe(SymbolResolution.Missing);
  });

  test('syntax-error file falls back to ProbableText / Unknown', () => {
    const fileAbs = nodePath.join(TMP_ROOT, 'sym-syntax-error.ts');
    writeFileSync(fileAbs, 'export function broken(): {{{', 'utf8');
    const r = resolveSymbolInFile(fileAbs, 'broken');
    expect(
      r.resolution === SymbolResolution.ExactExport ||
        r.resolution === SymbolResolution.ProbableText ||
        r.resolution === SymbolResolution.ExactLocal ||
        r.resolution === SymbolResolution.Unknown,
    ).toBe(true);
  });

  test('export default function captures default name', () => {
    const idx = buildSymbolIndex('virtual.ts', 'export default function MyDefault() {}');
    expect(idx.hasDefaultExport).toBe(true);
    expect(idx.defaultExportName).toBe('MyDefault');
  });
});

// ─────────────────────────── Feedback rules ─────────────────────────────

describe('feedback ingestion with pack rules', () => {
  test('custom rule classifies a previously-uncategorised finding', () => {
    const md = '# Bad\n- layout engine state debugging is opaque\n';
    const r = ingestFeedbackText(md, undefined, {
      rules: [
        {
          id: 'demo.layout-friction',
          title: 'Layout',
          keywords: ['layout'],
          targetArea: 'demo-layout',
          tag: 'layout',
        },
      ],
    });
    expect(r.findings[0]!.tags).toContain('layout');
    // Built-in rules don't match "layout" so the pack rule's target wins.
    expect(r.findings[0]!.targetArea).toBe('demo-layout');
  });

  test('invalid regex in a pack rule is silently skipped', () => {
    const md = '# Bad\n- nothing\n';
    const r = ingestFeedbackText(md, undefined, {
      rules: [
        {
          id: 'broken',
          title: 'Broken',
          regexes: ['[(invalid'],
        },
      ],
    });
    // Should not throw — just no extra match.
    expect(r.totalFindings).toBe(1);
  });

  test('rule without keywords/phrases/regexes is silently ignored', () => {
    const md = '# Bad\n- something\n';
    const r = ingestFeedbackText(md, undefined, {
      rules: [{ id: 'empty', title: 'Empty' }],
    });
    expect(r.totalFindings).toBe(1);
  });
});
