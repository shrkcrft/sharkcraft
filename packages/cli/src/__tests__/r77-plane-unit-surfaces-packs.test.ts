/**
 * r77 — pack-contributed units and the surfaces that fold them (round 13
 * fixer F1: K10, K11 and the routed review findings on finish / quality /
 * the asset doctors).
 *
 *   - K10: `docs references list` lists a pack doc-reference rule the merge
 *     seam REJECTED, and `explain --id <it>` names the rejection (1, not 3);
 *   - K11: `registrations doctor`'s status column fits `intended-empty`;
 *   - an asset doctor that exits 1 on `--fail-on-dead-units` prints why, and
 *     carries `failingUnits`;
 *   - finish's wiring sub-gate carries the rule's expectEmpty acceptance;
 *   - finish and quality word a PACK marker that went live as INFO, never
 *     advisory.
 *
 * Real packs under the fixture's node_modules, the real loaders, the CLI
 * spawned from source.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const CLI_MAIN = join(REPO_ROOT, 'packages', 'cli', 'src', 'main.ts');
const T = 90_000;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function write(root: string, files: Readonly<Record<string, string>>): void {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
}

/** A consumer with one pack `<pkg>` under node_modules contributing `slots` (slot → { file: body }). */
function consumer(
  config: string,
  pkg: string,
  slots: Readonly<Record<string, Readonly<Record<string, string>>>>,
  extra: Readonly<Record<string, string>> = {},
): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r77-plane-packs-'));
  roots.push(root);
  const contributions: Record<string, string[]> = {};
  const packFiles: Record<string, string> = {};
  for (const [slot, files] of Object.entries(slots)) {
    for (const [file, body] of Object.entries(files)) {
      (contributions[slot] ??= []).push(`./${file}`);
      packFiles[`node_modules/${pkg}/${file}`] = body;
    }
  }
  write(root, {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0', private: true }),
    'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'fx', ${config} };\n`,
    [`node_modules/${pkg}/package.json`]: JSON.stringify({ name: pkg, version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }),
    [`node_modules/${pkg}/manifest.json`]: JSON.stringify({
      schema: 'sharkcraft.pack/v1',
      info: { name: pkg, version: '0.0.1' },
      contributions,
    }),
    ...packFiles,
    ...extra,
  });
  return root;
}

function shrk(root: string, argv: readonly string[]): { readonly code: number; readonly out: string; readonly err: string } {
  const r = spawnSync('bun', [CLI_MAIN, '--no-hints', '--cwd', root, ...argv], {
    encoding: 'utf8',
    timeout: 90_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

function git(root: string, ...args: string[]): void {
  spawnSync('git', ['-c', 'user.email=r77@example.com', '-c', 'user.name=r77', '-c', 'commit.gpgsign=false', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

/** Commit the fixture, then touch `rel` so `finish --since HEAD` has one changed file. */
function commitThenChange(root: string, rel: string, body: string): void {
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  writeFileSync(join(root, rel), body);
}

interface IFinishJson {
  readonly exitCode?: number;
  readonly gate: { readonly accepted: readonly string[]; readonly exit: number };
  readonly gates: readonly {
    readonly name: string;
    readonly status: string;
    readonly detail: string;
    readonly notes?: readonly string[];
  }[];
}

describe('K10 — docs references list / explain show a merge-seam-rejected pack rule', () => {
  test(
    'list names it under "rejected at the pack-plane merge seam"; explain --id names the rejection (1, never "unknown id" 3)',
    () => {
      const invalid = { id: 'pk-docs-bad', files: ['docs/**/*.md'], tokenPattern: 'zz', resolvesAs: ['command'], bogusKey: true };
      const root = consumer('', '@r77/docrefs', { docReferenceFiles: { 'docrefs.ts': `export default ${JSON.stringify([invalid])};\n` } }, {
        'docs/a.md': 'Run `shrk doctor` first.\n',
      });
      const list = shrk(root, ['docs', 'references', 'list']);
      expect(list.code).toBe(0);
      expect(list.out).toContain('rejected at the pack-plane merge seam — never checked (1)');
      expect(list.out).toContain('pk-docs-bad  REJECTED');
      const listJson = JSON.parse(shrk(root, ['docs', 'references', 'list', '--json']).out) as {
        readonly rejected: readonly { readonly id: string }[];
      };
      expect(listJson.rejected.map((r) => r.id)).toEqual(['pk-docs-bad']);
      const explain = shrk(root, ['docs', 'references', 'explain', '--id', 'pk-docs-bad']);
      expect(explain.code).toBe(1);
      expect(explain.out).toContain('pk-docs-bad  REJECTED');
      expect(explain.err).not.toContain('Unknown doc-reference rule id');
    },
    T,
  );
});

describe('registration hints — K11 and the --fail-on-dead-units failure line', () => {
  const HINT = (targetGlobs: string): string =>
    `export default [{ id: 'fx.routes', title: 'Routes', discovery: { targetGlobs: [${targetGlobs}] }, operations: [{ kind: 'append', snippet: 'x' }] }];\n`;

  test(
    'K11: an intended-empty hint row keeps its status and id apart (the status column fits `intended-empty`)',
    () => {
      const root = consumer('', '@fx/planned', {
        registrationHintFiles: { 'registration-hints.ts': HINT("{ pattern: 'src/app/**/app.routes.ts', expectEmpty: true }") },
      });
      const r = shrk(root, ['registrations', 'doctor']);
      expect(r.out).toMatch(/^ {2}intended-empty +fx\.routes /m);
      expect(r.out).not.toContain('intended-emptyfx.routes');
    },
    T,
  );

  test(
    'a dead discovery glob under --fail-on-dead-units: 1 with a verdict line naming it, and `failingUnits` in --json',
    () => {
      const root = consumer('', '@fx/dead', {
        registrationHintFiles: { 'registration-hints.ts': HINT("'src/nowhere/**/*.ts'") },
      });
      const r = shrk(root, ['registrations', 'doctor', '--fail-on-dead-units']);
      expect(r.code).toBe(1);
      expect(r.out).toContain('Verdict: registration-hint doctor needs attention — 1 dead unit(s) (--fail-on-dead-units)');
      const json = JSON.parse(shrk(root, ['registrations', 'doctor', '--fail-on-dead-units', '--json']).out) as {
        readonly exitCode: number;
        readonly failingUnits: readonly { readonly state: string }[];
      };
      expect(json.exitCode).toBe(1);
      expect(json.failingUnits.map((u) => u.state)).toEqual(['dead']);
      // Without the flag the same unit is a coverage gap (2), never a failure line.
      const plain = shrk(root, ['registrations', 'doctor']);
      expect(plain.code).toBe(2);
      expect(plain.out).not.toContain('needs attention');
    },
    T,
  );
});

describe('finish and quality fold every acceptance, and word a pack marker as INFO', () => {
  const PAT = "'plugin[(]([a-z]+)[)]'";

  test(
    'finish: a fully marked wiring rule in scope prints its acceptance (gate.accepted), as `check wiring` does',
    () => {
      const root = consumer(
        `wiringRules: [{ id: 'plugins-registered', declared: { files: [{ pattern: 'src/plugins/*.ts', expectEmpty: true }], pattern: ${PAT} }, registered: { files: ['src/registry.ts'], pattern: ${PAT} } }]`,
        '@fx/none',
        {},
        { '.gitignore': '.sharkcraft/\nnode_modules/\n', 'src/registry.ts': '// nothing registered yet\n' },
      );
      expect(shrk(root, ['check', 'wiring']).out).toContain('plugins-registered: accepted by expectEmpty');
      commitThenChange(root, 'src/registry.ts', '// still nothing registered\n');
      const finish = JSON.parse(shrk(root, ['finish', '--json', '--since', 'HEAD']).out) as IFinishJson;
      const wiring = finish.gates.find((g) => g.name === 'wiring');
      expect(wiring?.status).toBe('pass');
      expect(finish.gate.accepted.join('\n')).toContain('plugins-registered: accepted by expectEmpty');
    },
    T,
  );

  test(
    'finish and quality: a PACK boundary marker that went live is [info] / info:, never advisory',
    () => {
      const RULE = 'layer.no-imports-up';
      const packRule = `export default [{ id: '${RULE}', title: 'No imports up', from: ['packages/app/**'],
  forbiddenImports: ['@scope/kernel-*', { pattern: '@scope/plugin-react', expectEmpty: true }] }];\n`;
      const root = consumer('', '@acme/fence-pack', { boundaryFiles: { 'boundaries.ts': packRule } }, {
        '.gitignore': '.sharkcraft/\nnode_modules/\n',
        'packages/app/package.json': JSON.stringify({ name: '@scope/app', version: '0.0.0' }),
        'packages/app/src/x.ts': "import { u } from '@scope/util';\nexport const x = u;\n",
        'packages/kernel-a/package.json': JSON.stringify({ name: '@scope/kernel-a', version: '0.0.0' }),
        'packages/kernel-a/src/index.ts': 'export const k = 1;\n',
        'packages/util/package.json': JSON.stringify({ name: '@scope/util', version: '0.0.0' }),
        'packages/util/src/index.ts': 'export const u = 1;\n',
        'packages/plugin-react/package.json': JSON.stringify({ name: '@scope/plugin-react', version: '0.0.0' }),
      });
      // check boundaries keeps the pack marker in its INFO block — the reference wording.
      expect(shrk(root, ['check', 'boundaries']).out).toContain('INFO — pack expectEmpty markers that went live (1)');
      const quality = shrk(root, ['quality', '--json']);
      expect(quality.out).toContain(`info: [forbidden] ${RULE}: @scope/plugin-react`);
      expect(quality.out).not.toContain(`advisory: [forbidden] ${RULE}: @scope/plugin-react`);
      commitThenChange(root, 'packages/app/src/x.ts', "import { u } from '@scope/util';\nexport const x = u + 1;\n");
      const finish = JSON.parse(shrk(root, ['finish', '--json', '--since', 'HEAD']).out) as IFinishJson;
      const gate = finish.gates.find((g) => g.name === 'boundaries')!;
      expect(gate.detail).toContain('1 pack expectEmpty marker(s) went live (INFO)');
      expect(gate.detail).not.toContain('went live (advisory)');
      expect((gate.notes ?? []).join('\n')).toContain(`[info] [forbidden] ${RULE}: @scope/plugin-react`);
    },
    T,
  );
});
