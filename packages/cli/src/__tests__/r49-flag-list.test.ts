/**
 * Canonical `flagList()` parser.
 *
 * Locks in the contract for the multi-value flag helper that replaced the
 * older `flagStringList` (comma-only) and the one-off `multiValues()` in
 * `knowledge-author.command.ts`. Every list-flag caller should now produce
 * the same result regardless of whether the user wrote `--x a --x b`,
 * `--x a,b`, `--x "a, b, c"`, `--x=a --x=b`, or any mix.
 */
import { describe, expect, test } from 'bun:test';
import { flagList, parseArgs } from '../command-registry.ts';

describe('flagList()', () => {
  test('returns [] when the flag is absent', () => {
    const args = parseArgs([]);
    expect(flagList(args, 'tag')).toEqual([]);
  });

  test('comma form: --tag a,b → [a, b]', () => {
    const args = parseArgs(['--tag', 'a,b']);
    expect(flagList(args, 'tag')).toEqual(['a', 'b']);
  });

  test('repeated form: --tag a --tag b → [a, b]', () => {
    const args = parseArgs(['--tag', 'a', '--tag', 'b']);
    expect(flagList(args, 'tag')).toEqual(['a', 'b']);
  });

  test('mixed form: --tag a,b --tag c → [a, b, c]', () => {
    const args = parseArgs(['--tag', 'a,b', '--tag', 'c']);
    expect(flagList(args, 'tag')).toEqual(['a', 'b', 'c']);
  });

  test('quoted comma list (shell-stripped) is split + trimmed', () => {
    // The shell strips the quotes before argv reaches us; what we see is
    // a single string with spaces. We split on comma and trim.
    const args = parseArgs(['--tag', 'a, b, c']);
    expect(flagList(args, 'tag')).toEqual(['a', 'b', 'c']);
  });

  test('= form: --tag=a --tag=b → [a, b]', () => {
    const args = parseArgs(['--tag=a', '--tag=b']);
    expect(flagList(args, 'tag')).toEqual(['a', 'b']);
  });

  test('empty values are dropped: --tag a,,b → [a, b]', () => {
    const args = parseArgs(['--tag', 'a,,b']);
    expect(flagList(args, 'tag')).toEqual(['a', 'b']);
  });

  test('dedupe option removes repeats while preserving order', () => {
    const args = parseArgs(['--tag', 'a,b,a', '--tag', 'c', '--tag', 'b']);
    expect(flagList(args, 'tag', { dedupe: true })).toEqual(['a', 'b', 'c']);
  });

  test('allow option filters out values outside the allowlist', () => {
    const args = parseArgs(['--scope', 'frontend,backend,unknown']);
    expect(
      flagList(args, 'scope', { allow: ['frontend', 'backend'] }),
    ).toEqual(['frontend', 'backend']);
  });

  test("split: 'never' keeps each occurrence verbatim (commas survive)", () => {
    const args = parseArgs(['--reference', 'kind:value,with,comma']);
    expect(flagList(args, 'reference', { split: 'never' })).toEqual([
      'kind:value,with,comma',
    ]);
  });

  test("split: 'auto' comma-splits when passed once", () => {
    const args = parseArgs(['--scope', 'frontend,backend']);
    expect(flagList(args, 'scope', { split: 'auto' })).toEqual([
      'frontend',
      'backend',
    ]);
  });

  test("split: 'auto' keeps occurrences verbatim when passed multiple times", () => {
    const args = parseArgs([
      '--reference',
      'kind:foo,bar',
      '--reference',
      'kind:baz',
    ]);
    expect(flagList(args, 'reference', { split: 'auto' })).toEqual([
      'kind:foo,bar',
      'kind:baz',
    ]);
  });

  test('no regression: last-wins on `flags` map does not lose earlier values', () => {
    // Regression guard: handlers reading args.flags.get('x') see only the
    // last --x invocation. flagList sources multiFlags to preserve every
    // occurrence.
    const args = parseArgs(['--x', 'a', '--x', 'b', '--x', 'c']);
    expect(flagList(args, 'x')).toEqual(['a', 'b', 'c']);
    // The single-value map still reflects last-wins, by design.
    expect(args.flags.get('x')).toBe('c');
  });

  test('boolean flag (no value) yields []', () => {
    const args = parseArgs(['--verbose']);
    expect(flagList(args, 'verbose')).toEqual([]);
  });
});

describe('parseArgs booleanFlags', () => {
  test('without the registry: a flag greedily swallows the next token (legacy)', () => {
    const args = parseArgs(['--json', '/tmp/x.json']);
    expect(args.positional).toEqual([]);
    expect(args.flags.get('json')).toBe('/tmp/x.json');
  });

  test('a known boolean flag never consumes the following token (flag-first ordering)', () => {
    const args = parseArgs(['--json', '/tmp/x.json'], {
      booleanFlags: new Set(['json', 'no-enhance']),
    });
    expect(args.positional).toEqual(['/tmp/x.json']);
    expect(args.flags.get('json')).toBe(true);
  });

  test('the positional task survives `--no-enhance "<task>"`', () => {
    const args = parseArgs(['--no-enhance', 'fix auth flow'], {
      booleanFlags: new Set(['no-enhance']),
    });
    expect(args.flags.get('no-enhance')).toBe(true);
    expect(args.positional).toEqual(['fix auth flow']);
  });

  test('valued flags still consume their value when a boolean set is present', () => {
    const args = parseArgs(['--provider', 'ollama', '--json'], {
      booleanFlags: new Set(['json']),
    });
    expect(args.flags.get('provider')).toBe('ollama');
    expect(args.flags.get('json')).toBe(true);
  });
});
