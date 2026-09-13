/**
 * r77 — P3: `docReferenceFiles` is a DECLARED pack slot (round 13, DECISIONS
 * §5 P3; facts-V2 "Pack doc-reference contributions bypass the round-12
 * rejection channel" + "A VALID pack doc-reference rule is enforced, yet the
 * contribution inventory says no contributed file exists").
 *
 * The merge seam always READ `docReferenceFiles`, but no manifest declared it
 * and the seam recorded no outcome for it: an invalid pack docReference rule was
 * a diagnostic string only (`packs contributions` omitted the file, `packs
 * list` showed no count, `gates check` had no ERRORED row), and a valid one was
 * enforced while `packs contributions` said no contributed file existed. It is
 * now in `CONTRIBUTION_FILE_KEYS`, has `ContributionKind.DocReference`, a
 * PLANE_OF_KIND row, a pack-seam schema row and a real outcome sink — so it
 * travels the round-12 channel like every other gate plane.
 *
 * A real pack under the fixture's node_modules; the CLI spawned from source.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ContributionKind,
  contributionKindForSlot,
  packPlaneElementRejectionReasons,
} from '@shrkcrft/inspector';
import { CONTRIBUTION_FILE_KEYS } from '@shrkcrft/plugin-api';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const PACK = '@r77/docrefs';
const PACK_DIR = `node_modules/${PACK}`;
const T = 120_000;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const VALID = {
  id: 'pk-docs-valid',
  files: ['docs/**/*.md'],
  tokenPattern: 'shrk [a-z]+',
  resolvesAs: ['command'],
  requireContext: 'backtick',
  severity: 'warning',
};
const INVALID = { id: 'pk-docs-bad', files: ['docs/**/*.md'], tokenPattern: 'zz', resolvesAs: ['command'], bogusKey: true };

function workspace(rules: readonly unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r77-docref-slot-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx' };\n",
    'docs/a.md': 'Run `shrk doctor` first.\n',
    [`${PACK_DIR}/package.json`]: JSON.stringify({ name: PACK, version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }),
    [`${PACK_DIR}/manifest.json`]: JSON.stringify({
      schema: 'sharkcraft.pack/v1',
      info: { name: PACK, version: '0.0.1' },
      contributions: { docReferenceFiles: ['./docrefs.ts'] },
    }),
    [`${PACK_DIR}/docrefs.ts`]: `export default ${JSON.stringify(rules, null, 2)};\n`,
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

function shrk(cwd: string, argv: readonly string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('bun', ['run', CLI_MAIN, '--no-hints', ...argv], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function json<T>(cwd: string, argv: readonly string[]): { status: number; body: T } {
  const r = shrk(cwd, argv);
  try {
    return { status: r.status, body: JSON.parse(r.stdout) as T };
  } catch {
    throw new Error(`\`shrk ${argv.join(' ')}\` did not print JSON (exit ${r.status}):\n${r.stdout}\n${r.stderr}`);
  }
}

interface IContributionsJson {
  readonly exitCode: number;
  readonly report: {
    readonly files: readonly {
      file: string;
      kind: string;
      declared: number;
      accepted: number;
      rejected: readonly { entryId?: string; index: number; reasons: readonly string[] }[];
    }[];
  };
}

describe('P3 — one table each: the slot, the kind, the seam schema', () => {
  test('`docReferenceFiles` is a loader-backed slot of kind `doc-reference`, validated by the plane schema', () => {
    expect(CONTRIBUTION_FILE_KEYS).toContain('docReferenceFiles');
    expect(contributionKindForSlot('docReferenceFiles')).toBe(ContributionKind.DocReference);
    expect(packPlaneElementRejectionReasons('docReferenceFiles', VALID)).toEqual([]);
    const reasons = packPlaneElementRejectionReasons('docReferenceFiles', { id: 'x' }) ?? [];
    expect(reasons.some((r) => r.startsWith('files:'))).toBe(true);
  });
});

describe('P3 — a rejected pack doc-reference rule travels the round-12 channel', () => {
  const root = workspace([VALID, INVALID]);

  test(
    '`packs contributions` names the file and the refused entry, and exits 1 (it omitted the file)',
    () => {
      const { status, body } = json<IContributionsJson>(root, ['packs', 'contributions', '--json']);
      expect(status).toBe(1);
      expect(body.exitCode).toBe(1);
      const row = body.report.files.find((f) => f.file === `${PACK_DIR}/docrefs.ts`);
      expect(row).toMatchObject({ kind: 'doc-reference', declared: 2, accepted: 1 });
      expect(row?.rejected.map((r) => [r.entryId, r.index])).toEqual([['pk-docs-bad', 1]]);
      expect(row?.rejected[0]?.reasons.join('; ')).toContain('bogusKey');
    },
    T,
  );

  test(
    '`packs list` counts the doc-reference kind, accepted and rejected',
    () => {
      const { status, body } = json<{ packageName: string; entryCounts: Record<string, { files: number; accepted: number; rejected: number }> }[]>(
        root,
        ['packs', 'list', '--json'],
      );
      expect(status).toBe(0);
      const counts = body.find((p) => p.packageName === PACK)?.entryCounts;
      expect(counts?.['doc-reference']).toEqual({ files: 1, accepted: 1, rejected: 1 });
    },
    T,
  );

  test(
    '`packs test --load` refuses the same entry through the same predicate (it reported no issue)',
    () => {
      const { status, body } = json<{ issues: { code: string; message: string }[] }>(root, [
        'packs',
        'test',
        PACK_DIR,
        '--load',
        '--json',
      ]);
      expect(status).toBe(1);
      expect(body.issues.some((i) => i.code === 'asset-entry-rejected' && i.message.includes('pk-docs-bad'))).toBe(true);
    },
    T,
  );

  test(
    '`gates check` carries it as an ERRORED doc-reference row and exits 1; the valid rule still runs',
    () => {
      const { status, body } = json<{ gate: { exit: number; rules: { id: string; type: string; status: string; error?: string }[] } }>(
        root,
        ['gates', 'check', '--json'],
      );
      expect(status).toBe(1);
      expect(body.gate.exit).toBe(1);
      const bad = body.gate.rules.find((r) => r.id === 'pk-docs-bad');
      expect(bad).toMatchObject({ type: 'doc-reference', status: 'error' });
      expect(bad?.error).toContain('failed validation at the pack-plane merge seam — NOT evaluated');
      expect(body.gate.rules.find((r) => r.id === 'pk-docs-valid')?.status).toBe('passed');
    },
    T,
  );
});

describe('P3 review — `docs references check` (the plane’s own verb) agrees with `gates check`', () => {
  test(
    'a rejected pack rule beside a valid one: an ERRORED row and exit 1 in text and JSON (it printed ✓ at 0 with a diagnostic line)',
    () => {
      const root = workspace([VALID, INVALID]);
      const text = shrk(root, ['docs', 'references', 'check']);
      expect(text.status).toBe(1);
      expect(text.stdout).toContain('pk-docs-bad  REJECTED');
      expect(text.stdout).toContain('failed validation at the pack-plane merge seam — NOT evaluated');
      expect(text.stdout).not.toContain('Every id cited in prose resolves. ✓');
      const { status, body } = json<{
        exitCode: number;
        rejected: readonly { id: string }[];
        gate: { exit: number; rules: readonly { id: string; status: string }[] };
      }>(root, ['docs', 'references', 'check', '--json']);
      expect(status).toBe(1);
      expect(body.exitCode).toBe(1);
      expect(body.gate.exit).toBe(1);
      expect(body.rejected.map((r) => r.id)).toEqual(['pk-docs-bad']);
      expect(body.gate.rules.find((r) => r.id === 'pk-docs-bad')?.status).toBe('error');
      expect(body.gate.rules.find((r) => r.id === 'pk-docs-valid')?.status).toBe('passed');
    },
    T,
  );

  test(
    'the rejected rule is the only one: 1 with its row — never "No doc-reference rules declared" at 2',
    () => {
      const root = workspace([INVALID]);
      const text = shrk(root, ['docs', 'references', 'check']);
      expect(text.status).toBe(1);
      expect(text.stdout).not.toContain('No doc-reference rules declared');
      expect(text.stdout).toContain('pk-docs-bad  REJECTED');
      expect(shrk(root, ['gates', 'check']).status).toBe(1);
    },
    T,
  );
});

describe('P3 — a VALID pack doc-reference file is on the contributions inventory', () => {
  test(
    '`packs contributions` lists it, accepted (it said "no contributed file … was discovered", exit 2)',
    () => {
      const root = workspace([VALID]);
      const { status, body } = json<IContributionsJson>(root, ['packs', 'contributions', '--json']);
      expect(status).toBe(0);
      const row = body.report.files.find((f) => f.file === `${PACK_DIR}/docrefs.ts`);
      expect(row).toMatchObject({ kind: 'doc-reference', declared: 1, accepted: 1, rejected: [] });
    },
    T,
  );
});
