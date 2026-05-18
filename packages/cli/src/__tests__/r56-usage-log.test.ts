/**
 * usage log foundation: writes one JSONL entry per command,
 * strips flag values, supports opt-out via env, rotates at 10MB.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import {
  extractCommandPath,
  recordUsage,
  sanitizeFlagNames,
  USAGE_LOG_DIR,
  USAGE_LOG_FILE,
  USAGE_LOG_ROTATE_BYTES,
} from '../usage/usage-log.ts';

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(nodePath.join(os.tmpdir(), 'shrk-r56-usage-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('usage log foundation', () => {
  test('sanitizeFlagNames keeps names, strips values', () => {
    expect(sanitizeFlagNames(['doctor', '--json'])).toEqual(['--json']);
    expect(sanitizeFlagNames(['task', '<task>', '--top', '5'])).toEqual(['--top']);
    expect(sanitizeFlagNames(['--cwd=foo', '--debug'])).toEqual(['--cwd', '--debug']);
    expect(sanitizeFlagNames(['-h'])).toEqual(['-h']);
  });

  test('extractCommandPath returns first 1-2 positional tokens', () => {
    expect(extractCommandPath(['doctor'])).toBe('doctor');
    expect(extractCommandPath(['plan', 'review', '/tmp/p.json'])).toBe('plan review');
    expect(extractCommandPath(['--help'])).toBe('');
  });

  test('recordUsage writes one JSONL entry', () => {
    withTmp((cwd) => {
      recordUsage({
        cwd,
        command: 'doctor',
        exitCode: 0,
        durationMs: 100,
        flags: ['--json'],
        enabled: true,
      });
      const file = nodePath.join(cwd, USAGE_LOG_DIR, USAGE_LOG_FILE);
      expect(existsSync(file)).toBe(true);
      const lines = readFileSync(file, 'utf8').trim().split('\n');
      expect(lines.length).toBe(1);
      const entry = JSON.parse(lines[0]!);
      expect(entry.command).toBe('doctor');
      expect(entry.exitCode).toBe(0);
      expect(entry.flags).toEqual(['--json']);
      expect(entry.schemaVersion).toBe('sharkcraft.usage.v1');
    });
  });

  test('recordUsage no-op when enabled=false', () => {
    withTmp((cwd) => {
      recordUsage({
        cwd,
        command: 'doctor',
        exitCode: 0,
        durationMs: 100,
        flags: [],
        enabled: false,
      });
      const file = nodePath.join(cwd, USAGE_LOG_DIR, USAGE_LOG_FILE);
      expect(existsSync(file)).toBe(false);
    });
  });

  test('recordUsage no-op when SHARKCRAFT_USAGE_DISABLED=1', () => {
    withTmp((cwd) => {
      const before = process.env.SHARKCRAFT_USAGE_DISABLED;
      process.env.SHARKCRAFT_USAGE_DISABLED = '1';
      try {
        recordUsage({
          cwd,
          command: 'doctor',
          exitCode: 0,
          durationMs: 100,
          flags: [],
          enabled: true,
        });
        const file = nodePath.join(cwd, USAGE_LOG_DIR, USAGE_LOG_FILE);
        expect(existsSync(file)).toBe(false);
      } finally {
        if (before === undefined) delete process.env.SHARKCRAFT_USAGE_DISABLED;
        else process.env.SHARKCRAFT_USAGE_DISABLED = before;
      }
    });
  });

  test('rotates file at 10MB', () => {
    withTmp((cwd) => {
      const dir = nodePath.join(cwd, USAGE_LOG_DIR);
      const file = nodePath.join(dir, USAGE_LOG_FILE);
      // Seed with a >10MB file.
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, 'x'.repeat(USAGE_LOG_ROTATE_BYTES + 100));
      recordUsage({
        cwd,
        command: 'doctor',
        exitCode: 0,
        durationMs: 100,
        flags: [],
        enabled: true,
      });
      const rotated = `${file}.1`;
      expect(existsSync(rotated)).toBe(true);
      // The new file has just the one fresh entry.
      const fresh = readFileSync(file, 'utf8').trim().split('\n');
      expect(fresh.length).toBe(1);
      // The rotated file kept the seed.
      expect(statSync(rotated).size).toBeGreaterThan(USAGE_LOG_ROTATE_BYTES);
    });
  });

  test('does not crash when write fails (read-only dir)', () => {
    // Test the silent-failure contract: recordUsage with a bad cwd
    // must not throw.
    expect(() =>
      recordUsage({
        cwd: '/dev/null/not/a/dir',
        command: 'doctor',
        exitCode: 0,
        durationMs: 100,
        flags: [],
        enabled: true,
      }),
    ).not.toThrow();
  });
});
