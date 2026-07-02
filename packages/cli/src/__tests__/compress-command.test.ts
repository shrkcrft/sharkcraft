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
  test('passthrough on non-trivial plain text WARNs and suggests --type', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shrk-compress-'));
    try {
      // >128 bytes of unique prose with no structure the auto-detector recognises.
      const prose =
        'He went to the market today and bought apples and oranges. ' +
        'She stayed home reading a long book about gardening and weather. ' +
        'They later met for dinner and talked about the upcoming trip north.';
      const file = join(dir, 'prose.txt');
      writeFileSync(file, prose, 'utf8');
      const r = capture(() => compressCommand.run(makeArgs([file], {}, dir)) as number);
      expect(r.code).toBe(0);
      expect(r.err).toContain('nothing was compressed');
      expect(r.err).toContain('--type');
      // stdout stays the verbatim blob (passthrough).
      expect(r.out).toBe(prose + '\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--type code emits a fidelity banner + JSON fidelity flag (lossy, not line-accurate)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shrk-compress-code-'));
    try {
      // Enough substantial function bodies that eliding them is a real win.
      const fns = Array.from({ length: 8 }, (_, i) => {
        const body = Array.from({ length: 8 }, (_, j) => `  const v${i}_${j} = ${i} * ${j} + ${j};`).join('\n');
        return `export function fn${i}(): number {\n${body}\n  return v${i}_0 + v${i}_7;\n}`;
      }).join('\n\n');
      const file = join(dir, 'big.ts');
      writeFileSync(file, fns + '\n', 'utf8');

      const text = capture(() => compressCommand.run(makeArgs([file], { type: 'code' }, dir)) as number);
      expect(text.code).toBe(0);
      // Banner must fire on the code outline so it isn't mistaken for a Read.
      expect(text.err).toContain('code outline is LOSSY');
      expect(text.err.toLowerCase()).toContain('not line-accurate');

      const json = capture(
        () => compressCommand.run(makeArgs([file], { type: 'code', json: true }, dir)) as number,
      );
      const parsed = JSON.parse(json.out);
      expect(parsed.strategy).toBe('code');
      expect(parsed.fidelity).toContain('lossy-outline');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('trivial input passthrough does NOT warn', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shrk-compress-'));
    try {
      const file = join(dir, 'tiny.txt');
      writeFileSync(file, 'hi', 'utf8');
      const r = capture(() => compressCommand.run(makeArgs([file], {}, dir)) as number);
      expect(r.err).not.toContain('--type');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  function lossyDoc(): string {
    const lines = ['# Title', ''];
    for (let i = 0; i < 40; i += 1) lines.push(`- bullet point ${i} with filler text to drop`);
    return lines.join('\n');
  }

  test('--lossless refuses a lossy reduction (passthrough, lossy=false)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shrk-compress-'));
    try {
      const file = join(dir, 'doc.md');
      writeFileSync(file, lossyDoc(), 'utf8');
      const r = capture(
        () => compressCommand.run(makeArgs([file], { json: true, lossless: true }, dir)) as number,
      );
      const parsed = JSON.parse(r.out) as Record<string, unknown>;
      expect(parsed.lossy).toBe(false);
      expect(parsed.strategy).toBe('passthrough');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--json emits a passthrough envelope (no duplicated content) on a no-win blob', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shrk-compress-'));
    try {
      const file = join(dir, 'tiny.txt');
      writeFileSync(file, 'tiny', 'utf8');
      const r = capture(() => compressCommand.run(makeArgs([file], { json: true }, dir)) as number);
      const parsed = JSON.parse(r.out) as Record<string, unknown>;
      expect(parsed.passthrough).toBe(true);
      expect(parsed.compressed).toBeUndefined(); // not echoed back
      expect(parsed.inputBytes).toBe(4);
      expect(parsed.tokensAreEstimated).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--json reports tokensAreEstimated + queryApplied on a real win', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shrk-compress-'));
    try {
      const arr = Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, kind: 'rule', title: `T${i}` }));
      const file = join(dir, 'data.json');
      writeFileSync(file, JSON.stringify(arr), 'utf8');
      const r = capture(
        () => compressCommand.run(makeArgs([file], { json: true, query: 'rule' }, dir)) as number,
      );
      const parsed = JSON.parse(r.out) as Record<string, unknown>;
      expect(parsed.tokensAreEstimated).toBe(true);
      expect(parsed.queryApplied).toBe(true);
      expect(typeof parsed.compressed).toBe('string'); // win → content present
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('expand restores the original byte-for-byte (no appended newline)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shrk-compress-'));
    try {
      const text = lossyDoc();
      const file = join(dir, 'doc.md');
      writeFileSync(file, text, 'utf8');
      const c = capture(() => compressCommand.run(makeArgs([file], { json: true }, dir)) as number);
      const key = (JSON.parse(c.out) as Record<string, unknown>).ccrKey as string;
      expect(typeof key).toBe('string');
      const e = capture(() => expandCommand.run(makeArgs([key], {}, dir)) as number);
      expect(e.code).toBe(0);
      expect(e.out).toBe(text); // exact — no trailing '\n' added
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
