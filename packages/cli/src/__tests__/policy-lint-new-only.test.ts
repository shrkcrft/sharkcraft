/**
 * §2.1 — `policy-lint --new-only` scans the whole tree but reports only findings
 * the current change introduced, bucketing pre-existing baseline debt as hidden.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { policyLintCommand } from '../commands/policy-lint.command.ts';
import type { ParsedArgs } from '../command-registry.ts';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function setupRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-policy-new-only-'));
  git(root, 'init');
  git(root, 'config', 'user.email', 't@t.t');
  git(root, 'config', 'user.name', 't');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"policy-demo","version":"0.0.0"}\n');
  // A pre-existing violation, committed as baseline.
  writeFileSync(join(root, 'src', 'old.ts'), 'export const a = FORBIDDEN_TOKEN;\n');
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    [
      'export default {',
      '  policyRules: [{',
      "    id: 'no-forbidden',",
      "    surface: 'ts',",
      "    pattern: 'FORBIDDEN_TOKEN',",
      "    message: 'remove the forbidden token',",
      "    severity: 'error',",
      '  }],',
      '};',
    ].join('\n'),
  );
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'init');
  return root;
}

function makeArgs(cwd: string, flags: Record<string, string | boolean> = {}): ParsedArgs {
  return {
    positional: [],
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

describe('policy-lint --new-only (§2.1)', () => {
  test('shows only the change-introduced finding; hides pre-existing baseline debt', async () => {
    const root = setupRepo();
    try {
      // A NEW violation in an untracked file (the change under review).
      writeFileSync(join(root, 'src', 'new.ts'), 'export const b = FORBIDDEN_TOKEN;\n');

      // Bare run sees BOTH the pre-existing and the new violation.
      const capAll = capture();
      await policyLintCommand.run(makeArgs(root, { json: true }));
      const all = JSON.parse(capAll.restore());
      const allFiles = all.findings.map((f: { file: string }) => f.file).sort();
      expect(allFiles).toEqual(['src/new.ts', 'src/old.ts']);

      // --new-only shows only the finding this change introduced.
      const capNew = capture();
      const code = await policyLintCommand.run(makeArgs(root, { json: true, 'new-only': true }));
      const out = JSON.parse(capNew.restore());
      expect(out.newOnly).toBe(true);
      expect(out.findings.map((f: { file: string }) => f.file)).toEqual(['src/new.ts']);
      expect(out.hiddenBaseline).toBe(1);
      // A new error still fails the run.
      expect(code).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
