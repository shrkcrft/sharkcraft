/**
 * r77 — the pre-emptive boundary fence, end to end (round 13, spec 13.1;
 * DESIGN-D1 tests item 5). The CLI runs FROM SOURCE on the facts-V1 fxB shape:
 * `packages/app` imports only `@scope/util`; the rule forbids `@scope/kernel-*`
 * (live through the `@scope/kernel-a` workspace package), the planned
 * `@scope/plugin-react` and the layer root `@scope/kernel`.
 *
 *   - markers → exit 0, the `accepted by expectEmpty` line printed, no dead
 *     unit, and `--fail-on-dead-units` / `--strict` stay 0;
 *   - the planned package appears (a package name, or a dependency) → went
 *     live: exit 0, no ✓, the stale-marker line; `--fail-on-dead-units` 1,
 *     `--strict` 1 — and a PACK marker that went live is INFO, never 1;
 *   - a planned `from` glob 2 → 0, a rule ahead of its only directory 1 → 0;
 *   - `--diff-against` has the gate's parity: an unreadable governed file is
 *     never a pass there either, and a marked candidate is accepted;
 *   - the one causes sentence (`DEAD_SELECTOR_CAUSES`) in text, JSON and MCP;
 *   - the lane-B surfaces: `shrk explain <boundary rule id>`, the explain
 *     'intended empty' line, quality and finish advisory notes, the dashboard.
 *
 * Real temp workspaces, the real loaders, a real pack under node_modules.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DEAD_SELECTOR_CAUSES } from '@shrkcrft/core';
import { buildDashboardBoundaries, inspectSharkcraft } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '@shrkcrft/mcp-server';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const CLI_MAIN = join(REPO_ROOT, 'packages', 'cli', 'src', 'main.ts');
const SLOW = 60_000;
const CANNOT_CHMOD = process.platform === 'win32' || process.getuid?.() === 0;

const roots: string[] = [];
const locked: string[] = [];
afterAll(() => {
  for (const f of locked) {
    try {
      chmodSync(f, 0o644);
    } catch {
      // already gone
    }
  }
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function workspace(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r77-fence-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

/** Run the CLI FROM SOURCE (the global `shrk` is stale). */
function runCli(root: string, argv: readonly string[]): { readonly code: number; readonly out: string; readonly err: string } {
  const r = spawnSync('bun', [CLI_MAIN, '--cwd', root, ...argv], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

const json = (root: string, argv: readonly string[]): Record<string, unknown> & { exitCode: number } => {
  const r = runCli(root, [...argv, '--json']);
  try {
    return JSON.parse(r.out) as Record<string, unknown> & { exitCode: number };
  } catch {
    throw new Error(`not JSON (exit ${r.code}): ${r.out.slice(0, 400)} ${r.err.slice(0, 400)}`);
  }
};

const RULE = 'layer.no-imports-up';
const UNMARKED = `export default [{ id: '${RULE}', title: 'No imports up', from: ['packages/app/**'],
  forbiddenImports: ['@scope/kernel-*', '@scope/plugin-react', '@scope/kernel'] }];\n`;
const MARKED = `export default [{ id: '${RULE}', title: 'No imports up', from: ['packages/app/**'],
  forbiddenImports: ['@scope/kernel-*', { pattern: '@scope/plugin-react', expectEmpty: true, reason: 'ADR-7: planned binding' }, { pattern: '@scope/kernel', expectEmpty: true }] }];\n`;
const PLUGIN_REACT = { 'packages/plugin-react/package.json': JSON.stringify({ name: '@scope/plugin-react', version: '0.0.0' }) };

/** The workspace packages every fixture carries (fxB). */
function packages(appImport = '@scope/util'): Record<string, string> {
  return {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0', private: true }),
    'packages/app/package.json': JSON.stringify({ name: '@scope/app', version: '0.0.0' }),
    'packages/app/src/x.ts': `import { u } from '${appImport}';\nexport const x = u;\n`,
    'packages/kernel-a/package.json': JSON.stringify({ name: '@scope/kernel-a', version: '0.0.0' }),
    'packages/kernel-a/src/index.ts': 'export const k = 1;\n',
    'packages/util/package.json': JSON.stringify({ name: '@scope/util', version: '0.0.0' }),
    'packages/util/src/index.ts': 'export const u = 1;\n',
  };
}

function fxB(rules: string, extra: Readonly<Record<string, string>> = {}): string {
  return workspace({
    ...packages(),
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx', boundaryFiles: ['boundaries.ts'] };\n",
    'sharkcraft/boundaries.ts': rules,
    ...extra,
  });
}

const tool = (name: string) => {
  const t = ALL_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`MCP tool ${name} is not registered`);
  return t;
};

interface IUnitRow {
  readonly ruleId: string;
  readonly unit: string;
  readonly selector: string;
  readonly state: string;
  readonly reason: string;
  readonly markReason?: string;
  readonly packageName?: string;
}

describe('the planned fence: markers → exit 0 and a printed acceptance', () => {
  test(
    'exit 0, the accepted line, no dead unit — and --fail-on-dead-units / --strict stay 0',
    () => {
      const root = fxB(MARKED);
      const text = runCli(root, ['check', 'boundaries']);
      expect(text.code).toBe(0);
      expect(text.out).toContain('Verdict: OK — no boundary violations. ✓');
      expect(text.out).toContain(`${RULE}: accepted by expectEmpty: examined 0 of 2 selector units, 2 asserted empty`);
      expect(text.out).toContain('@scope/plugin-react, @scope/kernel');
      expect(text.out).not.toContain('Dead selector units');
      const j = json(root, ['check', 'boundaries']);
      expect(j.exitCode).toBe(0);
      expect(j['deadUnits']).toEqual([]);
      const planned = j['intendedEmpty'] as readonly IUnitRow[];
      expect(planned.map((u) => u.selector).sort()).toEqual(['@scope/kernel', '@scope/plugin-react']);
      expect(planned.find((u) => u.selector === '@scope/plugin-react')?.markReason).toBe('ADR-7: planned binding');
      const gate = j['gate'] as { accepted: readonly string[]; rules: readonly { units?: { intendedEmpty: readonly string[] } }[] };
      expect(gate.accepted.join('\n')).toContain('accepted by expectEmpty');
      expect(j['accepted']).toEqual(gate.accepted);
      expect(gate.rules[0]?.units?.intendedEmpty).toHaveLength(2);
      const coverage = j['coverage'] as readonly { forbidden: readonly { pattern: string; state?: string }[] }[];
      expect(coverage[0]!.forbidden.map((f) => [f.pattern, f.state])).toEqual([
        ['@scope/kernel-*', 'live'],
        ['@scope/plugin-react', 'intended-empty'],
        ['@scope/kernel', 'intended-empty'],
      ]);
      expect(runCli(root, ['check', 'boundaries', '--fail-on-dead-units']).code).toBe(0);
      expect(runCli(root, ['check', 'boundaries', '--strict']).code).toBe(0);
    },
    SLOW,
  );

  test(
    'unmarked, the same fence is dead — worded by DEAD_SELECTOR_CAUSES in text, JSON and MCP; the flag makes it 1',
    async () => {
      const root = fxB(UNMARKED);
      const text = runCli(root, ['check', 'boundaries']);
      expect(text.code).toBe(0);
      expect(text.out).toContain(
        `• [forbidden] ${RULE}: @scope/plugin-react — matches no import anywhere in the repo, no workspace/dependency package name, no tsconfig alias and no file — ${DEAD_SELECTOR_CAUSES}`,
      );
      expect(text.out).not.toContain('typo or retired target');
      expect(text.out).toContain(
        'Verdict: no boundary violations — 2 dead selector unit(s) reported above (--fail-on-dead-units to fail on dead units).',
      );
      const j = json(root, ['check', 'boundaries']);
      const dead = j['deadUnits'] as readonly { selector: string; reason: string }[];
      expect(dead.map((d) => d.selector)).toEqual(['@scope/plugin-react', '@scope/kernel']);
      for (const d of dead) expect(d.reason.endsWith(` — ${DEAD_SELECTOR_CAUSES}`)).toBe(true);
      const inspection = await inspectSharkcraft({ cwd: root });
      const mcp = (await tool('check_boundaries').handler({}, { inspection, cwd: root } as never)).data as { deadUnits: unknown };
      expect(mcp.deadUnits).toEqual(dead);
      const failing = runCli(root, ['check', 'boundaries', '--fail-on-dead-units']);
      expect(failing.code).toBe(1);
      // V1-U6: zero violations — the CHECK needs attention, not "violations".
      expect(failing.out).toContain('Verdict: boundary check needs attention — 2 dead unit(s) (--fail-on-dead-units)');
    },
    SLOW,
  );
});

describe('the fence went live: reported as drift, never silently accepted', () => {
  test(
    'the planned package appears: exit 0, no ✓, the stale-marker line; --fail-on-dead-units 1; --strict 1',
    () => {
      const root = fxB(MARKED, PLUGIN_REACT);
      const text = runCli(root, ['check', 'boundaries']);
      expect(text.code).toBe(0);
      expect(text.out).not.toContain('✓');
      expect(text.out).toContain('expectEmpty markers that went live (1)');
      expect(text.out).toContain(
        `• [forbidden] ${RULE}: @scope/plugin-react — expectEmpty is stale: no import yet, but '@scope/plugin-react' is a known package`,
      );
      expect(text.out).toContain('the fence went live; remove expectEmpty');
      expect(text.out).toContain(
        'Verdict: no boundary violations — 1 expectEmpty unit(s) went live (remove each stale expectEmpty marker).',
      );
      // The layer root is still planned — its acceptance still prints.
      expect(text.out).toContain(`${RULE}: accepted by expectEmpty: examined 0 of 1 selector units`);
      const j = json(root, ['check', 'boundaries']);
      expect((j['wentLive'] as readonly IUnitRow[]).map((u) => [u.selector, u.state])).toEqual([['@scope/plugin-react', 'went-live']]);
      expect((j['intendedEmpty'] as readonly IUnitRow[]).map((u) => u.selector)).toEqual(['@scope/kernel']);

      const flagged = runCli(root, ['check', 'boundaries', '--fail-on-dead-units']);
      expect(flagged.code).toBe(1);
      expect(flagged.out).toContain('Verdict: boundary check needs attention — 1 went-live expectEmpty unit(s) (--fail-on-dead-units)');
      const strict = runCli(root, ['check', 'boundaries', '--strict']);
      expect(strict.code).toBe(1);
      expect(strict.out).toContain('1 went-live expectEmpty unit(s) (--strict)');
    },
    SLOW,
  );

  test(
    'a dependency declaration alone makes the planned target real: went live',
    () => {
      const root = workspace({
        ...packages(),
        'package.json': JSON.stringify({ name: 'fx', version: '0.0.0', optionalDependencies: { '@scope/plugin-react': '1.0.0' } }),
        'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx', boundaryFiles: ['boundaries.ts'] };\n",
        'sharkcraft/boundaries.ts': MARKED,
      });
      const j = json(root, ['check', 'boundaries']);
      expect(j.exitCode).toBe(0);
      expect((j['wentLive'] as readonly IUnitRow[]).map((u) => u.selector)).toEqual(['@scope/plugin-react']);
    },
    SLOW,
  );

  test(
    'a PACK marker that went live is INFO and never fails — not under --fail-on-dead-units, not under --strict',
    () => {
      const PACK = '@r77/fence-pack';
      const root = workspace({
        ...packages(),
        ...PLUGIN_REACT,
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
        [`node_modules/${PACK}/boundaries.ts`]: MARKED.replace(RULE, 'pack.no-imports-up'),
      });
      const text = runCli(root, ['check', 'boundaries', '--fail-on-dead-units']);
      expect(text.code).toBe(0);
      expect(text.out).toContain(`[marker from pack ${PACK}: reported as INFO, never fails]`);
      // Round 13 review — INFO in its own block, never the consumer's to
      // remove, and the ✓ is kept: the `gates coverage` / asset-doctor answer.
      expect(text.out).toContain('INFO — pack expectEmpty markers that went live (1)');
      expect(text.out).not.toContain('expectEmpty markers that went live (1) — each fence now has a target; remove the marker');
      expect(text.out).not.toContain('remove each stale expectEmpty marker');
      expect(text.out).toContain('Verdict: OK — no boundary violations. ✓');
      expect(runCli(root, ['check', 'boundaries', '--strict']).code).toBe(0);
      const j = json(root, ['check', 'boundaries', '--fail-on-dead-units']);
      expect((j['wentLive'] as readonly IUnitRow[]).map((u) => [u.selector, u.packageName])).toEqual([['@scope/plugin-react', PACK]]);
      expect(j['failingUnits']).toEqual([]);
    },
    SLOW,
  );
});

describe('a planned from glob, and a rule ahead of its only directory', () => {
  test(
    'a planned from glob: 2 → 0 when marked; a rule whose only from glob is planned: 1 → 0 when marked',
    () => {
      const cand = (id: string, from: string) =>
        `export default [{ id: '${id}', title: '${id}', from: ${from}, forbiddenImports: ['@scope/kernel-*'] }];\n`;
      const root = fxB(UNMARKED, {
        'cand/planned-unmarked.ts': cand('scope.planned', "['packages/app/**', 'packages/plugin-react/**']"),
        'cand/planned.ts': cand('scope.planned', "['packages/app/**', { pattern: 'packages/plugin-react/**', expectEmpty: true }]"),
        'cand/future-unmarked.ts': cand('future.fence', "['packages/plugin-react/**']"),
        'cand/future.ts': cand('future.fence', "[{ pattern: 'packages/plugin-react/**', expectEmpty: true }]"),
      });
      expect(runCli(root, ['check', 'boundaries', '--rule-file', 'cand/planned-unmarked.ts']).code).toBe(2);
      const planned = runCli(root, ['check', 'boundaries', '--rule-file', 'cand/planned.ts']);
      expect(planned.code).toBe(0);
      expect(planned.out).toContain('scope.planned: accepted by expectEmpty: examined 0 of 1 selector units');
      expect(planned.out).toContain('packages/plugin-react/**');
      expect(runCli(root, ['check', 'boundaries', '--rule-file', 'cand/future-unmarked.ts']).code).toBe(1);
      const future = runCli(root, ['check', 'boundaries', '--rule-file', 'cand/future.ts']);
      expect(future.code).toBe(0);
      expect(future.out).toContain('future.fence: accepted by expectEmpty: examined 0 of 1 selector units');
      // K6: the rule whose only `from` glob is planned examined 0 files — ACCEPTED,
      // never evaluated, on BOTH counts: THE inspector's (`rulesEvaluated` /
      // `rulesAcceptedEmpty`) and the envelope's predicate (`gate.evaluated` /
      // `gate.acceptedEmpty`). The partially planned rule examined its live glob.
      type ICounts = { rulesEvaluated: number; rulesAcceptedEmpty: number; gate: { evaluated: number; acceptedEmpty?: number } };
      const futureJson = json(root, ['check', 'boundaries', '--rule-file', 'cand/future.ts']) as unknown as ICounts & { exitCode: number };
      expect(futureJson.exitCode).toBe(0);
      expect([futureJson.rulesEvaluated, futureJson.rulesAcceptedEmpty]).toEqual([0, 1]);
      expect([futureJson.gate.evaluated, futureJson.gate.acceptedEmpty]).toEqual([0, 1]);
      const plannedJson = json(root, ['check', 'boundaries', '--rule-file', 'cand/planned.ts']) as unknown as ICounts;
      expect([plannedJson.rulesEvaluated, plannedJson.rulesAcceptedEmpty, plannedJson.gate.evaluated]).toEqual([1, 0, 1]);
      expect('acceptedEmpty' in plannedJson.gate).toBe(false);
    },
    SLOW,
  );
});

describe('--diff-against: the gate’s parity (P2)', () => {
  test(
    'a marked candidate is accepted on the authoring path too; a went-live candidate marker fails under the flag',
    () => {
      const root = fxB(UNMARKED, { 'cand.ts': MARKED });
      const j = json(root, ['check', 'boundaries', '--diff-against', 'cand.ts']);
      expect(j.exitCode).toBe(0);
      expect((j['gate'] as { accepted: readonly string[] }).accepted.join('\n')).toContain('accepted by expectEmpty');
      expect((j['intendedEmpty'] as readonly unknown[]).length).toBe(2);
      const live = fxB(UNMARKED, { 'cand.ts': MARKED, ...PLUGIN_REACT });
      const text = runCli(live, ['check', 'boundaries', '--diff-against', 'cand.ts']);
      expect(text.code).toBe(0);
      expect(text.out).toContain('• went live [forbidden] layer.no-imports-up: @scope/plugin-react — expectEmpty is stale');
      const flagged = runCli(live, ['check', 'boundaries', '--diff-against', 'cand.ts', '--fail-on-dead-units']);
      expect(flagged.code).toBe(1);
      expect(flagged.out).toContain('has 1 went-live expectEmpty unit(s) (--fail-on-dead-units)');
    },
    SLOW,
  );

  test.skipIf(CANNOT_CHMOD)(
    'an unreadable governed file: 2 on BOTH paths, with or without --fail-on-dead-units — and no dead unit it could refute',
    () => {
      const root = fxB(UNMARKED, { 'packages/app/src/locked.ts': 'export const l = 1;\n', 'cand.ts': UNMARKED });
      const lockedFile = join(root, 'packages/app/src/locked.ts');
      chmodSync(lockedFile, 0o000);
      locked.push(lockedFile);
      for (const flags of [[], ['--fail-on-dead-units']] as const) {
        const gate = json(root, ['check', 'boundaries', ...flags]);
        expect(gate.exitCode).toBe(2);
        expect(gate['deadUnits']).toEqual([]);
        // A dead unit the unread file could refute is reported `unproven` in
        // coverage[].unitLiveness — never dropped silently (round 13 review:
        // restoring the old silent drop kept every test green).
        const rows = (
          (gate['coverage'] as readonly { unitLiveness?: readonly { list: string; unit: string; state: string }[] }[])[0]
            ?.unitLiveness ?? []
        ).map((u) => [u.list, u.unit, u.state]);
        expect(rows).toContainEqual(['forbiddenImports', '@scope/plugin-react', 'unproven']);
        expect(rows).toContainEqual(['forbiddenImports', '@scope/kernel', 'unproven']);
        const diff = json(root, ['check', 'boundaries', '--diff-against', 'cand.ts', ...flags]);
        expect(diff.exitCode).toBe(2);
        expect((diff['candidateCoverage'] as readonly { deadUnits: readonly unknown[] }[])[0]!.deadUnits).toEqual([]);
        expect((diff['gate'] as { shortfalls: readonly string[] }).shortfalls.join('\n')).toContain('packages/app/src/locked.ts');
      }
      const text = runCli(root, ['check', 'boundaries', '--diff-against', 'cand.ts']);
      expect(text.code).toBe(2);
      expect(text.out).toContain("NOT VERIFIED — part of a candidate rule's scope could not be read");
      expect(text.out).not.toContain('• dead [forbidden]');
    },
    SLOW,
  );
});

describe('the lane-B surfaces carry the markers', () => {
  test(
    '`shrk explain <boundary rule id>` resolves the rule, with its intended-empty lines',
    () => {
      const root = fxB(MARKED);
      const text = runCli(root, ['explain', RULE]);
      expect(text.code).toBe(0);
      expect(text.out).toContain(`Boundary explain: ${RULE}`);
      expect(text.out).toContain('forbiddenImports @scope/plugin-react — ADR-7: planned binding');
      expect(text.out).toContain('forbiddenImports @scope/kernel — no reason given');
      const explained = json(root, ['boundaries', 'explain', RULE]) as unknown as { expectEmptyUnits: readonly unknown[] };
      expect(explained.expectEmptyUnits).toHaveLength(2);
    },
    SLOW,
  );

  test(
    'quality and finish carry a went-live marker as an ADVISORY note — never a failure, never an item',
    () => {
      const root = fxB(MARKED, { ...PLUGIN_REACT, '.gitignore': '.sharkcraft/\nnode_modules/\n' });
      const quality = runCli(root, ['quality', '--json']);
      expect(quality.out).toContain(
        `advisory: [forbidden] ${RULE}: @scope/plugin-react — expectEmpty is stale`,
      );
      const items = ((JSON.parse(quality.out) as { items?: readonly { id?: string; status?: string }[] }).items ?? []);
      expect(items.find((i) => i.id === 'boundaries')?.status).not.toBe('failed');

      const git = (...a: string[]) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
      git('init', '-q');
      git('add', '-A');
      git('-c', 'user.email=r77@example.com', '-c', 'user.name=r77', 'commit', '-q', '-m', 'init');
      writeFileSync(join(root, 'packages/app/src/x.ts'), "import { u } from '@scope/util';\nexport const x = u + 1;\n");
      const finish = JSON.parse(runCli(root, ['finish', '--json', '--since', 'HEAD']).out) as {
        gates: readonly { name: string; status: string; detail: string; notes?: readonly string[]; items: readonly { message: string }[] }[];
      };
      const gate = finish.gates.find((g) => g.name === 'boundaries')!;
      expect(gate.status).toBe('pass');
      expect(gate.detail).toContain('1 expectEmpty marker(s) went live (advisory)');
      expect((gate.notes ?? []).join('\n')).toContain(`[advisory] [forbidden] ${RULE}: @scope/plugin-react — expectEmpty is stale`);
      expect(gate.items.map((i) => i.message).join('\n')).not.toContain('advisory');
    },
    SLOW,
  );

  test(
    'quality and finish carry UNMARKED dead selector units as ADVISORY notes — never a failure, never an item',
    () => {
      const root = fxB(UNMARKED, { '.gitignore': '.sharkcraft/\nnode_modules/\n' });
      const quality = runCli(root, ['quality', '--json']);
      expect(quality.out).toContain(`advisory: dead selector unit [forbidden] ${RULE}: @scope/plugin-react`);
      const items = ((JSON.parse(quality.out) as { items?: readonly { id?: string; status?: string }[] }).items ?? []);
      expect(items.find((i) => i.id === 'boundaries')?.status).not.toBe('failed');

      const git = (...a: string[]) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
      git('init', '-q');
      git('add', '-A');
      git('-c', 'user.email=r77@example.com', '-c', 'user.name=r77', 'commit', '-q', '-m', 'init');
      writeFileSync(join(root, 'packages/app/src/x.ts'), "import { u } from '@scope/util';\nexport const x = u + 1;\n");
      const finish = JSON.parse(runCli(root, ['finish', '--json', '--since', 'HEAD']).out) as {
        gates: readonly { name: string; status: string; detail: string; notes?: readonly string[]; items: readonly { message: string }[] }[];
      };
      const gate = finish.gates.find((g) => g.name === 'boundaries')!;
      expect(gate.status).toBe('pass');
      expect(gate.detail).toContain('2 dead selector unit(s) (advisory)');
      expect((gate.notes ?? []).join('\n')).toContain(`[advisory] dead selector unit [forbidden] ${RULE}: @scope/plugin-react`);
      expect(gate.items.map((i) => i.message).join('\n')).not.toContain('advisory');
    },
    SLOW,
  );

  test(
    'the dashboard boundary panel shows the settled verdict — never a hard-coded "No active violations."',
    async () => {
      const marked = buildDashboardBoundaries(await inspectSharkcraft({ cwd: fxB(MARKED) }));
      expect(marked.verdict).toBe('pass');
      expect(marked.summary).toContain('No active violations — 1 rule(s) checked.');
      expect(marked.summary).toContain('2 expectEmpty unit(s) accepted');
      const violated = buildDashboardBoundaries(
        await inspectSharkcraft({
          cwd: workspace({
            ...packages('@scope/kernel-a'),
            'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx', boundaryFiles: ['boundaries.ts'] };\n",
            'sharkcraft/boundaries.ts': UNMARKED,
          }),
        }),
      );
      expect(violated.violations.map((v) => [v.rule, v.to])).toEqual([[RULE, '@scope/kernel-a']]);
      expect(violated.exitCode).toBe(1);
      expect(violated.summary).toContain('Boundary check needs attention — 1 violation(s)');
    },
    SLOW,
  );
});

describe('a malformed pack marker reads the same on every surface', () => {
  test(
    'a rule-level expectEmpty in a pack: an errored rule on check boundaries and a rejected entry on packs test --load — one reason',
    () => {
      const PACK = '@r77/bad-fence';
      const root = workspace({
        ...packages(),
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
        [`node_modules/${PACK}/boundaries.ts`]:
          "export default [{ id: 'pack.bad', title: 'bad', from: ['packages/app/**'], forbiddenImports: ['@scope/kernel-*'], expectEmpty: true }];\n",
      });
      const reason = 'expectEmpty: expectEmpty is per pattern on a boundary rule: forbiddenImports: [{ pattern, expectEmpty: true }]';
      const check = runCli(root, ['check', 'boundaries']);
      expect(check.code).toBe(1);
      expect(check.out).toContain(reason);
      const load = runCli(root, ['packs', 'test', join(root, 'node_modules', PACK), '--load']);
      expect(load.code).toBe(1);
      expect(`${load.out}${load.err}`).toContain(reason);
    },
    SLOW,
  );
});

describe('an acceptance is never silent on the surfaces that settle a boundary run (round 13 review)', () => {
  // A planned `from` glob beside a live one, and a planned forbidden pattern:
  // the boundary run settles 0 WITH an acceptance. `check boundaries` printed
  // it; quality, finish, drift and `architecture violations` settled the same
  // records (2 → 0 for the planned glob) and printed nothing.
  const PLANNED = `export default [{ id: 'scope.planned', title: 'p', from: ['packages/app/**', { pattern: 'packages/plugin-react/**', expectEmpty: true }],
  forbiddenImports: ['@scope/kernel-*', { pattern: '@scope/plugin-react', expectEmpty: true }] }];\n`;
  const LINE = 'scope.planned: accepted by expectEmpty: examined 0 of 2 selector units, 2 asserted empty';

  test(
    'quality notes, finish notes + detail, and the drift / architecture verdict lines carry the settled acceptance',
    () => {
      const root = fxB(PLANNED);
      const gate = runCli(root, ['check', 'boundaries']);
      expect(gate.code).toBe(0);
      expect(gate.out).toContain(LINE);

      const quality = JSON.parse(runCli(root, ['quality', '--json']).out) as {
        items?: readonly { id?: string; status?: string; notes?: readonly string[] }[];
      };
      const qItem = (quality.items ?? []).find((i) => i.id === 'boundaries');
      expect(qItem?.status).toBe('passed');
      expect((qItem?.notes ?? []).join('\n')).toContain(`accepted: ${LINE}`);

      // Finish settles each rule's acceptance as its own envelope row
      // (`extraCoverage`), so its ONE settle prints it — `gate.accepted` and
      // the text verdict — at exit 0.
      const finish = JSON.parse(runCli(root, ['finish', '--files', 'packages/app/src/x.ts', '--json']).out) as {
        exit: number;
        gates: readonly { name: string; status: string; detail: string }[];
        gate: { accepted: readonly string[] };
      };
      const fGate = finish.gates.find((g) => g.name === 'boundaries')!;
      expect(fGate.status).toBe('pass');
      expect(fGate.detail).toContain('2 expectEmpty unit(s) intended empty');
      expect(finish.exit).toBe(0);
      expect(finish.gate.accepted.join('\n')).toContain(LINE);
      const finishText = runCli(root, ['finish', '--files', 'packages/app/src/x.ts']);
      expect(finishText.code).toBe(0);
      expect(finishText.out).toContain(LINE);

      const drift = runCli(root, ['drift']);
      expect(drift.code).toBe(0);
      expect(drift.out).toContain(LINE);
      const driftJson = json(root, ['drift']) as unknown as { accepted?: readonly string[] };
      expect((driftJson.accepted ?? []).join('\n')).toContain(LINE);

      const arch = runCli(root, ['architecture', 'violations']);
      expect(arch.code).toBe(0);
      expect(arch.out).toContain(LINE);
    },
    SLOW,
  );
});
