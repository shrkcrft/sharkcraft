import { describe, expect, test } from 'bun:test';
import { definePathConvention } from '../path-convention.ts';
import { matchAffectedConventions } from '../path-convention-match.ts';

function conv(id: string, path: string) {
  return definePathConvention({ id, title: id, path });
}

describe('matchAffectedConventions', () => {
  test('matches by directory prefix, not free-text substring', () => {
    const conventions = [
      conv('components', 'src/components'),
      conv('services', 'src/services'),
      conv('src-root', 'src'),
    ];
    const result = matchAffectedConventions(conventions, ['src/components/Button.tsx']).map(
      (c) => c.id,
    );
    // The specific dir + its legitimate parent match; `services` does NOT (the
    // old substring-on-`src` heuristic would have matched all three).
    expect(result).toEqual(['components', 'src-root']);
  });

  test('a non-covering convention is excluded', () => {
    const conventions = [conv('docs', 'docs'), conv('pkg', 'packages')];
    const result = matchAffectedConventions(conventions, [
      'packages/cli/src/commands/x.command.ts',
    ]).map((c) => c.id);
    expect(result).toEqual(['pkg']);
  });

  test('a convention with no structured metadata.path is excluded', () => {
    const noPath = definePathConvention({ id: 'empty', title: 'empty', path: '' });
    const result = matchAffectedConventions([noPath], ['src/a.ts']);
    expect(result).toEqual([]);
  });

  test('exact file path match counts', () => {
    const conventions = [conv('entry', 'src/index.ts')];
    expect(matchAffectedConventions(conventions, ['src/index.ts']).map((c) => c.id)).toEqual([
      'entry',
    ]);
    // A sibling file under the same dir does NOT match a file-specific convention.
    expect(matchAffectedConventions(conventions, ['src/other.ts'])).toEqual([]);
  });
});
