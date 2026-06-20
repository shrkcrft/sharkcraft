import { describe, expect, test } from 'bun:test';
import { extractGlobalCompress } from '../command-registry.ts';

describe('extractGlobalCompress', () => {
  test('no compress flag → undefined directive, argv unchanged', () => {
    const r = extractGlobalCompress(['knowledge', 'list', '--json']);
    expect(r.directive).toBeUndefined();
    expect(r.rest).toEqual(['knowledge', 'list', '--json']);
  });

  test('--compress activates and is stripped, leaving the command', () => {
    const r = extractGlobalCompress(['knowledge', 'list', '--compress']);
    expect(r.directive).toBeDefined();
    expect(r.rest).toEqual(['knowledge', 'list']);
  });

  test('--ccr is a synonym for --compress', () => {
    const r = extractGlobalCompress(['--ccr', 'task', 'do a thing']);
    expect(r.directive).toBeDefined();
    expect(r.rest).toEqual(['task', 'do a thing']);
  });

  test('--compress-type <t> and =form set the type', () => {
    expect(extractGlobalCompress(['context', '--compress', '--compress-type', 'log']).directive?.type).toBe('log');
    expect(extractGlobalCompress(['context', '--compress-type=json']).directive?.type).toBe('json');
  });

  test('--compress-query <q> and =form set the query', () => {
    expect(extractGlobalCompress(['search', 'x', '--compress', '--compress-query', 'Button']).directive?.query).toBe('Button');
    expect(extractGlobalCompress(['search', 'x', '--compress-query=Modal']).directive?.query).toBe('Modal');
  });

  test('preserves --cwd and other flags in rest (no recursion: compress flags fully removed)', () => {
    const r = extractGlobalCompress(['--cwd', '/repo', 'knowledge', 'list', '--compress', '--json']);
    expect(r.directive).toBeDefined();
    expect(r.rest).toEqual(['--cwd', '/repo', 'knowledge', 'list', '--json']);
    expect(r.rest).not.toContain('--compress');
    expect(r.rest).not.toContain('--ccr');
  });

  test('honors the `--` separator: compress-flag-shaped tokens after it are literal', () => {
    // A file literally named `--compress` must not activate global compress.
    const a = extractGlobalCompress(['compress', '--', '--compress', 'literal']);
    expect(a.directive).toBeUndefined();
    expect(a.rest).toEqual(['compress', '--', '--compress', 'literal']);

    // A valued flag past `--` must not swallow the following literal positional.
    const b = extractGlobalCompress(['search', 'foo', '--', '--compress-query', 'mypattern', 'last']);
    expect(b.directive).toBeUndefined();
    expect(b.rest).toEqual(['search', 'foo', '--', '--compress-query', 'mypattern', 'last']);

    // A real `--compress` BEFORE `--` still activates; the rest after `--` is verbatim.
    const c = extractGlobalCompress(['knowledge', 'get', '--compress', '--', '--weird-id']);
    expect(c.directive).toBeDefined();
    expect(c.rest).toEqual(['knowledge', 'get', '--', '--weird-id']);
  });
});
