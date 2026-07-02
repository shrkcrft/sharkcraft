/**
 * §1.1 / §3.1 — the diff-scoped wiring gate must never render a green verdict
 * over zero evaluated rules, and must report the honest `M of N (K skipped)`
 * accounting so a subset run can't read as a full green.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCommand } from '../commands/check.command.ts';
import type { ParsedArgs } from '../command-registry.ts';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function setupRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-wiring-trust-'));
  git(root, 'init');
  git(root, 'config', 'user.email', 't@t.t');
  git(root, 'config', 'user.name', 't');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"wiring-demo","version":"0.0.0"}\n');
  writeFileSync(join(root, 'src', 'tokens.ts'), 'export const FOO_TOKEN = 1;\nexport const BAR_TOKEN = 2;\n');
  writeFileSync(join(root, 'src', 'registry.ts'), 'register(FOO_TOKEN);\nregister(BAR_TOKEN);\n');
  writeFileSync(join(root, 'README.md'), 'baseline\n');
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    [
      'export default {',
      '  wiringRules: [{',
      "    id: 'demo.tokens',",
      "    declared: { files: ['src/tokens.ts'], pattern: 'export const (\\\\w+_TOKEN)' },",
      "    registered: { files: ['src/registry.ts'], pattern: 'register\\\\((\\\\w+_TOKEN)' },",
      '  }],',
      '};',
    ].join('\n'),
  );
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'init');
  return root;
}

function makeArgs(positional: string[], cwd: string, flags: Record<string, string | boolean> = {}): ParsedArgs {
  return {
    positional,
    flags: new Map<string, string | boolean>([['cwd', cwd], ...Object.entries(flags)]),
    multiFlags: new Map<string, string[]>(),
  };
}

function capture(): { restore: () => string } {
  const orig = process.stdout.write.bind(process.stdout);
  let body = '';
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    body += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  return {
    restore() {
      process.stdout.write = orig;
      return body;
    },
  };
}

describe('check wiring — earned verdict (§1.1/§3.1)', () => {
  test('bare run evaluates every rule and reports an honest full green', async () => {
    const root = setupRepo();
    try {
      const cap = capture();
      const code = await checkCommand.run(makeArgs(['wiring'], root, { json: true }));
      const out = JSON.parse(cap.restore());
      expect(code).toBe(0);
      expect(out.configured).toBe(1);
      expect(out.evaluated).toBe(1);
      expect(out.skippedByScope).toBe(0);
      expect(out.notVerified).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('--changed-only on a diff that touches no rule scope reports 0 evaluated — NOT a green', async () => {
    const root = setupRepo();
    try {
      // Change a file that is neither the declared nor the registered source.
      writeFileSync(join(root, 'README.md'), 'baseline\nchanged\n');

      const capJson = capture();
      const code = await checkCommand.run(makeArgs(['wiring'], root, { json: true, 'changed-only': true }));
      const out = JSON.parse(capJson.restore());
      expect(code).toBe(0);
      expect(out.configured).toBe(1);
      expect(out.evaluated).toBe(0);
      expect(out.skippedByScope).toBe(1);

      // Text mode must say so LOUDLY — no unqualified green over 0 checks.
      const capText = capture();
      await checkCommand.run(makeArgs(['wiring'], root, { 'changed-only': true }));
      const text = capText.restore();
      expect(text).toContain('0 rules evaluated');
      expect(text.toLowerCase()).toContain('not verified');
      expect(text).not.toContain('every declared token is registered');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
