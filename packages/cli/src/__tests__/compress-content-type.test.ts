import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { compressCommand } from '../commands/compress.command.ts';
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

// A long single-function blob: imports + signature survive the outline, the
// many body lines are elided, so forcing `source-code` is a clear net win.
function codeBlob(): string {
  const lines = [
    "import { readFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    '',
    'export function compute(values: number[]): number {',
    '  let total = 0;',
  ];
  for (let i = 0; i < 30; i += 1) {
    lines.push(`  const step${i} = values[${i}] ?? 0;`);
    lines.push(`  total += step${i} * ${i} - 1;`);
  }
  lines.push('  return total;');
  lines.push('}');
  return lines.join('\n');
}

describe('shrk compress --type validation + code alias', () => {
  test('--type bogus exits non-zero and lists the valid types', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shrk-ctype-'));
    try {
      const file = join(dir, 'data.json');
      writeFileSync(file, '[{"a":1},{"a":2}]', 'utf8');
      const r = capture(
        () => compressCommand.run(makeArgs([file], { type: 'bogus' }, dir)) as number,
      );
      expect(r.code).toBe(1);
      expect(r.err).toContain('unknown --type "bogus"');
      // The rejection lists valid tokens so the user can self-correct.
      expect(r.err).toContain('source-code');
      expect(r.err).toContain('code');
      // The bogus value must NOT be silently auto-detected: nothing on stdout.
      expect(r.out).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--type code selects the code strategy (source-code), not markdown', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shrk-ctype-'));
    try {
      const file = join(dir, 'mod.ts');
      writeFileSync(file, codeBlob(), 'utf8');
      const r = capture(
        () => compressCommand.run(makeArgs([file], { json: true, type: 'code' }, dir)) as number,
      );
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.out) as Record<string, unknown>;
      // The alias resolves to the structure-preserving code outline...
      expect(parsed.strategy).toBe('code');
      expect(parsed.contentType).toBe('source-code');
      // ...and it must NOT be the markdown line-omission the phantom used to hit.
      expect(parsed.strategy).not.toBe('markdown');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--type code names the applied strategy honestly on the stderr summary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shrk-ctype-'));
    try {
      const file = join(dir, 'mod.ts');
      writeFileSync(file, codeBlob(), 'utf8');
      const r = capture(
        () => compressCommand.run(makeArgs([file], { type: 'code' }, dir)) as number,
      );
      expect(r.code).toBe(0);
      // Non-JSON path labels the actual strategy applied: `code: ...`.
      expect(r.err).toContain('code:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a valid wire string (source-code) is still accepted directly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shrk-ctype-'));
    try {
      const file = join(dir, 'mod.ts');
      writeFileSync(file, codeBlob(), 'utf8');
      const r = capture(
        () =>
          compressCommand.run(makeArgs([file], { json: true, type: 'source-code' }, dir)) as number,
      );
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.out) as Record<string, unknown>;
      expect(parsed.strategy).toBe('code');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
