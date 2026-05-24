import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateCommand } from '../commands/gate.command.ts';

function makeArgs(positional: string[], cwd: string): {
  positional: string[];
  flags: Map<string, string | boolean>;
  multiFlags: Map<string, string[]>;
} {
  const flags = new Map<string, string | boolean>();
  flags.set('cwd', cwd);
  flags.set('json', true);
  return {
    positional,
    flags,
    multiFlags: new Map<string, string[]>(),
  };
}

function capture(): { restore: () => string } {
  const orig = process.stdout.write.bind(process.stdout);
  let body = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  return {
    restore() {
      process.stdout.write = orig;
      return body;
    },
  };
}

describe('shrk gate scaffold-ci', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'shrk-gate-scaffold-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('writes a GitHub workflow file by default', async () => {
    const cap = capture();
    const code = await gateCommand.run(makeArgs(['scaffold-ci'], root));
    const out = cap.restore();
    expect(code).toBe(0);
    const json = JSON.parse(out);
    expect(json.ok).toBe(true);
    expect(json.provider).toBe('github');
    const target = join(root, '.github', 'workflows', 'shrk-gate.yml');
    expect(existsSync(target)).toBe(true);
    const body = readFileSync(target, 'utf8');
    expect(body).toContain('name: shrk gate');
    expect(body).toContain('bunx shrk gate');
    expect(body).toContain('--markdown');
  });

  test('writes a generic shell script with --provider generic (chmod 755)', async () => {
    const args = makeArgs(['scaffold-ci'], root);
    args.flags.set('provider', 'generic');
    const cap = capture();
    const code = await gateCommand.run(args);
    const out = cap.restore();
    expect(code).toBe(0);
    const json = JSON.parse(out);
    expect(json.provider).toBe('generic');
    const target = join(root, 'scripts', 'shrk-gate.sh');
    expect(existsSync(target)).toBe(true);
    const stat = statSync(target);
    // Permission bits — at least owner exec.
    expect(stat.mode & 0o100).toBe(0o100);
  });

  test('refuses to overwrite without --force', async () => {
    // Seed via the CLI itself so the workflow file is written by the
    // same code path the second call needs to refuse on.
    const seed = capture();
    await gateCommand.run(makeArgs(['scaffold-ci'], root));
    seed.restore();
    const cap = capture();
    const code = await gateCommand.run(makeArgs(['scaffold-ci'], root));
    const out = cap.restore();
    expect(code).toBe(1);
    const json = JSON.parse(out);
    expect(json.ok).toBe(false);
    expect(json.error).toBe('exists');
  });

  test('overwrites with --force', async () => {
    const cap = capture();
    await gateCommand.run(makeArgs(['scaffold-ci'], root));
    cap.restore();
    const args = makeArgs(['scaffold-ci'], root);
    args.flags.set('force', true);
    const cap2 = capture();
    const code = await gateCommand.run(args);
    cap2.restore();
    expect(code).toBe(0);
  });

  test('rejects unknown providers', async () => {
    const args = makeArgs(['scaffold-ci'], root);
    args.flags.set('provider', 'jenkins');
    const code = await gateCommand.run(args);
    expect(code).toBe(2);
  });
});

describe('shrk gate scaffold-hook', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'shrk-gate-hook-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('writes a husky pre-commit hook by default (chmod 755)', async () => {
    const cap = capture();
    const code = await gateCommand.run(makeArgs(['scaffold-hook'], root));
    const out = cap.restore();
    expect(code).toBe(0);
    const json = JSON.parse(out);
    expect(json.ok).toBe(true);
    expect(json.provider).toBe('husky');
    const target = join(root, '.husky', 'pre-commit');
    expect(existsSync(target)).toBe(true);
    const body = readFileSync(target, 'utf8');
    expect(body).toContain('bunx shrk graph index --changed');
    expect(body).toContain('bunx shrk gate --strict');
    expect(statSync(target).mode & 0o100).toBe(0o100);
  });

  test('writes a raw hook with --provider raw', async () => {
    const args = makeArgs(['scaffold-hook'], root);
    args.flags.set('provider', 'raw');
    const cap = capture();
    const code = await gateCommand.run(args);
    const out = cap.restore();
    expect(code).toBe(0);
    const json = JSON.parse(out);
    expect(json.provider).toBe('raw');
    const target = join(root, 'scripts', 'pre-commit');
    expect(existsSync(target)).toBe(true);
  });

  test('refuses to overwrite without --force', async () => {
    const seed = capture();
    await gateCommand.run(makeArgs(['scaffold-hook'], root));
    seed.restore();
    const cap = capture();
    const code = await gateCommand.run(makeArgs(['scaffold-hook'], root));
    const out = cap.restore();
    expect(code).toBe(1);
    const json = JSON.parse(out);
    expect(json.error).toBe('exists');
  });

  test('rejects unknown providers', async () => {
    const args = makeArgs(['scaffold-hook'], root);
    args.flags.set('provider', 'bash-doctor');
    const code = await gateCommand.run(args);
    expect(code).toBe(2);
  });
});
