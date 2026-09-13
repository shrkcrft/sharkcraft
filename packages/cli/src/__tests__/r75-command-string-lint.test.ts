/**
 * r75 — ONE command-string resolver (spec 4.5#1, 3.5#1).
 *
 * The structured `command` reference kind used to accept ANY `shrk …` string
 * (`id.startsWith('shrk ')`), so `shrk knowledge stale-check` certified three
 * dead commands in shrk's own knowledge as "Command available", while the
 * self-config doctor and the agent-test runner checked against an EMPTY set and
 * reported every correct command missing. One resolver over THE command index
 * now answers for all of them — injected into the inspector, which cannot
 * import the CLI.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildKnowledgeStaleReport,
  CommandResolutionStatus,
  inspectSharkcraft,
  ReferenceCheckOutcome,
} from '@shrkcrft/inspector';
import { buildRegistry } from '../main.ts';
import { CommandRegistry } from '../command-registry.ts';
import { PositionalMode } from '../dispatch/positional-mode.ts';
import { COMMAND_CATALOG } from '../commands/command-catalog.ts';
import { CommandDispatchKind } from '../surface/command-dispatch-kind.ts';
import { buildCommandIndex } from '../surface/command-index.ts';
import { readPackageScripts } from '../surface/cli-command-resolver.ts';
import { resolveCommandString } from '../surface/resolve-command-string.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const SPAWN_TIMEOUT_MS = 180_000;

const UNKNOWN = new Set<CommandResolutionStatus>([
  CommandResolutionStatus.UnknownVerb,
  CommandResolutionStatus.UnknownSubverb,
  CommandResolutionStatus.UnknownScript,
  CommandResolutionStatus.UnknownTool,
]);

function shrk(cwd: string, argv: readonly string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('bun', ['run', CLI_MAIN, ...argv], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function workspace(files: Readonly<Record<string, string>>, pkg: object = { name: 'fx', version: '0.0.0' }): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-cmdlint-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

const index = buildCommandIndex(buildRegistry());

describe('list ≡ resolve', () => {
  test('every command the index lists resolves `ok` (prefixed `shrk `)', () => {
    const bad = index.entries
      .filter((e) => e.dispatch !== CommandDispatchKind.Meta)
      .map((e) => ({ p: `shrk ${e.path}`, s: resolveCommandString(index, `shrk ${e.path}`).status }))
      .filter((r) => r.s !== CommandResolutionStatus.Ok);
    expect(bad).toEqual([]);
  });

  test('every catalog command string (flags and placeholders included) resolves — never unknown-*', () => {
    const bad = COMMAND_CATALOG.map((e) => ({
      c: e.command,
      s: resolveCommandString(index, `shrk ${e.command}`).status,
    })).filter((r) => UNKNOWN.has(r.s));
    expect(bad).toEqual([]);
  });
});

describe('the negatives — each string the old shape check certified', () => {
  const ctx = { scripts: new Set(['test', 'build']), mcpToolNames: new Set(['get_task_packet']) };
  const cases: readonly [string, CommandResolutionStatus][] = [
    ['shrk frobnicate', CommandResolutionStatus.UnknownVerb],
    ['shrk frobnicate zzz', CommandResolutionStatus.UnknownVerb],
    ['shrk decisions doctor', CommandResolutionStatus.UnknownVerb],
    ['shrk agent graph', CommandResolutionStatus.UnknownVerb],
    ['shrk api report', CommandResolutionStatus.UnknownVerb],
    ['shrk rules lst', CommandResolutionStatus.UnknownSubverb],
    ['bun run no-such-script', CommandResolutionStatus.UnknownScript],
    ['get_task_packets', CommandResolutionStatus.UnknownTool],
    ['git status', CommandResolutionStatus.NotShrk],
    ['bun x tsc -p . --noEmit', CommandResolutionStatus.NotShrk],
    ['shrk gen <template> <name>', CommandResolutionStatus.Ok],
    ['shrk context --task "x"', CommandResolutionStatus.Ok],
    ['$ shrk doctor', CommandResolutionStatus.Ok],
    ['FOO=1 npx shrk check wiring --json', CommandResolutionStatus.Ok],
    ['shrk --cwd ./repo doctor', CommandResolutionStatus.Ok],
    ['shrk playbook list', CommandResolutionStatus.Ok],
    ['bun run test', CommandResolutionStatus.Ok],
    ['get_task_packet', CommandResolutionStatus.Ok],
    ['shrk doctor && shrk frobnicate', CommandResolutionStatus.UnknownVerb],
    // Round 11 W3: `self-config` declares `positionals: None` + its subverbs,
    // so an unknown tail is now PROVABLY an unknown subverb (was prefix-only).
    ['shrk self-config nonsense', CommandResolutionStatus.UnknownSubverb],
    // Round 11 review (intentional change): `gates` now declares
    // `positionals: None` — the dispatcher refuses an unknown verb there (the
    // guard, not the body), so the resolver proves it too.
    ['shrk gates nonsense', CommandResolutionStatus.UnknownSubverb],
    // …and so does every other handler with subverbs: no registered handler
    // with a known subverb leaves its positional mode undeclared any more.
    ['shrk generated nonsense', CommandResolutionStatus.UnknownSubverb],
    // A declared subverb's alias dispatches like its name (the walk matches it).
    ['shrk commands workflows', CommandResolutionStatus.Ok],
    // A shell redirection ends the command; an optional `[…]` group is usage text.
    ['shrk quality --ci > quality.json', CommandResolutionStatus.Ok],
    ['shrk doctor --watch [--debounce N]', CommandResolutionStatus.Ok],
  ];
  for (const [raw, want] of cases) {
    test(`${raw} → ${want}`, () => {
      expect(resolveCommandString(index, raw, ctx).status).toBe(want);
    });
  }

  test('the closest real command is suggested', () => {
    expect(resolveCommandString(index, 'shrk search-tuning explain "rename plugin"').closest).toContain(
      'shrk search tuning explain',
    );
    expect(resolveCommandString(index, 'shrk rules lst').closest).toContain('shrk rules list');
    expect(resolveCommandString(index, 'bun run tst', ctx).closest).toContain('bun run test');
  });

  test('a legacy handler tail is prefix-only (counted, never flagged) — a declaration proves unknown-subverb', () => {
    // A handler that dispatches trie children and declares no positional
    // semantics: an unknown tail may be a free positional, so it is not
    // flagged. No production handler is shaped like this any more (round 11
    // review declared `gates` / `baseline` / `docs references` …), so the rule is
    // held on a real registry built for it.
    const legacy = new CommandRegistry();
    legacy.register({ name: 'legacy', description: 'legacy group', usage: 'shrk legacy [list]', run: () => 0 });
    legacy.registerSubcommand('legacy', { name: 'list', description: 'list', usage: 'shrk legacy list', run: () => 0 });
    expect(resolveCommandString(buildCommandIndex(legacy, []), 'shrk legacy nonsense').status).toBe(
      CommandResolutionStatus.PrefixOnly,
    );
    // Round 11 W3: the real `check` now declares `positionals: None` + its
    // subverbs, so the spec's own example is provably an unknown subverb.
    expect(resolveCommandString(index, 'shrk check rules --tag auth').status).toBe(
      CommandResolutionStatus.UnknownSubverb,
    );
    // The moment a handler declares `positionals: None` + its subverbs, the
    // same shape is provably an unknown subverb, with the closest real one.
    const r = new CommandRegistry();
    r.register({
      name: 'check',
      description: 'Checks.',
      usage: 'shrk check <boundaries|wiring>',
      subverbs: [
        { name: 'boundaries', description: 'Boundaries.', usage: 'shrk check boundaries' },
        { name: 'wiring', description: 'Wiring.', usage: 'shrk check wiring' },
      ],
      positionals: PositionalMode.None,
      run: () => 0,
    });
    const declared = buildCommandIndex(r);
    const res = resolveCommandString(declared, 'shrk check wirng --tag auth');
    expect(res.status).toBe(CommandResolutionStatus.UnknownSubverb);
    expect(res.closest).toContain('shrk check wiring');
    expect(resolveCommandString(declared, 'shrk check wiring').status).toBe(CommandResolutionStatus.Ok);
  });

  test('`<pm> run <x>` checks the ROOT package.json scripts', () => {
    const root = workspace({}, { name: 'fx', version: '0.0.0', scripts: { lint: 'eslint .' } });
    try {
      const scripts = readPackageScripts(root);
      expect(scripts?.has('lint')).toBe(true);
      expect(resolveCommandString(index, 'npm run lint', { scripts: scripts! }).status).toBe(
        CommandResolutionStatus.Ok,
      );
      expect(resolveCommandString(index, 'pnpm run lnt', { scripts: scripts! }).status).toBe(
        CommandResolutionStatus.UnknownScript,
      );
      // No scripts to read → cannot check → skipped, never invented.
      expect(resolveCommandString(index, 'npm run lint').status).toBe(CommandResolutionStatus.NotShrk);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('knowledge `command` references go through the injected resolver', () => {
  const files = {
    'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'fx', knowledgeFiles: ['knowledge.ts'] };\n`,
    'sharkcraft/knowledge.ts': `export const graphEntry = {
  id: 'fx.cmd-refs',
  title: 'Command references',
  type: 'technical',
  priority: 'medium',
  tags: ['cmd'],
  content: 'An entry citing one dead and one real command.',
  references: [
    { kind: 'command', command: 'shrk agent graph' },
    { kind: 'command', command: 'shrk doctor' },
  ],
};
`,
  };

  test(
    'via the CLI: the dead command is STALE, the real one OK',
    () => {
      const root = workspace(files);
      try {
        const res = shrk(root, ['knowledge', 'stale-check', '--json']);
        const json = JSON.parse(res.stdout) as {
          referenceChecks: { reference: { command?: string }; outcome: string; message: string }[];
        };
        const byCommand = new Map(json.referenceChecks.map((c) => [c.reference.command, c]));
        expect(byCommand.get('shrk agent graph')?.outcome).toBe(ReferenceCheckOutcome.Stale);
        expect(byCommand.get('shrk agent graph')?.message).toContain('unknown-verb');
        expect(byCommand.get('shrk doctor')?.outcome).toBe(ReferenceCheckOutcome.Ok);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  test('a direct engine call with no injected resolver is Unknown / NOT VERIFIED — never Ok', async () => {
    const root = workspace(files);
    try {
      const inspection = await inspectSharkcraft({ cwd: root });
      const report = buildKnowledgeStaleReport(inspection);
      const commandChecks = report.referenceChecks.filter((c) => c.reference.kind === 'command');
      expect(commandChecks).toHaveLength(2);
      for (const c of commandChecks) {
        expect(c.outcome).toBe(ReferenceCheckOutcome.Unknown);
        expect(c.message).toContain('NOT VERIFIED');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('dogfood lock', () => {
  test(
    "shrk's own assets prescribe no command that does not resolve",
    () => {
      const res = shrk(REPO_ROOT, ['self-config', 'doctor', '--json']);
      const json = JSON.parse(res.stdout) as {
        findings: { code: string; sourceKind: string; sourceId: string; targetId: string }[];
        probes: { command: { probed: number; unknown: number; unverified: number } };
      };
      const dead = json.findings
        .filter((f) => f.code === 'unknown-command')
        .map((f) => `${f.sourceKind}:${f.sourceId} → ${f.targetId}`);
      expect(dead).toEqual([]);
      expect(json.probes.command.unknown).toBe(0);
      expect(json.probes.command.unverified).toBe(0);
      expect(json.probes.command.probed).toBeGreaterThan(100);
    },
    SPAWN_TIMEOUT_MS,
  );
});
