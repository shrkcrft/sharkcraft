/**
 * r77 — the "stdout is piped" note fires only for a pipe (round 13, lane P;
 * facts-V1 "the 'stdout is piped' note fires for a plain file redirect").
 *
 * `main.ts` keyed the note on `!process.stdout.isTTY`, which a regular file
 * satisfies too: `… check boundaries > log 2>&1; echo $?` printed the exit
 * correctly AND wrote "note: stdout is piped — $? reflects the downstream
 * command" into the log, where nothing was downstream. The predicate is now
 * `isStdoutPipe()` — a FIFO or a socket, never a file, a TTY or /dev/null.
 *
 * Spawned from source with a real file descriptor and a real pipe.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isStdoutPipe } from '../output/stdout-is-pipe.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const T = 60_000;
const NOTE = 'stdout is piped';
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** No conventions: `conventions doctor` is a verdict verb that exits 2 here — a code a pipe would mask. */
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r77-piped-'));
  roots.push(root);
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
  writeFileSync(join(root, 'sharkcraft', 'sharkcraft.config.ts'), "export default { projectName: 'fx' };\n");
  return root;
}

describe('the piped-exit note', () => {
  test(
    'a plain file redirect: no note — the exit is readable from $? (it said "stdout is piped")',
    () => {
      const root = workspace();
      const out = join(root, 'out.log');
      const fd = openSync(out, 'w');
      try {
        const res = spawnSync('bun', ['run', CLI_MAIN, 'conventions', 'doctor'], {
          cwd: root,
          stdio: ['ignore', fd, 'pipe'],
          encoding: 'utf8',
        });
        expect(res.status).toBe(2);
        expect(res.stderr ?? '').not.toContain(NOTE);
      } finally {
        closeSync(fd);
      }
      expect(readFileSync(out, 'utf8')).toContain('Conventions doctor');
    },
    T,
  );

  test(
    'a real pipe: the note is printed (a downstream `$?` would mask the 2)',
    () => {
      const root = workspace();
      const res = spawnSync('bun', ['run', CLI_MAIN, 'conventions', 'doctor'], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
      expect(res.status).toBe(2);
      expect(res.stderr ?? '').toContain(NOTE);
    },
    T,
  );

  test('isStdoutPipe: a regular file, /dev/null and a closed fd are not pipes', () => {
    const root = workspace();
    const file = openSync(join(root, 'f.txt'), 'w');
    const devNull = openSync('/dev/null', 'w');
    try {
      expect(isStdoutPipe(file)).toBe(false);
      expect(isStdoutPipe(devNull)).toBe(false);
    } finally {
      closeSync(file);
      closeSync(devNull);
    }
    expect(isStdoutPipe(987_654)).toBe(false);
  });
});
