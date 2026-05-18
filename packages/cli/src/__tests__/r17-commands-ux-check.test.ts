import { describe, expect, test } from 'bun:test';
import { buildCommandsUxReport } from '../commands/commands.command.ts';

describe('r17 commands ux-check', () => {
  test('produces a structured report', () => {
    const r = buildCommandsUxReport();
    expect(r.schema).toBe('sharkcraft.commands-ux-check/v1');
    expect(r.summary.catalogEntries).toBeGreaterThan(0);
  });
  test('every primary hint resolves to at least one catalog entry', () => {
    const r = buildCommandsUxReport();
    const unreferenced = r.issues.filter((i) => i.code === 'unreferenced-primary');
    expect(unreferenced.length).toBe(0);
  });
});
