/**
 * r78 — every pack gate rule the merge seam refuses is its own ERRORED row,
 * however many share an id (round 15 follow-up, lane B — B2).
 *
 * The seam validates a pack element before it checks for a duplicate id, so
 * two invalid pack rules sharing an id are BOTH `invalid`. `seamRejectedRules`
 * deduped its rows by `plane:id`, so the second was silently dropped. On a
 * pack with two invalid `pk-same` policy rules, `packs contributions` listed
 * two refusals while `gates check --json` said `rejected: 1`, printed one
 * error row and counted `failed: 1`. The same key let a refused pack `pk-x`
 * row share its id with the LOCAL `pk-x` that ran: two `gate.rules` rows, one
 * passed and one error.
 *
 * Now there is one row per refused DECLARATION. Row ids are unique within the
 * plane and never equal to a running rule's id. Real workspace, a real pack
 * under node_modules, the CLI spawned from source.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const T = 60_000;
const PACK = '@r78/seam-shared-id';
const roots: string[] = [];

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function shrk(cwd: string, argv: readonly string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('bun', ['--no-install', CLI_MAIN, '--no-hints', ...argv], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function json<T>(cwd: string, argv: readonly string[]): { readonly status: number; readonly body: T } {
  const r = shrk(cwd, argv);
  try {
    return { status: r.status, body: JSON.parse(r.stdout) as T };
  } catch {
    throw new Error(`\`shrk ${argv.join(' ')}\` did not print JSON (exit ${r.status}):\n${r.stdout.slice(0, 800)}\n${r.stderr.slice(0, 800)}`);
  }
}

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

const ts = (value: unknown): string => `export default ${JSON.stringify(value, null, 2)};\n`;
const NEVER = { surface: 'ts', files: ['src/**/*.ts'], pattern: 'NEVER_PRESENT_XYZ', message: 'm', severity: 'warning', failOnEmpty: false };

/** The local `pk-x` runs. The pack refuses three declarations: two `pk-same` and one `pk-x`. */
const root = ((): string => {
  const dir = mkdtempSync(join(tmpdir(), 'shrk-r78-seam-shared-id-'));
  roots.push(dir);
  write(dir, 'package.json', JSON.stringify({ name: 'fx', version: '0.0.0' }));
  write(dir, 'sharkcraft/sharkcraft.config.ts', ts({ projectName: 'fx', policyRules: [{ id: 'pk-x', ...NEVER }] }));
  write(dir, 'src/a.ts', 'export const A = 1; // TODO\n');
  const pack = `node_modules/${PACK}`;
  write(dir, `${pack}/package.json`, JSON.stringify({ name: PACK, version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }));
  write(
    dir,
    `${pack}/manifest.json`,
    JSON.stringify({
      schema: 'sharkcraft.pack/v1',
      info: { name: PACK, version: '0.0.1' },
      contributions: { policyRuleFiles: ['./policy.ts'] },
    }),
  );
  write(
    dir,
    `${pack}/policy.ts`,
    ts([
      { id: 'pk-ok', ...NEVER },
      // [1] negation-only `files` — refused
      { id: 'pk-same', surface: 'ts', files: ['!src/**/*.ts'], pattern: 'TODO', message: 'first', severity: 'error' },
      // [2] the same id, an unknown severity — refused too
      { id: 'pk-same', surface: 'ts', files: ['src/**/*.ts'], pattern: 'TODO', message: 'second', severity: 'fatal' },
      // [3] the LOCAL rule's id, negation-only — refused (validation runs before the duplicate check)
      { id: 'pk-x', surface: 'ts', files: ['!src/**/*.ts'], pattern: 'TODO', message: 'bad', severity: 'error' },
    ]),
  );
  return dir;
})();

/**
 * A pack whose ONLY policy file default-exports one object, not an array (review
 * finding): none of its rules is known, so none runs. It was a diagnostic line
 * only — `gates check` / `policy-lint` printed "Every declared rule ran and
 * passed ✓" at exit 0 and `packs contributions` said "0 declared · 0 accepted ✓".
 */
const objRoot = ((): string => {
  const dir = mkdtempSync(join(tmpdir(), 'shrk-r78-seam-non-array-'));
  roots.push(dir);
  write(dir, 'package.json', JSON.stringify({ name: 'fx', version: '0.0.0' }));
  write(dir, 'sharkcraft/sharkcraft.config.ts', ts({ projectName: 'fx', policyRules: [{ id: 'loc', ...NEVER }] }));
  write(dir, 'src/a.ts', 'export const A = 1; // TODO\n');
  const pack = `node_modules/${PACK}-obj`;
  write(dir, `${pack}/package.json`, JSON.stringify({ name: `${PACK}-obj`, version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }));
  write(
    dir,
    `${pack}/manifest.json`,
    JSON.stringify({
      schema: 'sharkcraft.pack/v1',
      info: { name: `${PACK}-obj`, version: '0.0.1' },
      contributions: { policyRuleFiles: ['./obj.ts'] },
    }),
  );
  write(dir, `${pack}/obj.ts`, ts({ id: 'pk-obj', surface: 'ts', files: ['src/**/*.ts'], pattern: 'TODO', message: 'obj', severity: 'error' }));
  return dir;
})();

interface IGateRow {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly error?: string;
}

describe('r78 B2 — one errored row per refused pack declaration, ids unique', () => {
  test(
    '`gates check --json`: three refused declarations are three errored rows, and no id is shared with a running rule',
    () => {
      const { status, body } = json<{ rejected: number; gate: { exit: number; failed: number; rules: IGateRow[] } }>(root, [
        'gates',
        'check',
        '--json',
      ]);
      expect(status).toBe(1);
      expect(body.gate.exit).toBe(1);
      expect(body.rejected).toBe(3);
      const errored = body.gate.rules.filter((r) => r.status === 'error');
      expect(errored).toHaveLength(3);
      expect(body.gate.failed).toBe(3);
      for (const r of errored) expect(r.error).toContain('failed validation at the pack-plane merge seam — NOT evaluated');
      // Both `pk-same` declarations are rows: the first keeps its id, the second names its site.
      const same = errored.filter((r) => r.id === 'pk-same' || r.id.startsWith('pk-same ('));
      expect(same).toHaveLength(2);
      expect(same.map((r) => r.id)).toContain('pk-same');
      expect(same.find((r) => r.id !== 'pk-same')?.id).toContain('policy.ts[2]');
      // The refused pack `pk-x` never takes the id of the local `pk-x` that ran.
      expect(body.gate.rules.filter((r) => r.id === 'pk-x').map((r) => r.status)).toEqual(['passed']);
      expect(errored.some((r) => r.id.startsWith('pk-x (') && r.id.includes('policy.ts[3]'))).toBe(true);
      // Every row id is unique within the run.
      const ids = body.gate.rules.map((r) => `${r.type}:${r.id}`);
      expect(new Set(ids).size).toBe(ids.length);
    },
    T,
  );

  test(
    '`policy-lint --json` and the `gates check` text agree: every refused declaration is named',
    () => {
      const policy = json<{ rejected: { id: string }[]; gate: { exit: number } }>(root, ['policy-lint', '--json']);
      expect(policy.status).toBe(1);
      expect(policy.body.rejected).toHaveLength(3);
      expect(new Set(policy.body.rejected.map((r) => r.id)).size).toBe(3);

      const text = shrk(root, ['gates', 'check']);
      expect(text.status).toBe(1);
      const refusedLines = text.stdout.split('\n').filter((l) => /pk-same|pk-x \(/.test(l) && /REJECTED|NOT evaluated|failed validation/.test(l));
      expect(refusedLines.length).toBeGreaterThanOrEqual(3);
      expect(text.stdout).not.toContain('Every declared rule ran and passed');
    },
    T,
  );

  test(
    'a pack policy file whose default export is not an array is an ERRORED row on every plane reader — never ✓ at exit 0',
    () => {
      const gc = json<{ gate: { exit: number; failed: number; rules: IGateRow[] } }>(objRoot, ['gates', 'check', '--json']);
      expect(gc.status).toBe(1);
      expect(gc.body.gate.exit).toBe(1);
      const errored = gc.body.gate.rules.filter((r) => r.status === 'error');
      expect(errored).toHaveLength(1);
      expect(errored[0]!.error).toContain('none of its rules was evaluated: default export is not an array');
      expect(gc.body.gate.rules.filter((r) => r.id === 'loc').map((r) => r.status)).toEqual(['passed']);

      const lint = shrk(objRoot, ['policy-lint']);
      expect(lint.status).toBe(1);
      const text = shrk(objRoot, ['gates', 'check']);
      expect(text.status).toBe(1);
      expect(text.stdout).not.toContain('Every declared rule ran and passed');
      // `packs contributions` counts the same file as a load failure (it read "0 declared · 0 accepted ✓").
      const pc = shrk(objRoot, ['packs', 'contributions']);
      expect(pc.stdout).toContain('default export is not an array');
      expect(pc.status).toBe(1);
    },
    T,
  );
});
