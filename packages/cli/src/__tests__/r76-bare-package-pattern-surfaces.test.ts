/**
 * Round 12 (§1.5 lock) — the consumer's EXACT rule shape, on every surface,
 * local AND pack-contributed.
 *
 * The consumer filed "a bare package pattern matches only the package
 * entrypoint" against alpha.30 and still patches every rule with a helper that
 * expands `pkg` → `pkg` + `pkg/**`. Round 11 made package semantics the default
 * (the alpha.30 evaluator reports ZERO violations for this shape). This file
 * locks the default on every surface that enforces or describes a boundary
 * rule, so a future parallel matcher — or a surface that bypasses the
 * orchestrator — fails the build:
 *
 *   enforce:  `check boundaries`, `check boundaries --changed-only`, `finish`,
 *             `diff-check`, MCP `check_boundaries` / `get_changed_boundary_report`
 *             / `get_diff_check_report`
 *   describe: `boundaries explain`, MCP `get_boundary_rule` / `list_boundary_rules`
 *
 * The rule carries NO severity and NO forbiddenMatch — the consumer's shape.
 * Real temp git repos, a real sharkcraft/boundaries.ts or a real pack under
 * node_modules (no local rule file), the real command handlers and the real
 * registered MCP handlers.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '@shrkcrft/mcp-server';
import { boundariesExplainCommand } from '../commands/boundaries.command.ts';
import { checkCommand } from '../commands/check.command.ts';
import { diffCheckCommand } from '../commands/diff-check.command.ts';
import { finishCommand } from '../commands/finish.command.ts';
import type { ParsedArgs } from '../command-registry.ts';

const SLOW = 180_000;
const RULE_ID = 'app.no-scope-pkg';
const PACK = '@r76/fence-pack';

function args(root: string, positional: string[], flags: Record<string, string | boolean> = {}): ParsedArgs {
  return {
    positional,
    flags: new Map<string, string | boolean>([['cwd', root], ...Object.entries(flags)]),
    multiFlags: new Map(),
  };
}

async function run(
  h: { run(a: ParsedArgs): Promise<number> | number },
  a: ParsedArgs,
): Promise<{ code: number; out: string }> {
  const orig = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = '';
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    out += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return { code: await h.run(a), out };
  } finally {
    process.stdout.write = orig;
    process.stderr.write = origErr;
  }
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function git(root: string, ...a: string[]): void {
  spawnSync('git', ['-c', 'user.email=r76@test', '-c', 'user.name=r76', '-c', 'commit.gpgsign=false', ...a], { cwd: root });
}

/** The consumer's rule, verbatim in shape: no severity, no forbiddenMatch (unless a variant adds one). */
const RULES = (extra: string): string => `export default [
  { id: '${RULE_ID}', title: 'App must not import @scope/pkg', from: ['packages/app/**'], forbiddenImports: ['@scope/pkg', '@scope/pkg-*']${extra} },
];
`;

/** The consumer's two subpath edges, plus a segment-boundary control and an exact match of the wildcard. */
const X_TS = [
  "import { a } from '@scope/pkg/sub';",
  "import { b } from '@scope/pkg-a/deep/thing';",
  "import { c } from '@scope/pkgx/sub';",
  "import { d } from '@scope/pkg-legacy';",
  'export const x = [a, b, c, d];',
  '',
].join('\n');

type Origin = 'local' | 'pack';

/** A committed repo whose working tree then touches the governed file (so changed-only surfaces see it). */
function project(origin: Origin, extra = ''): string {
  const root = mkdtempSync(join(tmpdir(), `shrk-r76-bare-${origin}-`));
  roots.push(root);
  const files: Record<string, string> = {
    '.gitignore': '.sharkcraft/\n',
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0', type: 'module', private: true }),
    'packages/app/src/x.ts': X_TS,
    ...(origin === 'local'
      ? {
          'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx', boundaryFiles: ['boundaries.ts'] };\n",
          'sharkcraft/boundaries.ts': RULES(extra),
        }
      : {
          // No local rule file — the rule arrives ONLY through the pack's manifest.
          'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx' };\n",
          [`node_modules/${PACK}/package.json`]: JSON.stringify({
            name: PACK,
            version: '0.0.1',
            type: 'module',
            sharkcraft: { manifest: './manifest.json' },
          }),
          [`node_modules/${PACK}/manifest.json`]: JSON.stringify({
            schema: 'sharkcraft.pack/v1',
            info: { name: PACK, version: '0.0.1' },
            contributions: { boundaryFiles: ['./boundaries.ts'] },
          }),
          [`node_modules/${PACK}/boundaries.ts`]: RULES(extra),
        }),
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  appendFileSync(join(root, 'packages/app/src/x.ts'), 'export const touched = 1;\n');
  return root;
}

type Row = readonly [string, string | undefined, string | undefined];
interface IViolationLike {
  importSpecifier: string;
  matchedForbidden?: string;
  matchKind?: string;
}
const rowsOf = (vs: readonly IViolationLike[]): Row[] => vs.map((v) => [v.importSpecifier, v.matchedForbidden, v.matchKind]);

/** `finish` items carry the rendered violation message — read the row back out of what the surface prints. */
function rowOfFinishMessage(message: string): Row {
  const m = /"([^"]+)" matched "([^"]+)"( \(a subpath of the forbidden package\))?/.exec(message);
  if (!m) throw new Error(`not a forbidden-import message: ${message}`);
  return [m[1]!, m[2]!, m[3] ? 'subpath' : 'exact'];
}

const PACKAGE_ROWS: Row[] = [
  ['@scope/pkg/sub', '@scope/pkg', 'subpath'],
  ['@scope/pkg-a/deep/thing', '@scope/pkg-*', 'subpath'],
  ['@scope/pkg-legacy', '@scope/pkg-*', 'exact'],
];
/** `forbiddenMatch: 'exact'` — no subpath row on any surface; the wildcard's exact hit stays. */
const EXACT_ROWS: Row[] = [['@scope/pkg-legacy', '@scope/pkg-*', 'exact']];

const tool = (name: string) => {
  const t = ALL_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`MCP tool ${name} is not registered`);
  return t;
};

interface ISurface {
  code: number;
  rows: Row[];
}

/** Every enforcing surface over one fixture: the exit it settles on and the [specifier, pattern, matchKind] rows it reports. */
async function enforcingSurfaces(root: string): Promise<{ surfaces: Record<string, ISurface>; deadUnits: unknown[] }> {
  const surfaces: Record<string, ISurface> = {};

  const full = await run(checkCommand, args(root, ['boundaries'], { json: true }));
  const fullJson = JSON.parse(full.out) as { violations: IViolationLike[]; deadUnits: unknown[]; gate: { exit: number } };
  expect(fullJson.gate.exit).toBe(full.code);
  surfaces['check boundaries'] = { code: full.code, rows: rowsOf(fullJson.violations) };

  const changed = await run(checkCommand, args(root, ['boundaries'], { 'changed-only': true, json: true }));
  const changedJson = JSON.parse(changed.out) as { violations: IViolationLike[]; changedScope: { changedFiles: string[] } };
  expect(changedJson.changedScope.changedFiles).toEqual(['packages/app/src/x.ts']);
  surfaces['check boundaries --changed-only'] = { code: changed.code, rows: rowsOf(changedJson.violations) };

  const diff = await run(diffCheckCommand, args(root, [], { json: true }));
  const diffJson = JSON.parse(diff.out) as { boundaries: { violations: IViolationLike[] } };
  surfaces['diff-check'] = { code: diff.code, rows: rowsOf(diffJson.boundaries.violations) };

  const finish = await run(finishCommand, args(root, [], { json: true }));
  const finishJson = JSON.parse(finish.out) as { gates: { name: string; items: { message: string }[] }[] };
  const gate = finishJson.gates.find((g) => g.name === 'boundaries')!;
  surfaces['finish'] = { code: finish.code, rows: gate.items.map((i) => rowOfFinishMessage(i.message)) };

  const inspection = await inspectSharkcraft({ cwd: root });
  const ctx = { inspection, cwd: root };
  const cb = (await tool('check_boundaries').handler({}, ctx)).data as { exitCode: number; violations: IViolationLike[]; deadUnits: unknown[] };
  surfaces['mcp check_boundaries'] = { code: cb.exitCode, rows: rowsOf(cb.violations) };
  const cbr = (await tool('get_changed_boundary_report').handler({}, ctx)).data as {
    typescript: { exitCode: number; included: IViolationLike[] };
  };
  surfaces['mcp get_changed_boundary_report'] = { code: cbr.typescript.exitCode, rows: rowsOf(cbr.typescript.included) };
  const dcr = (await tool('get_diff_check_report').handler({}, ctx)).data as {
    exitCode: number;
    boundaries: { violations: IViolationLike[] };
  };
  surfaces['mcp get_diff_check_report'] = { code: dcr.exitCode, rows: rowsOf(dcr.boundaries.violations) };

  // The CLI and MCP read ONE orchestrator, so their dead units agree too.
  expect(cb.deadUnits).toEqual(fullJson.deadUnits);
  return { surfaces, deadUnits: fullJson.deadUnits };
}

/** Every describing surface: the effective forbiddenMatch + severity each reports, and where the rule came from. */
async function describingSurfaces(root: string): Promise<Record<string, unknown>> {
  const explain = JSON.parse((await run(boundariesExplainCommand, args(root, [RULE_ID], { json: true }))).out) as {
    forbiddenMatch: string;
    severity: string;
    origin: string;
  };
  const inspection = await inspectSharkcraft({ cwd: root });
  const ctx = { inspection, cwd: root };
  const got = (await tool('get_boundary_rule').handler({ id: RULE_ID }, ctx)).data as {
    forbiddenMatch: string;
    severity: string;
    source: { type: string } | null;
  };
  const listed = ((await tool('list_boundary_rules').handler({ format: 'json' }, ctx)).data as {
    id: string;
    forbiddenMatch: string;
    severity: string;
    source: { type: string } | null;
  }[]).find((r) => r.id === RULE_ID)!;
  return {
    'boundaries explain': [explain.forbiddenMatch, explain.severity, explain.origin],
    'mcp get_boundary_rule': [got.forbiddenMatch, got.severity, got.source?.type],
    'mcp list_boundary_rules': [listed.forbiddenMatch, listed.severity, listed.source?.type],
  };
}

const EVERY_ENFORCING_SURFACE = [
  'check boundaries',
  'check boundaries --changed-only',
  'diff-check',
  'finish',
  'mcp check_boundaries',
  'mcp get_changed_boundary_report',
  'mcp get_diff_check_report',
];

for (const origin of ['local', 'pack'] as const) {
  describe(`the consumer's bare patterns, ${origin === 'local' ? 'in sharkcraft/boundaries.ts' : `contributed by ${PACK}`}`, () => {
    test(
      'every enforcing surface reports both subpath edges (matchKind subpath) and exits 1 — the segment-boundary control is never flagged',
      async () => {
        const { surfaces, deadUnits } = await enforcingSurfaces(project(origin));
        expect(Object.keys(surfaces)).toEqual(EVERY_ENFORCING_SURFACE);
        for (const [surface, r] of Object.entries(surfaces)) {
          expect({ surface, code: r.code, rows: r.rows }).toEqual({ surface, code: 1, rows: PACKAGE_ROWS });
        }
        expect(deadUnits).toEqual([]);
      },
      SLOW,
    );

    test(
      "every describing surface reports the effective forbiddenMatch 'package' and severity 'error' for the unset fields",
      async () => {
        const described = await describingSurfaces(project(origin));
        const origins = origin === 'local' ? ['local', 'local'] : [`pack: ${PACK}`, 'pack'];
        expect(described).toEqual({
          'boundaries explain': ['package', 'error', origins[0]],
          'mcp get_boundary_rule': ['package', 'error', origins[1]],
          'mcp list_boundary_rules': ['package', 'error', origins[1]],
        });
      },
      SLOW,
    );

    test(
      "forbiddenMatch 'exact': no surface reports a subpath edge, and the bare pattern's dead unit names the subpath imports it excludes",
      async () => {
        const root = project(origin, ", forbiddenMatch: 'exact'");
        const { surfaces, deadUnits } = await enforcingSurfaces(root);
        for (const [surface, r] of Object.entries(surfaces)) {
          expect({ surface, code: r.code, rows: r.rows }).toEqual({ surface, code: 1, rows: EXACT_ROWS });
        }
        expect((deadUnits as { selector: string; reason: string }[]).map((d) => [d.selector, d.reason.includes("1 subpath import(s) of it exist; forbiddenMatch: 'exact' excludes them")])).toEqual([
          ['@scope/pkg', true],
        ]);
        const described = await describingSurfaces(root);
        for (const row of Object.values(described)) expect((row as unknown[]).slice(0, 2)).toEqual(['exact', 'error']);
      },
      SLOW,
    );
  });
}
