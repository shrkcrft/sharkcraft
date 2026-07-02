import { describe, expect, test } from 'bun:test';
import { SHARKCRAFT_VERSION } from '@shrkcrft/shared';
import { changelogCommand } from '../commands/changelog.command.ts';
import { RELEASE_SURFACE_DELTAS } from '../commands/changelog-data.ts';
import type { ParsedArgs } from '../command-registry.ts';

function makeArgs(flags: Record<string, string | boolean> = {}): ParsedArgs {
  return { positional: [], flags: new Map(Object.entries(flags)), multiFlags: new Map() };
}

function capture(fn: () => number): { code: number; out: string } {
  let out = '';
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array): boolean => {
    out += typeof s === 'string' ? s : Buffer.from(s).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    return { code: fn(), out };
  } finally {
    process.stdout.write = orig;
  }
}

describe('shrk changelog', () => {
  test('default JSON reports the running build and a surface delta for it', () => {
    const r = capture(() => changelogCommand.run(makeArgs({ json: true })) as number);
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.out);
    expect(payload.schema).toBe('sharkcraft.changelog/v1');
    expect(payload.runningVersion).toBe(SHARKCRAFT_VERSION);
    expect(payload.versions.length).toBeGreaterThan(0);
  });

  test('--since returns the cumulative delta (only strictly-newer versions)', () => {
    const r = capture(() => changelogCommand.run(makeArgs({ json: true, since: '0.1.0-alpha.23' })) as number);
    const payload = JSON.parse(r.out);
    const versions = payload.versions.map((v: { version: string }) => v.version);
    expect(versions).not.toContain('0.1.0-alpha.23'); // strictly newer
    expect(versions).toContain('0.1.0-alpha.24');
    expect(versions).toContain('0.1.0-alpha.25');
  });

  test('--all lists every recorded version, newest first', () => {
    const r = capture(() => changelogCommand.run(makeArgs({ json: true, all: true })) as number);
    const payload = JSON.parse(r.out);
    expect(payload.count).toBe(RELEASE_SURFACE_DELTAS.length);
    // Newest first: alpha.25 precedes alpha.24.
    const versions = payload.versions.map((v: { version: string }) => v.version);
    expect(versions.indexOf('0.1.0-alpha.25')).toBeLessThan(versions.indexOf('0.1.0-alpha.24'));
  });

  test('text mode renders without crashing and exits 0', () => {
    const r = capture(() => changelogCommand.run(makeArgs()) as number);
    expect(r.code).toBe(0);
    expect(r.out).toContain('shrk changelog');
  });
});
