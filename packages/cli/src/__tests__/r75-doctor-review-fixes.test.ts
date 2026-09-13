/**
 * r75 — the doctor lane's review fixes (round 11, command authority).
 *
 *  1. `shrk quality` reported a CORRECT agent test as FAILED while `shrk test
 *     agent` passed it: the aggregate warmed the reference registry without
 *     the command resolver, and counted `not-verified` as `failed`.
 *  2. A bare `command` reference (`frobnicate`) was `ok` in knowledge-stale,
 *     `not-shrk` in the self-config doctor and `unknown-verb` in the agent-test
 *     runner — one resolver, three readings. It is now read ONE way.
 *  3. `shrk test agent|context --id <typo>` and an empty test set exited 0.
 *  4. `commands doctor`'s `undeclared-internal-subverb` error could not fire on
 *     the production registry and had no test.
 *  5. Tokenizer: a `$ ` prompt on a later segment hid a dead verb, and
 *     `shrk@<version>` was not recognised.
 *  6. Clean lines overclaimed (`OK ✓` over 78 warnings; "every probe resolved"
 *     counting not-shrk strings).
 *
 * Real registries only: the CLI spawned from source against mkdtemp
 * workspaces, the production command registry, or a real CommandRegistry.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildQualityReport, CommandResolutionStatus, inspectSharkcraft } from '@shrkcrft/inspector';
import { buildRegistry } from '../main.ts';
import { CommandRegistry, type ParsedArgs } from '../command-registry.ts';
import { COMMAND_CATALOG, SafetyLevel, type ICommandCatalogEntry } from '../commands/command-catalog.ts';
import { buildCommandsDoctorReport, makeCommandsCommand } from '../commands/commands.command.ts';
import { PositionalMode } from '../dispatch/positional-mode.ts';
import { runQuality } from '../quality/run-quality.ts';
import { buildCommandIndex, setActiveCommandRegistry } from '../surface/command-index.ts';
import { resolveCommandString } from '../surface/resolve-command-string.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const SPAWN_TIMEOUT_MS = 180_000;

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function shrk(cwd: string, argv: readonly string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('bun', ['run', CLI_MAIN, ...argv], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function workspace(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-doctor-review-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
  const all: Record<string, string> = {
    'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'fx', knowledgeFiles: ['knowledge.ts'] };\n`,
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

function agentTests(tests: readonly { id: string; expectedCommands: readonly string[] }[]): string {
  return `export default ${JSON.stringify(
    tests.map((t) => ({ id: t.id, task: 'check workspace health', expectedCommands: t.expectedCommands })),
    null,
    2,
  )};\n`;
}

function captureStdout(fn: () => Promise<number> | number): Promise<{ code: number; out: string }> {
  const orig = process.stdout.write.bind(process.stdout);
  let out = '';
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    out += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  return Promise.resolve()
    .then(fn)
    .then((code) => ({ code, out }))
    .finally(() => {
      process.stdout.write = orig;
    });
}

interface IAgentJson {
  exitCode: number;
  verdict: string;
  results: { id: string; verdict: string; missingCommands: string[] }[];
}
interface IQualityJson {
  items: { id: string; status: string; notes: string[] }[];
}

/** The status `quality` must give the agent-tests gate for a `test agent` verdict. */
const QUALITY_STATUS_FOR: Readonly<Record<string, string>> = {
  pass: 'passed',
  fail: 'failed',
  'not-verified': 'skipped',
};

// ── 1. quality ≡ test agent ────────────────────────────────────────────────

describe('#1 quality reports the agent-tests gate with the verdict `shrk test agent` gives', () => {
  for (const [label, expected, verdict, exit] of [
    ['a correct expectedCommands entry', ['shrk doctor'], 'pass', 0],
    ['a dead expectedCommands entry', ['shrk frobnicate'], 'fail', 1],
  ] as const) {
    test(
      `${label}: test agent → ${verdict}, quality agent-tests → ${QUALITY_STATUS_FOR[verdict]}`,
      () => {
        const root = workspace({ 'sharkcraft/agent-tests.ts': agentTests([{ id: 'at.cmd', expectedCommands: expected }]) });
        const verb = shrk(root, ['test', 'agent', '--json']);
        const vj = JSON.parse(verb.stdout) as IAgentJson;
        expect(vj.results.map((r) => r.verdict)).toEqual([verdict]);
        expect(verb.status).toBe(exit);
        expect(vj.exitCode).toBe(exit);

        const quality = shrk(root, ['quality', '--json']);
        const item = (JSON.parse(quality.stdout) as IQualityJson).items.find((i) => i.id === 'agent-tests');
        expect(item?.status).toBe(QUALITY_STATUS_FOR[verdict]!);
      },
      SPAWN_TIMEOUT_MS,
    );
  }

  test('in process: runQuality warms WITH the active command index before the bundle runs', async () => {
    const root = workspace({ 'sharkcraft/agent-tests.ts': agentTests([{ id: 'at.cmd', expectedCommands: ['shrk doctor'] }]) });
    const run = async (): Promise<ReturnType<typeof runQuality>> =>
      runQuality({
        inspection: await inspectSharkcraft({ cwd: root }),
        config: {},
        strict: false,
        failFast: false,
        cwd: root,
        excludeDirs: [],
        gateRules: [],
      });
    try {
      setActiveCommandRegistry(buildRegistry());
      const withIndex = await run();
      expect(withIndex.items.find((i) => i.id === 'agent-tests')?.status).toBe('passed');

      // No command index (a direct engine call): NOT VERIFIED — an accidental
      // skip, never `failed` and never `passed`.
      setActiveCommandRegistry(undefined);
      const without = await run();
      const item = without.items.find((i) => i.id === 'agent-tests');
      expect(item?.status).toBe('skipped');
      expect(item?.skippedDeliberately).not.toBe(true);
      expect(item?.notes.join(' ')).toContain('NOT VERIFIED — 1 agent test(s) could not be evaluated');
      expect(without.coverage.unexamined ?? []).toContain('agent-tests');
      expect(without.verdict).not.toBe('pass');
    } finally {
      setActiveCommandRegistry(undefined);
    }
  }, SPAWN_TIMEOUT_MS);

  test('the MCP path (buildQualityReport, no resolver): partial with a NOT VERIFIED note — never counted failed', async () => {
    const root = workspace({ 'sharkcraft/agent-tests.ts': agentTests([{ id: 'at.cmd', expectedCommands: ['shrk doctor'] }]) });
    const report = await buildQualityReport({ inspection: await inspectSharkcraft({ cwd: root }), config: {} });
    const gate = report.gates.find((g) => g.id === 'agent-tests');
    expect(gate?.data).toMatchObject({ total: 1, failed: 0, notVerified: 1, partial: true });
    expect(gate?.notes.join(' ')).toContain('NOT VERIFIED');
    expect(gate?.notes.join(' ')).not.toContain('agent tests failed');
    expect(report.nextRecommendations.join(' ')).toContain('shrk test agent');
  }, SPAWN_TIMEOUT_MS);
});

// ── 2. one reading of a bare command reference ─────────────────────────────

describe('#2 a bare command reference is read ONE way by every consumer', () => {
  const index = buildCommandIndex(buildRegistry());
  const REF = { assumeShrk: true } as const;

  test('the resolver: under assumeShrk a bare head names a shrk verb; known executables stay not-shrk', () => {
    const cases: readonly [string, CommandResolutionStatus][] = [
      ['frobnicate', CommandResolutionStatus.UnknownVerb],
      ['no-such-verb', CommandResolutionStatus.UnknownVerb],
      ['doctor', CommandResolutionStatus.Ok],
      ['check wiring', CommandResolutionStatus.Ok],
      ['rules lst', CommandResolutionStatus.UnknownSubverb],
      // shrk has a `git` group: `git status` must still be the real git.
      ['git status', CommandResolutionStatus.NotShrk],
      ['bun test', CommandResolutionStatus.NotShrk],
      ['tsc -p . --noEmit', CommandResolutionStatus.NotShrk],
      ['shrk doctor', CommandResolutionStatus.Ok],
    ];
    for (const [raw, want] of cases) {
      expect({ raw, status: resolveCommandString(index, raw, {}, REF).status }).toEqual({ raw, status: want });
    }
    expect(resolveCommandString(index, 'frobnicate', {}, REF).reason).toContain('read as `shrk frobnicate`');
    // Free shell text keeps the old reading: a bare word is not ours to judge.
    expect(resolveCommandString(index, 'frobnicate').status).toBe(CommandResolutionStatus.NotShrk);
    expect(resolveCommandString(index, 'pytest -q').status).toBe(CommandResolutionStatus.NotShrk);
  });

  test(
    'via the CLI: knowledge-stale, the self-config doctor and test agent agree on `frobnicate` / `doctor` / `git status`',
    () => {
      const root = workspace({
        'sharkcraft/knowledge.ts': `export const refs = {
  id: 'fx.bare-refs',
  title: 'Bare command references',
  type: 'technical',
  priority: 'medium',
  tags: ['cmd'],
  content: 'Cites bare commands.',
  references: [
    { kind: 'command', command: 'frobnicate' },
    { kind: 'command', command: 'doctor' },
    { kind: 'command', command: 'git status' },
  ],
};
`,
        'sharkcraft/agent-tests.ts': agentTests([
          { id: 'at.bare-ok', expectedCommands: ['doctor'] },
          { id: 'at.bare-dead', expectedCommands: ['frobnicate'] },
          { id: 'at.bare-git', expectedCommands: ['git status'] },
        ]),
      });

      // knowledge stale-check
      const stale = JSON.parse(shrk(root, ['knowledge', 'stale-check', '--json']).stdout) as {
        referenceChecks: { reference: { command?: string }; outcome: string }[];
      };
      const outcome = new Map(stale.referenceChecks.map((c) => [c.reference.command, c.outcome]));
      expect(outcome.get('frobnicate')).toBe('stale');
      expect(outcome.get('doctor')).toBe('ok');
      expect(outcome.get('git status')).toBe('ok');

      // self-config doctor — the two command-REFERENCE sites
      const doctor = JSON.parse(shrk(root, ['self-config', 'doctor', '--json']).stdout) as {
        findings: { code: string; sourceKind: string; targetId: string }[];
      };
      const dead = doctor.findings
        .filter((f) => f.code === 'unknown-command')
        .map((f) => `${f.sourceKind}:${f.targetId}`)
        .sort();
      expect(dead).toEqual(['agent-test:frobnicate', 'knowledge:frobnicate']);

      // test agent
      const agent = JSON.parse(shrk(root, ['test', 'agent', '--json']).stdout) as IAgentJson;
      const verdict = new Map(agent.results.map((r) => [r.id, r.verdict]));
      expect(verdict.get('at.bare-ok')).toBe('pass');
      expect(verdict.get('at.bare-dead')).toBe('fail');
      expect(verdict.get('at.bare-git')).toBe('pass');
    },
    SPAWN_TIMEOUT_MS,
  );
});

// ── 3. test agent / test context: typo'd id, empty set ────────────────────

describe('#3 `test agent|context` never exits 0 over an empty selection', () => {
  test(
    '`--id <typo>` is a usage error (3), naming the configured count and the closest id',
    () => {
      const root = workspace({ 'sharkcraft/agent-tests.ts': agentTests([{ id: 'at.cmd', expectedCommands: ['shrk doctor'] }]) });
      const json = shrk(root, ['test', 'agent', '--id', 'nope', '--json']);
      expect(json.status).toBe(3);
      const parsed = JSON.parse(json.stdout) as { exitCode: number; error: string };
      expect(parsed.exitCode).toBe(3);
      expect(parsed.error).toContain("no agent test with id 'nope' (1 configured)");
      const text = shrk(root, ['test', 'agent', '--id', 'at.cm']);
      expect(text.status).toBe(3);
      expect(text.stderr).toContain("did you mean 'at.cmd'");
      // The same selection rule for context tests (0 configured here).
      const ctx = shrk(root, ['test', 'context', '--id', 'nope', '--json']);
      expect(ctx.status).toBe(3);
      expect((JSON.parse(ctx.stdout) as { exitCode: number }).exitCode).toBe(3);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    'zero tests configured → 2 NOT VERIFIED (text and JSON); --allow-empty → 0 with the acceptance printed',
    () => {
      const root = workspace({});
      for (const kind of ['agent', 'context'] as const) {
        const text = shrk(root, ['test', kind]);
        expect({ kind, status: text.status }).toEqual({ kind, status: 2 });
        expect(text.stdout).toContain('NOT VERIFIED');
        expect(text.stdout).toContain('Pass --allow-empty');
        const json = shrk(root, ['test', kind, '--json']);
        expect(json.status).toBe(2);
        expect(JSON.parse(json.stdout)).toMatchObject({ exitCode: 2, verdict: 'not-verified' });
        const accepted = shrk(root, ['test', kind, '--allow-empty']);
        expect(accepted.status).toBe(0);
        expect(accepted.stdout).toContain('accepted by --allow-empty');
        const acceptedJson = JSON.parse(shrk(root, ['test', kind, '--allow-empty', '--json']).stdout) as {
          exitCode: number;
        };
        expect(acceptedJson.exitCode).toBe(0);
      }
    },
    SPAWN_TIMEOUT_MS,
  );
});

// ── 4. commands doctor: undeclared internal subverb ────────────────────────

describe('#4 `commands doctor` flags a catalog row for a subverb its handler does not declare', () => {
  const row = (command: string): ICommandCatalogEntry => ({
    command,
    description: `The ${command} fixture verb.`,
    category: 'fixture',
    safetyLevel: SafetyLevel.ReadOnly,
    writesFiles: false,
    writesSource: false,
    runsShell: false,
    requiresReview: false,
    mcpAvailable: false,
    aliases: [],
  });
  function widgetRegistry(): CommandRegistry {
    const r = new CommandRegistry();
    r.register({
      name: 'widget',
      description: 'Widgets.',
      usage: 'shrk widget <a>',
      subverbs: [{ name: 'a', description: 'Subverb a.', usage: 'shrk widget a' }],
      positionals: PositionalMode.None,
      run: () => 0,
    });
    return r;
  }
  const doctorArgs = (): ParsedArgs => ({ positional: ['doctor'], flags: new Map() }) as ParsedArgs;

  test('a documented `widget b` under a handler declaring only `a` → error, and the verb exits 1', async () => {
    const registry = widgetRegistry();
    const catalog = [row('widget'), row('widget a'), row('widget b')];
    const report = buildCommandsDoctorReport(registry, catalog);
    expect(report.issues.filter((i) => i.code === 'undeclared-internal-subverb')).toEqual([
      {
        code: 'undeclared-internal-subverb',
        severity: 'error',
        message: 'catalog documents "widget b" but "widget" declares its subverbs and "b" is not one of them',
      },
    ]);
    const res = await captureStdout(() => makeCommandsCommand(registry, catalog).run(doctorArgs()));
    expect(res.code).toBe(1);
    expect(res.out).toContain('undeclared-internal-subverb');
    expect(res.out).toContain('Verdict: CATALOG DRIFT');
    expect(res.out).not.toContain('✓');
  });

  test('the declared subverb alone → no issue at all, and only then the ✓ line', async () => {
    const registry = widgetRegistry();
    const catalog = [row('widget'), row('widget a')];
    const report = buildCommandsDoctorReport(registry, catalog);
    expect(report.issues).toEqual([]);
    expect(report.coverage).toMatchObject({ unit: 'registered command paths', expected: 1, examined: 1 });
    const res = await captureStdout(() => makeCommandsCommand(registry, catalog).run(doctorArgs()));
    expect(res.code).toBe(0);
    expect(res.out).toContain('Verdict: OK ✓');
  });

  test('warnings at exit 0 print "No blocking catalog drift", never OK ✓', async () => {
    const registry = widgetRegistry();
    // `gizmo` is catalogued; its registered `gizmo y` has no catalog row — a
    // `registry-path-not-in-catalog` WARNING and nothing else.
    registry.register({ name: 'gizmo', description: 'Gizmos.', usage: 'shrk gizmo', run: () => 0 });
    registry.registerSubcommand('gizmo', { name: 'y', description: 'Y.', usage: 'shrk gizmo y', run: () => 0 });
    const catalog = [row('widget'), row('widget a'), row('gizmo')];
    const report = buildCommandsDoctorReport(registry, catalog);
    expect(report.issues.map((i) => [i.code, i.severity])).toEqual([['registry-path-not-in-catalog', 'warning']]);
    const res = await captureStdout(() => makeCommandsCommand(registry, catalog).run(doctorArgs()));
    expect(res.code).toBe(0);
    expect(res.out).toContain('No blocking catalog drift — 1 warning(s) reported above.');
    expect(res.out).not.toContain('✓');
  });

  test('the production registry: the default catalog is COMMAND_CATALOG, and every registered path reached the index', () => {
    const registry = buildRegistry();
    const report = buildCommandsDoctorReport(registry);
    expect(report.summary.catalogEntries).toBe(COMMAND_CATALOG.length);
    expect(report.coverage.examined).toBe(report.coverage.expected);
    expect(report.coverage.expected).toBe(registry.listAll().length);
  });
});

// ── 5. tokenizer ───────────────────────────────────────────────────────────

describe('#5 the tokenizer: a prompt on ANY segment, and a versioned shrk', () => {
  const index = buildCommandIndex(buildRegistry());
  test('`$ ` on a later segment no longer hides a dead verb', () => {
    expect(resolveCommandString(index, '$ shrk doctor && $ shrk frobnicate').status).toBe(
      CommandResolutionStatus.UnknownVerb,
    );
    expect(resolveCommandString(index, '$ shrk doctor && $ shrk check wiring').status).toBe(
      CommandResolutionStatus.Ok,
    );
  });
  test('`shrk@<version>` is the shrk binary', () => {
    expect(resolveCommandString(index, 'npx shrk@latest doctor').status).toBe(CommandResolutionStatus.Ok);
    expect(resolveCommandString(index, 'bunx shrk@0.1.0-alpha.31 frobnicate').status).toBe(
      CommandResolutionStatus.UnknownVerb,
    );
  });
});

// ── 6. self-config clean line ──────────────────────────────────────────────

describe('#6 self-config: not-shrk strings are narrowed out, and the clean line says what it did not prove', () => {
  test(
    'coverage expects probed − notShrk; the exit-0 sentence names the unchecked strings',
    () => {
      const root = workspace({
        'sharkcraft/task-routing-hints.ts': `export default [
  { id: 'h.ok', title: 'Hint', match: { keywords: ['cmds'] }, recommends: { commands: ['shrk doctor', 'git status'] } },
];
`,
      });
      const json = JSON.parse(shrk(root, ['self-config', 'doctor', '--json']).stdout) as {
        exitCode: number;
        coverage: { unit: string; expected: number; examined: number }[];
        probes: { command: { probed: number; notShrk: number; prefixOnly: number; unknown: number } };
      };
      const c = json.probes.command;
      expect(c.unknown).toBe(0);
      expect(c.notShrk).toBeGreaterThan(0);
      const cov = json.coverage.find((x) => x.unit === 'command strings');
      expect(cov?.expected).toBe(c.probed - c.notShrk);
      expect(cov?.examined).toBe(cov?.expected);
      const text = shrk(root, ['self-config', 'doctor']);
      expect(text.status).toBe(json.exitCode);
      if (text.status === 0) {
        expect(text.stdout).toContain(`${c.notShrk} non-shrk command string(s) not checked`);
        expect(text.stdout).not.toContain('every probe resolved');
      }
    },
    SPAWN_TIMEOUT_MS,
  );
});
