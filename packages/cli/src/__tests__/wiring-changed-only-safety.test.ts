import { beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refExists } from '@shrkcrft/inspector';
import { clearPackDiscoveryCache } from '@shrkcrft/packs';
import { wiringCommand } from '../commands/wiring.command.ts';

/**
 * Honesty guards on `wiring unprovided|orphans --changed-only | --base <ref>`
 * (a27 review fixes): a bad `--base` ref must NOT read as an empty "nothing
 * changed" scope, and SHRK's own `.sharkcraft/` self-writes must not pollute a
 * `--changed-only` scope on an otherwise-clean tree into a false green.
 */
function git(cwd: string, ...args: string[]): void {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr ?? ''}`);
}

/** A committed git repo with a DI idiom (GhostToken is unprovided). NO .gitignore
 *  for `.sharkcraft/`, so a self-written cache WOULD pollute a worktree scope. */
function setupRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-wiring-safety-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ws', version: '0.0.0' }));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    `export default {
  registrationGraph: [
    { name: 'di',
      declared: { files: ['src/**/*.ts'], pattern: 'export const ([A-Za-z]+) = new InjectionToken' },
      provided: { files: ['src/**/*.ts'], arrayProperty: 'providers' },
      consumed: { files: ['src/**/*.ts'], pattern: 'inject[(]([A-Za-z]+)' } },
  ],
};
`,
  );
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'tokens.ts'),
    "export const ApiToken = new InjectionToken('api');\nexport const GhostToken = new InjectionToken('ghost');\n",
  );
  writeFileSync(join(root, 'src', 'module.ts'), 'const providers = [ApiToken];\n');
  writeFileSync(
    join(root, 'src', 'service.ts'),
    'const a = inject(ApiToken);\nconst g = inject(GhostToken);\n',
  );
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

function args(root: string, positional: string[], flags: Record<string, string | boolean> = {}): {
  positional: string[];
  flags: Map<string, string | boolean>;
  multiFlags: Map<string, string[]>;
} {
  const f = new Map<string, string | boolean>([['cwd', root]]);
  for (const [k, v] of Object.entries(flags)) f.set(k, v);
  return { positional, flags: f, multiFlags: new Map() };
}

function captureBoth(): { restore: () => { out: string; err: string } } {
  const oo = process.stdout.write.bind(process.stdout);
  const oe = process.stderr.write.bind(process.stderr);
  let out = '';
  let err = '';
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    out += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array): boolean => {
    err += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  return {
    restore() {
      process.stdout.write = oo;
      process.stderr.write = oe;
      return { out, err };
    },
  };
}

describe('wiring --changed-only / --base honesty guards', () => {
  beforeEach(() => clearPackDiscoveryCache());

  test('an unresolvable --base ref errors to stderr and exits 2, not a silent empty scope', async () => {
    const root = setupRepo();
    try {
      const cap = captureBoth();
      const code = await wiringCommand.run(args(root, ['unprovided'], { base: 'no-such-ref-zzz' }));
      const { err } = cap.restore();
      expect(code).toBe(2);
      expect(err).toContain("cannot resolve --base ref 'no-such-ref-zzz'");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a genuinely clean tree with --changed-only is NOT-verified (2), not a green 0', async () => {
    const root = setupRepo();
    try {
      // The command self-writes .sharkcraft/ (cache + usage log) as it runs; those
      // untracked artifacts must be excluded from the scope so a clean tree stays
      // an empty scope → NotVerified(2), never a false non-empty green.
      const cap = captureBoth();
      const code = await wiringCommand.run(args(root, ['unprovided'], { 'changed-only': true }));
      cap.restore();
      expect(code).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refExists distinguishes a real ref from a typo', () => {
    const root = setupRepo();
    try {
      expect(refExists(root, 'HEAD')).toBe(true);
      expect(refExists(root, 'no-such-ref-zzz')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
