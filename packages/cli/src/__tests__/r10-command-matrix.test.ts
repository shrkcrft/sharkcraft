import { describe, expect, it } from 'bun:test';
import {
  buildCommandSafetyMatrix,
  renderCommandSafetyMatrixMarkdown,
} from '../commands/command-catalog.ts';

describe('command safety matrix', () => {
  it('derives a non-empty matrix from the catalog', () => {
    const rows = buildCommandSafetyMatrix();
    expect(rows.length).toBeGreaterThan(20);
    // Every row must be one of the documented categories (i.e. not blank).
    for (const r of rows) {
      expect(typeof r.category).toBe('string');
      expect(r.category.length).toBeGreaterThan(0);
    }
  });

  it('marks at least one row as CI-safe and MCP-safe', () => {
    const rows = buildCommandSafetyMatrix();
    expect(rows.some((r) => r.safeForCi)).toBe(true);
    expect(rows.some((r) => r.safeForMcp)).toBe(true);
  });

  it('renders a Markdown table with a header row', () => {
    const md = renderCommandSafetyMatrixMarkdown(buildCommandSafetyMatrix());
    expect(md).toContain('| Command | Category |');
    expect(md.startsWith('# SharkCraft command safety matrix')).toBe(true);
  });
});
