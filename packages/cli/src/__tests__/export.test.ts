import { describe, expect, test } from 'bun:test';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { renderExport, ALL_EXPORT_FORMATS, isExportFormat } from '../export/export-formats.ts';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const DOGFOOD = join(REPO_ROOT, 'examples/dogfood-target');

describe('export formats', () => {
  test('isExportFormat recognizes valid formats', () => {
    for (const f of ALL_EXPORT_FORMATS) expect(isExportFormat(f)).toBe(true);
    expect(isExportFormat('garbage')).toBe(false);
  });

  test('agents-md export contains rules + paths + agent actions', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD });
    const out = renderExport(inspection, { format: 'agents-md' });
    expect(out.suggestedPath).toBe('AGENTS.md');
    expect(out.content).toContain('# Agents Guide');
    expect(out.content).toContain('## Rules to follow');
    expect(out.content).toContain('## Where files belong');
    expect(out.content).toContain('## Agent actions');
  });

  test('claude-md export is framed as a CLAUDE.md compatibility view', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD });
    const out = renderExport(inspection, { format: 'claude-md' });
    expect(out.suggestedPath).toBe('CLAUDE.md');
    expect(out.content).toContain('# CLAUDE.md');
    expect(out.content).toContain('MCP server');
  });

  test('cursor-rules export has the cursor MDC frontmatter', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD });
    const out = renderExport(inspection, { format: 'cursor-rules' });
    expect(out.suggestedPath).toBe('.cursor/rules/sharkcraft.mdc');
    expect(out.content.startsWith('---')).toBe(true);
    expect(out.content).toContain('alwaysApply: false');
  });

  test('copilot-instructions export targets .github/copilot-instructions.md', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD });
    const out = renderExport(inspection, { format: 'copilot-instructions' });
    expect(out.suggestedPath).toBe('.github/copilot-instructions.md');
    expect(out.content).toContain('# Copilot instructions');
  });
});
