/**
 * Tests for `synthesizePopulatedFromImport` — the engine behind
 * `shrk import <format> --populate`. Anchors:
 *
 *   - The full file set (config + knowledge + rules / paths + 2 reports)
 *     is emitted with stable, predictable paths.
 *   - Type-based routing: Rule entries land in rules.ts, Path in
 *     paths.ts, everything else in knowledge.ts. Template entries
 *     drop to the report.
 *   - Confidence tiers: high → no marker; medium → // TODO marker;
 *     low → dropped from populated files and listed in the report.
 *   - Every emitted entry includes a `type:` field (the knowledge
 *     loader rejects entries missing type — this is the bug that
 *     surfaced during the first integration run).
 *   - Generated files are self-contained (no @shrkcrft/* imports).
 *   - Deterministic output across runs.
 */

import { describe, expect, test } from 'bun:test';
import { KnowledgePriority, KnowledgeType } from '@shrkcrft/knowledge';
import type { IImportedEntry } from '../model/imported-entry.ts';
import { synthesizePopulatedFromImport } from '../emit/synthesize-populated.ts';

function entry(over: Partial<IImportedEntry>): IImportedEntry {
  return {
    id: over.id ?? 'imported.test',
    title: over.title ?? 'Test entry',
    type: over.type ?? KnowledgeType.Rule,
    priority: over.priority ?? KnowledgePriority.High,
    section: over.section,
    tags: over.tags ?? [],
    content:
      over.content ??
      'This is a body long enough to clear the meaningful-content threshold for the confidence triage logic to fire.',
    origin: over.origin ?? 'CLAUDE.md',
    importerNotes: over.importerNotes,
  };
}

describe('synthesizePopulatedFromImport — file set', () => {
  test('always emits config + knowledge + the two report files', () => {
    const result = synthesizePopulatedFromImport([], {
      projectName: 'p',
      sourceLabel: 'CLAUDE.md',
    });
    const paths = new Set(result.files.map((f) => f.path));
    expect(paths.has('sharkcraft.config.ts')).toBe(true);
    expect(paths.has('knowledge.ts')).toBe(true);
    expect(paths.has('.imported-report.md')).toBe(true);
    expect(paths.has('.imported-report.json')).toBe(true);
  });

  test('rules.ts only when at least one rule entry is adopted', () => {
    const noRules = synthesizePopulatedFromImport(
      [entry({ id: 'know.one', type: KnowledgeType.Convention })],
      { projectName: 'p', sourceLabel: 's' },
    );
    expect(noRules.files.some((f) => f.path === 'rules.ts')).toBe(false);
    const withRules = synthesizePopulatedFromImport(
      [entry({ id: 'r.one', type: KnowledgeType.Rule })],
      { projectName: 'p', sourceLabel: 's' },
    );
    expect(withRules.files.some((f) => f.path === 'rules.ts')).toBe(true);
  });

  test('paths.ts only when at least one path entry is adopted', () => {
    const result = synthesizePopulatedFromImport(
      [entry({ id: 'p.one', type: KnowledgeType.Path })],
      { projectName: 'p', sourceLabel: 's' },
    );
    expect(result.files.some((f) => f.path === 'paths.ts')).toBe(true);
  });
});

describe('synthesizePopulatedFromImport — type routing', () => {
  test('Rule type lands in rules.ts', () => {
    const result = synthesizePopulatedFromImport(
      [entry({ id: 'r.routes-to-rules', type: KnowledgeType.Rule })],
      { projectName: 'p', sourceLabel: 's' },
    );
    const rulesFile = result.files.find((f) => f.path === 'rules.ts');
    expect(rulesFile).toBeDefined();
    expect(rulesFile!.content).toContain('"r.routes-to-rules"');
  });

  test('Path type lands in paths.ts', () => {
    const result = synthesizePopulatedFromImport(
      [entry({ id: 'p.routes-to-paths', type: KnowledgeType.Path })],
      { projectName: 'p', sourceLabel: 's' },
    );
    const pathsFile = result.files.find((f) => f.path === 'paths.ts');
    expect(pathsFile).toBeDefined();
    expect(pathsFile!.content).toContain('"p.routes-to-paths"');
  });

  test('Convention / Architecture / Warning / Workflow / Decision land in knowledge.ts', () => {
    const types: KnowledgeType[] = [
      KnowledgeType.Convention,
      KnowledgeType.Architecture,
      KnowledgeType.Warning,
      KnowledgeType.Workflow,
      KnowledgeType.Decision,
    ];
    for (const t of types) {
      const result = synthesizePopulatedFromImport(
        [entry({ id: `k.${t}`, type: t })],
        { projectName: 'p', sourceLabel: 's' },
      );
      const k = result.files.find((f) => f.path === 'knowledge.ts');
      expect(k).toBeDefined();
      expect(k!.content).toContain(`"k.${t}"`);
    }
  });

  test('Template entries drop to the report (markdown can\'t recover a runnable body)', () => {
    const result = synthesizePopulatedFromImport(
      [entry({ id: 't.dropped', type: KnowledgeType.Template })],
      { projectName: 'p', sourceLabel: 's' },
    );
    expect(result.files.some((f) => f.path === 'templates.ts')).toBe(false);
    expect(result.report.dropped.some((d) => d.id === 't.dropped')).toBe(true);
  });
});

describe('synthesizePopulatedFromImport — confidence triage', () => {
  test('Critical + non-trivial body → high (no TODO marker)', () => {
    const result = synthesizePopulatedFromImport(
      [
        entry({
          id: 'r.critical',
          type: KnowledgeType.Rule,
          priority: KnowledgePriority.Critical,
        }),
      ],
      { projectName: 'p', sourceLabel: 's' },
    );
    expect(result.report.adoptedHigh.some((c) => c.id === 'r.critical')).toBe(true);
    const rulesFile = result.files.find((f) => f.path === 'rules.ts');
    expect(rulesFile!.content).not.toContain('TODO: review');
  });

  test('Medium priority → adopted with TODO marker', () => {
    const result = synthesizePopulatedFromImport(
      [
        entry({
          id: 'r.medium',
          type: KnowledgeType.Rule,
          priority: KnowledgePriority.Medium,
        }),
      ],
      { projectName: 'p', sourceLabel: 's' },
    );
    expect(result.report.adoptedMedium.some((c) => c.id === 'r.medium')).toBe(true);
    const rulesFile = result.files.find((f) => f.path === 'rules.ts');
    expect(rulesFile!.content).toContain('TODO: review');
  });

  test('thin body (≤40 chars) → dropped regardless of priority', () => {
    const result = synthesizePopulatedFromImport(
      [
        entry({
          id: 'r.thin',
          type: KnowledgeType.Rule,
          priority: KnowledgePriority.Critical,
          content: 'short',
        }),
      ],
      { projectName: 'p', sourceLabel: 's' },
    );
    expect(result.report.dropped.some((d) => d.id === 'r.thin')).toBe(true);
    // Dropped → no rules.ts file emitted (no other rules).
    expect(result.files.some((f) => f.path === 'rules.ts')).toBe(false);
  });

  test('Low priority → dropped from populated files', () => {
    const result = synthesizePopulatedFromImport(
      [
        entry({
          id: 'r.low',
          type: KnowledgeType.Rule,
          priority: KnowledgePriority.Low,
        }),
      ],
      { projectName: 'p', sourceLabel: 's' },
    );
    expect(result.report.dropped.some((d) => d.id === 'r.low')).toBe(true);
  });
});

describe('synthesizePopulatedFromImport — emit invariants', () => {
  test('every emitted entry includes a `type:` field', () => {
    const result = synthesizePopulatedFromImport(
      [
        entry({ id: 'r.one', type: KnowledgeType.Rule }),
        entry({ id: 'p.one', type: KnowledgeType.Path }),
        entry({ id: 'k.one', type: KnowledgeType.Convention }),
      ],
      { projectName: 'p', sourceLabel: 's' },
    );
    // Every defineKnowledgeEntry({...}) block in the emitted TS must
    // include a `type: KnowledgeType.*` line. This is the bug that
    // surfaced when the first --populate run hit the knowledge
    // validator: "Entry X is missing a type".
    for (const file of result.files) {
      if (!file.path.endsWith('.ts')) continue;
      const blocks = file.content.match(/defineKnowledgeEntry\(\{[\s\S]+?\}\)/g) ?? [];
      for (const block of blocks) {
        expect(block).toMatch(/type:\s+KnowledgeType\./);
      }
    }
  });

  test('generated .ts files have no @shrkcrft/* imports (self-contained)', () => {
    const result = synthesizePopulatedFromImport(
      [
        entry({ id: 'r.one', type: KnowledgeType.Rule }),
        entry({ id: 'p.one', type: KnowledgeType.Path }),
      ],
      { projectName: 'p', sourceLabel: 's' },
    );
    for (const file of result.files) {
      if (!file.path.endsWith('.ts')) continue;
      expect(file.content).not.toMatch(/from\s+['"]@shrkcrft\//);
      expect(file.content).not.toMatch(/from\s+['"]@sharkcraft\//);
    }
  });

  test('output is deterministic across runs (same entries → same bytes)', () => {
    const inputs = [
      entry({ id: 'a.one', type: KnowledgeType.Rule }),
      entry({ id: 'a.two', type: KnowledgeType.Path }),
      entry({ id: 'a.three', type: KnowledgeType.Convention }),
    ];
    const r1 = synthesizePopulatedFromImport(inputs, {
      projectName: 'p',
      sourceLabel: 's',
    });
    const r2 = synthesizePopulatedFromImport(inputs, {
      projectName: 'p',
      sourceLabel: 's',
    });
    expect(r1.files.length).toBe(r2.files.length);
    for (let i = 0; i < r1.files.length; i += 1) {
      const a = r1.files[i]!;
      const b = r2.files[i]!;
      expect(a.path).toBe(b.path);
      // .imported-report.json carries no timestamp here (no Date.now)
      // so it should also be deterministic.
      expect(a.content).toBe(b.content);
    }
  });

  test('config file references only populated kinds (no dangling refs)', () => {
    const result = synthesizePopulatedFromImport(
      [
        entry({ id: 'r.one', type: KnowledgeType.Rule }),
        // No path entries → paths.ts should not be referenced.
      ],
      { projectName: 'p', sourceLabel: 's' },
    );
    const cfg = result.files.find((f) => f.path === 'sharkcraft.config.ts');
    expect(cfg).toBeDefined();
    expect(cfg!.content).toContain('ruleFiles: ["rules.ts"]');
    expect(cfg!.content).toContain('pathFiles: []');
  });
});

describe('synthesizePopulatedFromImport — report shape', () => {
  test('report markdown lists adopted high / medium / dropped counts', () => {
    const result = synthesizePopulatedFromImport(
      [
        entry({ id: 'r.h', type: KnowledgeType.Rule, priority: KnowledgePriority.High }),
        entry({ id: 'r.m', type: KnowledgeType.Rule, priority: KnowledgePriority.Medium }),
        entry({ id: 't.drop', type: KnowledgeType.Template }),
      ],
      { projectName: 'p', sourceLabel: 'CLAUDE.md' },
    );
    const md = result.files.find((f) => f.path === '.imported-report.md');
    expect(md).toBeDefined();
    expect(md!.content).toMatch(/✅ Adopted directly \(\d+ entries/);
    expect(md!.content).toMatch(/🟡 Adopted with review marker \(\d+ entries/);
    expect(md!.content).toMatch(/⚠️ Not adopted \(\d+ entries/);
    expect(md!.content).toContain("✍️ What `shrk import` deliberately doesn't try to recover");
    expect(md!.content).toContain('CLAUDE.md');
  });
});
