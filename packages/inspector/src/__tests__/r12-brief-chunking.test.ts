import { describe, expect, test } from 'bun:test';
import * as nodePath from 'node:path';
import { buildAgentBrief, inspectSharkcraft } from '../index.ts';

const DOGFOOD_CWD = nodePath.resolve(__dirname, '../../../../examples/dogfood-target');

describe('r12 brief chunking + budgets', () => {
  test('chunked output produces an index + per-section files', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const brief = await buildAgentBrief(inspection, {
      task: 'generate a user profile service',
      chunked: true,
    });
    expect(brief.chunks).toBeDefined();
    expect(brief.chunks!.length).toBeGreaterThan(2);
    const indexChunk = brief.chunks!.find((c) => c.sectionId === 'index')!;
    expect(indexChunk.file).toBe('00-index.md');
    expect(indexChunk.body).toContain('Read the chunks in order');
    // Each chunk file is named with a numeric prefix.
    for (const c of brief.chunks!) {
      expect(c.file).toMatch(/^\d{2}-/);
    }
  });

  test('section budgets trim long sections', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const brief = await buildAgentBrief(inspection, {
      task: 'generate a user profile service',
      sectionBudgets: { rules: 5 },
    });
    const rules = brief.sections.find((s) => s.id === 'rules')!;
    // 5 tokens ≈ 20 chars + trim marker; allow a generous max.
    expect(rules.body.length).toBeLessThanOrEqual(200);
    expect(rules.body).toContain('section trimmed');
  });

  test('safety note appears in every chunk', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const brief = await buildAgentBrief(inspection, {
      task: 't',
      chunked: true,
    });
    for (const c of brief.chunks!) {
      if (c.sectionId === 'index') continue;
      expect(c.body).toContain('MCP is read-only');
    }
  });
});
