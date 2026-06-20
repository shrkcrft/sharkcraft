import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractGlobalCwd,
  parseArgs,
  resolveCwd,
} from '../command-registry.ts';

describe('extractGlobalCwd', () => {
  test('extracts --cwd <value> from anywhere in argv', () => {
    const { cwd, rest } = extractGlobalCwd(['--cwd', '/foo', 'doctor', '--json']);
    expect(cwd).toBe('/foo');
    expect(rest).toEqual(['doctor', '--json']);
  });

  test('extracts --cwd=<value>', () => {
    const { cwd, rest } = extractGlobalCwd(['inspect', '--cwd=/bar']);
    expect(cwd).toBe('/bar');
    expect(rest).toEqual(['inspect']);
  });

  test('resolves relative cwd against process.cwd()', () => {
    const { cwd } = extractGlobalCwd(['--cwd', '.', 'doctor']);
    expect(cwd).toBe(process.cwd());
  });

  test('leaves argv untouched when no --cwd is present', () => {
    const { cwd, rest } = extractGlobalCwd(['inspect', '--json']);
    expect(cwd).toBeUndefined();
    expect(rest).toEqual(['inspect', '--json']);
  });

  test('honors the `--` separator: a --cwd after it is a literal, not extracted', () => {
    // `--cwd` BEFORE `--` is still extracted; everything from `--` on is verbatim.
    const a = extractGlobalCwd(['--cwd', '/foo', 'gen', '--', '--cwd', '/bar']);
    expect(a.cwd).toBe('/foo');
    expect(a.rest).toEqual(['gen', '--', '--cwd', '/bar']);

    // A `--cwd` only after `--` is NOT extracted (it's a literal positional).
    const b = extractGlobalCwd(['gen', 'name', '--', '--cwd', '/etc']);
    expect(b.cwd).toBeUndefined();
    expect(b.rest).toEqual(['gen', 'name', '--', '--cwd', '/etc']);
  });
});

describe('resolveCwd', () => {
  test('prefers command-level --cwd over globalCwd', () => {
    const args = parseArgs(['--cwd', '/cmd-level'], { globalCwd: '/global' });
    expect(resolveCwd(args)).toBe('/cmd-level');
  });

  test('falls back to globalCwd when no command --cwd', () => {
    const args = parseArgs(['inspect'], { globalCwd: '/global' });
    expect(resolveCwd(args)).toBe('/global');
  });

  test('falls back to process.cwd() when neither is set', () => {
    const args = parseArgs(['inspect']);
    expect(resolveCwd(args)).toBe(process.cwd());
  });
});

describe('--cwd isolates target from running process cwd', () => {
  test('extractGlobalCwd + resolveCwd produce a target distinct from process.cwd()', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'shrk-cwd-isolation-'));
    mkdirSync(join(tmp, 'sharkcraft'), { recursive: true });
    const { cwd: globalCwd, rest } = extractGlobalCwd(['--cwd', tmp, 'doctor']);
    const args = parseArgs(rest, { globalCwd });
    const resolved = resolveCwd(args);
    expect(resolved).toBe(tmp);
    expect(resolved).not.toBe(process.cwd());
  });
});
