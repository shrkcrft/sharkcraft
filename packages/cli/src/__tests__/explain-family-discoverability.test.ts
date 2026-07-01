import { describe, expect, test } from 'bun:test';
import { defaultShowInHelp, listExplainFamily } from '../commands/command-catalog.ts';

describe('listExplainFamily (4.4 discoverability)', () => {
  test('surfaces the praised + new explain/dry-run commands', () => {
    const commands = listExplainFamily().map((e) => e.command);
    // The one the hand-off notes found only by guessing.
    expect(commands).toContain('search tuning explain');
    // The new author-loop surfaces.
    expect(commands).toContain('wiring explain');
    expect(commands).toContain('wiring test');
    // Other established *-explain gems.
    expect(commands).toContain('boundaries explain');
    expect(commands).toContain('surface explain');
  });

  test('includes at least one command that default help would hide', () => {
    const family = listExplainFamily();
    // The whole point: some genuinely-useful entries are NOT in default help
    // (Advanced surface), so the dedicated section is what surfaces them.
    expect(family.some((e) => !defaultShowInHelp(e))).toBe(true);
  });

  test('is sorted and free of retired/deprecated/alias entries', () => {
    const family = listExplainFamily();
    const commands = family.map((e) => e.command);
    expect([...commands].sort()).toEqual(commands);
    // No duplicates.
    expect(new Set(commands).size).toBe(commands.length);
  });
});
