import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { compressCommand, expandCommand } from '../commands/compress.command.ts';
import type { ParsedArgs } from '../command-registry.ts';

function makeArgs(
  positional: string[],
  flags: Record<string, string | boolean>,
  cwd: string,
): ParsedArgs {
  return {
    positional,
    flags: new Map(Object.entries(flags)),
    multiFlags: new Map(),
    globalCwd: cwd,
  };
}

function capture(fn: () => number): { code: number; out: string; err: string } {
  let out = '';
  let err = '';
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stdout.write = ((s: any) => ((out += String(s)), true)) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stderr.write = ((s: any) => ((err += String(s)), true)) as any;
  try {
    return { code: fn(), out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

describe('shrk compress / expand', () => {
  test('compresses a JSON array into a lossless table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shrk-compress-'));
    try {
      const arr = Array.from({ length: 20 }, (_, i) => ({
        id: `n${i}`,
        kind: 'rule',
        title: `Title ${i}`,
      }));
      const file = join(dir, 'data.json');
      writeFileSync(file, JSON.stringify(arr), 'utf8');
      const r = capture(() => compressCommand.run(makeArgs([file], { json: true }, dir)) as number);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.out) as Record<string, unknown>;
      expect(parsed.strategy).toBe('table');
      expect(parsed.tokensSaved as number).toBeGreaterThan(0);
      expect(parsed.lossy).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('compresses a log (lossy) and `expand` returns the cached original', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shrk-compress-'));
    try {
      const lines: string[] = [];
      for (let i = 0; i < 40; i += 1) lines.push(`INFO step ${i} routine work`);
      lines.push('ERROR fatal boom');
      const text = lines.join('\n');
      const file = join(dir, 'log.txt');
      writeFileSync(file, text, 'utf8');

      const r = capture(() => compressCommand.run(makeArgs([file], { json: true }, dir)) as number);
      const parsed = JSON.parse(r.out) as Record<string, unknown>;
      expect(typeof parsed.ccrKey).toBe('string');

      const e = capture(
        () => expandCommand.run(makeArgs([parsed.ccrKey as string], { json: true }, dir)) as number,
      );
      expect(e.code).toBe(0);
      expect((JSON.parse(e.out) as Record<string, unknown>).content).toBe(text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('expand reports a clean miss for an unknown key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shrk-compress-'));
    try {
      const r = capture(() => expandCommand.run(makeArgs(['deadbeefdeadbeef'], {}, dir)) as number);
      expect(r.code).toBe(1);
      expect(r.err).toContain('no cached original');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
