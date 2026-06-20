import { describe, expect, test } from 'bun:test';
import { classifyIntent } from '../intent/classify-intent.ts';

describe('classifyIntent', () => {
  test('maps keywords to the documented intents', () => {
    expect(classifyIntent('cut a release and publish')).toBe('release');
    expect(classifyIntent('migrate the API to v2')).toBe('migration');
    expect(classifyIntent('fix the crash in the parser')).toBe('bug-fix');
    expect(classifyIntent('refactor and simplify the loader')).toBe('refactor');
    expect(classifyIntent('update the readme docs')).toBe('docs');
    expect(classifyIntent('add a new endpoint')).toBe('feature');
  });

  test('resolves conflicts in priority order (release > feature)', () => {
    expect(classifyIntent('add release notes and cut the release')).toBe('release');
  });

  test('no keyword match → unknown', () => {
    expect(classifyIntent('zzz qqq')).toBe('unknown');
  });

  test('non-string input → unknown, not a throw (defensive)', () => {
    expect(classifyIntent(null as unknown as string)).toBe('unknown');
    expect(classifyIntent(undefined as unknown as string)).toBe('unknown');
    expect(classifyIntent(42 as unknown as string)).toBe('unknown');
  });
});
