/**
 * r75 — tool-maintenance commands are gated outside SharkCraft's own
 * repository (round 11 §5.1).
 *
 * `docs check`, `examples check`, `release readiness`, `self audit`,
 * `install smoke`, `commands doctor`, … maintain SharkCraft ITSELF. In a
 * consumer repo they used to run and FAIL: `docs check` demanded the tool's
 * own documentation set (exit 1), `release readiness` said NOT READY — a red
 * result on a healthy repo, indistinguishable from a real finding.
 *
 * Now the catalog tags them `tool-maintenance`, ONE host authority
 * (`detectSharkcraftRepo`, tightened to the tool's CLI package identity)
 * decides where they apply, and outside the tool repo they are hidden from
 * `--help` and exit 78 through the EXISTING surface gate — never a check
 * failure. `surface.enabled` is the escape hatch. The MCP gate reads the same
 * summary. Inside SharkCraft's repository every command stays callable.
 *
 * Real `buildRegistry()`, real config loader, real `runCli` (in-process) and
 * the CLI spawned from source, over mkdtemp fixtures.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import {
  buildSelfAudit,
  buildUpgradeAdvice,
  classifyChangeIntent,
  detectSharkcraftRepo,
  inspectSharkcraft,
} from '@shrkcrft/inspector';
import { ALL_TOOLS, createSharkcraftServer } from '@shrkcrft/mcp-server';
import { buildRegistry, runCli } from '../main.ts';
import { buildMcpGateResolver } from '../commands/mcp.command.ts';
import { COMMAND_CATALOG, isToolMaintenance } from '../commands/command-catalog.ts';
import { cleanCommandPath, commandIndexFor, setActiveCommandRegistry } from '../surface/command-index.ts';
import { loadSurfaceContext } from '../surface/load-surface-context.ts';
import { buildSurfaceSummary, findCommandInSummary } from '../surface/surface-summary.ts';
import { SURFACE_NOT_ENABLED_EXIT_CODE } from '../surface/not-enabled-error.ts';
import { TierSource } from '../surface/tier.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const SPAWN_TIMEOUT_MS = 180_000;

/** The scope, as the round-11 plan names it (clean paths; flag variants fold in). */
const TOOL_MAINTENANCE_PATHS: readonly string[] = [
  // Round 11 review: `docs-check` reads SharkCraft's own docs, `retirement-plan`
  // SharkCraft's own overlaps view.
  'commands docs-check',
  'commands doctor',
  'commands legacy',
  'commands machine',
  'commands overlaps',
  'commands retirement-plan',
  'commands ux-check',
  'diff rounds',
  'docs check',
  'examples check',
  'install smoke',
  'release readiness',
  'release smoke',
  'rounds capture',
  'rounds list',
  'rounds show',
  'self audit',
];

/** Consumer-useful verbs deliberately NOT tagged (path prefixes). */
const CONSUMER_PREFIXES: readonly string[] = ['docs references', 'packs release-check', 'packs sign', 'schemas', 'changelog'];

const roots: string[] = [];
afterAll(() => {
  setActiveCommandRegistry(undefined);
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function writeTree(root: string, files: Readonly<Record<string, string>>): void {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
}

/** A consumer repo; `surface` is the TS literal of its `surface{}` block. */
function consumer(surface?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-toolmaint-'));
  roots.push(root);
  writeTree(root, {
    'package.json': JSON.stringify({ name: 'consumer-app', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts':
      `export default {\n  projectName: 'consumer-app',\n` + (surface ? `  surface: ${surface},\n` : '') + `};\n`,
    'src/index.ts': "export const hello = (): string => 'hi';\n",
    'README.md': '# consumer-app\n',
  });
  return root;
}

/** A consumer monorepo that LOOKS like the tool: packages/{cli,inspector,mcp-server}. */
function lookalike(cliPackageName: string, rootName = 'acme-monorepo'): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-lookalike-'));
  roots.push(root);
  writeTree(root, {
    'package.json': JSON.stringify({ name: rootName, version: '0.0.0', workspaces: ['packages/*'] }),
    'packages/cli/package.json': JSON.stringify({ name: cliPackageName, version: '0.0.0' }),
    'packages/inspector/package.json': JSON.stringify({ name: '@acme/inspector', version: '0.0.0' }),
    'packages/mcp-server/package.json': JSON.stringify({ name: '@acme/mcp-server', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'acme' };\n",
  });
  return root;
}

interface IRun {
  readonly code: number | 'timeout';
  readonly out: string;
  readonly err: string;
}

/** `runCli` in-process with stdout/stderr captured. */
async function runInProcess(argv: readonly string[], timeoutMs = 60_000): Promise<IRun> {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
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
  try {
    const code = await Promise.race([
      runCli(argv),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
    ]);
    return { code, out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

function shrk(cwd: string, argv: readonly string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('bun', [CLI_MAIN, ...argv], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, SHARKCRAFT_USAGE_DISABLED: '1' },
    timeout: 120_000,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const LISTED_LINE = /^ {2}(\S.*?)\s+— /;

function lineFor(out: string, command: string): string | undefined {
  return out.split('\n').find((l) => LISTED_LINE.exec(l)?.[1]?.trim() === command);
}

describe('the audience tag — exactly the tool-maintenance scope', () => {
  test('the tagged catalog rows are the plan\'s list (flag variants included); consumer verbs are not tagged', () => {
    const tagged = [...new Set(COMMAND_CATALOG.filter(isToolMaintenance).map((e) => cleanCommandPath(e.command)))].sort();
    expect(tagged).toEqual([...TOOL_MAINTENANCE_PATHS]);
    const wronglyTagged = COMMAND_CATALOG.filter(
      (e) => isToolMaintenance(e) && CONSUMER_PREFIXES.some((p) => cleanCommandPath(e.command).startsWith(p)),
    ).map((e) => e.command);
    expect(wronglyTagged).toEqual([]);
    // The variants are tagged too: `release readiness --strict`, `install smoke --tarball`, `self audit --run`.
    for (const variant of ['release readiness --strict', 'install smoke --tarball', 'self audit --run']) {
      const row = COMMAND_CATALOG.find((e) => e.command === variant);
      expect(row && isToolMaintenance(row)).toBe(true);
    }
  });
});

describe('outside SharkCraft\'s repository: gated through the surface gate (exit 78), never a failure', () => {
  const invocations: readonly (readonly [readonly string[], string])[] = [
    [['docs', 'check'], 'docs check'],
    [['examples', 'check'], 'examples check'],
    [['release', 'readiness', '--json'], 'release readiness'],
    [['release', 'readiness', '--strict'], 'release readiness'],
    [['release', 'smoke'], 'release smoke'],
    [['self', 'audit'], 'self audit'],
    [['install', 'smoke', '--tarball'], 'install smoke'],
    [['commands', 'doctor', '--json'], 'commands doctor'],
    [['commands', 'ux-check'], 'commands ux-check'],
    // Round 11 review: both read SharkCraft's own docs / overlaps view.
    [['commands', 'docs-check'], 'commands docs-check'],
    [['commands', 'retirement-plan'], 'commands retirement-plan'],
    [['rounds', 'list'], 'rounds list'],
    [['diff', 'rounds'], 'diff rounds'],
  ];
  for (const [argv, label] of invocations) {
    test(
      `shrk ${argv.join(' ')}`,
      async () => {
        const fx = consumer();
        const run = await runInProcess(['--cwd', fx, ...argv]);
        expect(run.code).toBe(SURFACE_NOT_ENABLED_EXIT_CODE);
        const reason = `\`${label}\` maintains SharkCraft itself and does not apply to this repository — this is not a check failure.`;
        const remedy = `shrk surface enable "${label}" --write`;
        if (argv.includes('--json')) {
          // Round 11 docs review (intentional): under `--json` the refusal is the
          // documented machine body on STDOUT — schema + reasonCode — and stderr
          // is empty. It printed the text alone, so `--json` read zero bytes.
          const body = JSON.parse(run.out) as Record<string, unknown>;
          expect(body).toMatchObject({
            schema: 'sharkcraft.surface.not-enabled.v1',
            command: label,
            reasonCode: 'tool-maintenance',
            reason,
            enableCommand: remedy,
          });
          expect(run.err).toBe('');
        } else {
          expect(run.out).toBe('');
          expect(run.err).toContain(reason);
          expect(run.err).toContain(remedy);
        }
        // Nothing ran, in either form.
        for (const stream of [run.out, run.err]) {
          expect(stream).not.toContain('required-doc-missing');
          expect(stream).not.toContain('NOT READY');
        }
      },
      SPAWN_TIMEOUT_MS,
    );
  }

  test(
    'the gate looks up the DECLARED subverb: `release readiness` is gated, bare `release` is not',
    async () => {
      const fx = consumer();
      const bare = await runInProcess(['--cwd', fx, 'release']);
      expect(bare.code).not.toBe(SURFACE_NOT_ENABLED_EXIT_CODE);
      const commandsList = await runInProcess(['--cwd', fx, 'commands', 'primary']);
      expect(commandsList.code).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    'spawned from source: `docs check` exits 78 with the refusal and runs nothing',
    () => {
      const fx = consumer();
      const res = shrk(fx, ['docs', 'check']);
      expect(res.status).toBe(SURFACE_NOT_ENABLED_EXIT_CODE);
      expect(res.stdout).toBe('');
      expect(res.stderr).toContain('`docs check` maintains SharkCraft itself');
      expect(res.stderr).not.toContain('required-doc-missing');
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    'the escape hatch: surface.enabled [\'docs check\'] runs the real check (exit 1 on a repo without the docs)',
    async () => {
      const fx = consumer("{ enabled: ['docs check'] }");
      const run = await runInProcess(['--cwd', fx, 'docs', 'check']);
      expect(run.code).toBe(1);
      expect(run.out).toContain('Required docs');
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    '`surface list` shows them gated with the audience column; `surface explain` names the cause and the remedy',
    async () => {
      const fx = consumer();
      const list = await runInProcess(['--cwd', fx, 'surface', 'list']);
      expect(list.code).toBe(0);
      expect(list.out).toMatch(/host\s+not the SharkCraft repository/);
      expect(list.out).toMatch(/docs check\s+.*human,agent,tool-maintenance\s+gated,tool-maintenance/);
      const explain = await runInProcess(['--cwd', fx, 'surface', 'explain', 'release', 'readiness']);
      expect(explain.code).toBe(0);
      expect(explain.out).toMatch(/source\s+tool-maintenance/);
      expect(explain.out).toContain('maintains SharkCraft itself; does not apply to this repository');
      expect(explain.out).toContain('shrk surface enable "release readiness" --write');
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe('property — every tool-maintenance command, both hosts', () => {
  test(
    'in a consumer repo: not callable, source tool-maintenance, absent from --full-help, annotated in --full-help --all',
    async () => {
      const fx = consumer();
      const { context } = await loadSurfaceContext({ cwd: fx });
      expect(context.isToolRepo).toBe(false);
      const index = commandIndexFor(buildRegistry());
      const summary = buildSurfaceSummary(context, index);
      const entries = index.entries.filter((e) => e.catalogEntry !== undefined && isToolMaintenance(e.catalogEntry));
      expect(entries.map((e) => e.path).sort()).toEqual([...TOOL_MAINTENANCE_PATHS]);
      for (const e of entries) {
        const v = findCommandInSummary(summary, e.path);
        expect({ path: e.path, callable: v?.callable, source: v?.source, visibleInHelp: v?.visibleInHelp }).toEqual({
          path: e.path,
          callable: false,
          source: TierSource.ToolMaintenance,
          visibleInHelp: false,
        });
      }
      // Every tagged catalog row — variants included — resolves to a gated view.
      for (const row of COMMAND_CATALOG.filter(isToolMaintenance)) {
        expect({ row: row.command, callable: findCommandInSummary(summary, row.command)?.callable }).toEqual({
          row: row.command,
          callable: false,
        });
      }
      const help = await runInProcess(['--cwd', fx, '--full-help']);
      expect(help.code).toBe(0);
      expect(TOOL_MAINTENANCE_PATHS.filter((p) => lineFor(help.out, p) !== undefined)).toEqual([]);
      const all = await runInProcess(['--cwd', fx, '--full-help', '--all']);
      expect(all.code).toBe(0);
      const unannotated = TOOL_MAINTENANCE_PATHS.filter((p) => !lineFor(all.out, p)?.includes('gated: tool-maintenance'));
      expect(unannotated).toEqual([]);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "in SharkCraft's own repository: every one is callable",
    async () => {
      const { context } = await loadSurfaceContext({ cwd: REPO_ROOT });
      expect(context.isToolRepo).toBe(true);
      const summary = buildSurfaceSummary(context, commandIndexFor(buildRegistry()));
      for (const p of TOOL_MAINTENANCE_PATHS) {
        const v = findCommandInSummary(summary, p);
        expect({ p, callable: v?.callable, source: v?.source === TierSource.ToolMaintenance }).toEqual({
          p,
          callable: true,
          source: false,
        });
      }
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe('one host authority — detectSharkcraftRepo', () => {
  test('the tool is identified by its CLI package, not by directory markers', () => {
    expect(detectSharkcraftRepo(REPO_ROOT)).toBe(true);
    // A consumer monorepo with packages/cli + inspector + mcp-server (the old
    // marker branch said "SharkCraft").
    expect(detectSharkcraftRepo(lookalike('@acme/cli'))).toBe(false);
    expect(detectSharkcraftRepo(lookalike('@shrkcrft/cli'))).toBe(true);
    // A root merely NAMED sharkcraft, without the CLI package.
    const named = mkdtempSync(join(tmpdir(), 'shrk-r75-named-'));
    roots.push(named);
    writeTree(named, { 'package.json': JSON.stringify({ name: 'sharkcraft', version: '0.0.0' }) });
    expect(detectSharkcraftRepo(named)).toBe(false);
  });

  test(
    'a look-alike consumer monorepo gets the gate, not the tool\'s checks',
    async () => {
      const run = await runInProcess(['--cwd', lookalike('@acme/cli'), 'docs', 'check']);
      expect(run.code).toBe(SURFACE_NOT_ENABLED_EXIT_CODE);
    },
    SPAWN_TIMEOUT_MS,
  );

  test('self audit points a consumer at `shrk quality` — never at another tool-maintenance command', () => {
    const report = buildSelfAudit(consumer());
    expect(report.isSharkcraftRepo).toBe(false);
    expect(report.findings[0]?.nextCommand).toBe('shrk quality');
  });

  test('grep lock: no production file decides repo-ness through its own existsSync', () => {
    const offenders: string[] = [];
    const definitions: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue;
        const abs = join(dir, name);
        if (statSync(abs).isDirectory()) walk(abs);
        else if (name.endsWith('.ts')) {
          const text = readFileSync(abs, 'utf8');
          // `isRepo = existsSync(…main.ts)` was release.command.ts's private
          // detector. An identifier ENDING in `Repo` (never `reportExists`).
          if (/\b(?:\w*Repo|repo)\s*=\s*existsSync\(/.test(text)) offenders.push(relative(REPO_ROOT, abs));
          if (/export function detectSharkcraftRepo\b/.test(text)) definitions.push(relative(REPO_ROOT, abs));
        }
      }
    };
    for (const pkg of readdirSync(join(REPO_ROOT, 'packages'))) {
      const src = join(REPO_ROOT, 'packages', pkg, 'src');
      if (statSync(join(REPO_ROOT, 'packages', pkg)).isDirectory() && existsDir(src)) walk(src);
    }
    expect(offenders).toEqual([]);
    expect(definitions).toEqual(['packages/inspector/src/self-audit.ts']);
  });
});

/** Any tool-maintenance command, as a `shrk <path>` mention. */
const TOOL_COMMAND = new RegExp(
  `shrk (?:${TOOL_MAINTENANCE_PATHS.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![a-z-])`,
);

describe('consumer-facing output never prescribes a tool-maintenance command (round 11 review)', () => {
  test(
    '`ci scaffold --with-command-doctor` is refused outside the tool repo; every other `--with-*` step applies here',
    async () => {
      const fx = consumer();
      const refused = await runInProcess(['--cwd', fx, 'ci', 'scaffold', 'github-actions', '--with-command-doctor']);
      expect(refused.code).toBe(2);
      expect(refused.err).toContain('maintains SharkCraft itself and does not apply to this repository');
      expect(refused.out).toBe('');
      const usage = buildRegistry().getAt(['ci'])?.usage ?? '';
      const withFlags = [...new Set([...usage.matchAll(/--with-[a-z0-9-]+/g)].map((m) => m[0]))].filter(
        (f) => f !== '--with-command-doctor',
      );
      expect(withFlags.length).toBeGreaterThan(10);
      for (const provider of ['github-actions', 'gitlab', 'bitbucket']) {
        const r = await runInProcess(['--cwd', fx, 'ci', 'scaffold', provider, ...withFlags, '--pack-paths', 'packs/p']);
        expect({ provider, code: r.code }).toEqual({ provider, code: 0 });
        expect(r.out).toContain('shrk ');
        expect({ provider, tool: TOOL_COMMAND.exec(r.out)?.[0] ?? null }).toEqual({ provider, tool: null });
      }
      // Inside SharkCraft's own repository the step still applies.
      const own = await runInProcess(['--cwd', REPO_ROOT, 'ci', 'scaffold', 'github-actions', '--with-command-doctor']);
      expect(own.code).toBe(0);
      expect(own.out).toContain('shrk commands doctor');
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    '`recommend` / `task` / `context` in a consumer never name one, and never offer to enable one',
    async () => {
      const fx = consumer();
      for (const query of ['update the docs for the README', 'prepare the release']) {
        for (const argv of [['recommend', query], ['recommend', query, '--verbose'], ['task', query], ['context', '--task', query]]) {
          const r = await runInProcess(['--cwd', fx, ...argv]);
          const text = `${r.out}\n${r.err}`;
          expect({ argv: argv.join(' '), tool: TOOL_COMMAND.exec(text)?.[0] ?? null }).toEqual({
            argv: argv.join(' '),
            tool: null,
          });
          expect(text).not.toContain('surface enable docs check');
          expect(text).not.toContain('surface enable release');
        }
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "`surface explain` of an uncatalogued command names SharkCraft's catalog gap — never a gated remedy",
    async () => {
      const fx = consumer();
      const r = await runInProcess(['--cwd', fx, 'surface', 'explain', 'graph importers']);
      expect(r.code).toBe(0);
      expect(r.out).not.toContain('commands doctor');
      expect(r.out).toContain("SharkCraft's command catalog");
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    'the change-intent fallback and the upgrade advice read the one host authority',
    async () => {
      const own = await inspectSharkcraft({ cwd: REPO_ROOT });
      const outside = await inspectSharkcraft({ cwd: consumer() });
      expect((await classifyChangeIntent('update the docs for the README', outside)).suggestedFirstCommand).toBe(
        'shrk docs references check',
      );
      expect((await classifyChangeIntent('prepare the release', outside)).suggestedFirstCommand).toBe('shrk quality');
      expect(buildUpgradeAdvice(outside).recommendedSteps.join('\n')).not.toMatch(TOOL_COMMAND);
      // Inside the tool repository its own gates still apply.
      expect((await classifyChangeIntent('update the docs for the README', own)).suggestedFirstCommand).toBe('shrk docs check');
      expect(buildUpgradeAdvice(own).recommendedSteps).toContain('shrk commands doctor');
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    'bare `release` in a consumer says its verbs do not apply here, instead of listing only refused verbs',
    async () => {
      const r = await runInProcess(['--cwd', consumer(), 'release']);
      expect(r.code).toBe(2);
      expect(r.err).toContain('do not apply to this repository');
      expect(r.err).toContain('shrk quality');
    },
    SPAWN_TIMEOUT_MS,
  );
});

function existsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

describe('MCP — the four tools declare cliCommand, and the gate refuses them on the wire', () => {
  test('cliCommand declarations', () => {
    const byName = new Map(ALL_TOOLS.map((t) => [t.name, t.cliCommand]));
    expect(byName.get('get_docs_check')).toBe('docs check');
    expect(byName.get('get_examples_check')).toBe('examples check');
    expect(byName.get('get_release_readiness')).toBe('release readiness');
    expect(byName.get('get_self_audit')).toBe('self audit');
  });

  test(
    'through the real MCP server with the CLI gate resolver: tools/call get_docs_check → isError with the CLI reason',
    async () => {
      // The production pieces `shrk mcp serve` wires: buildMcpGateResolver(cwd)
      // into createSharkcraftServer, driven over a transport through the public
      // `server.connect()` (the CLI entry cannot be spawned for this — see the
      // round's open issues: `shrk mcp serve` from source exits after connect).
      const fx = consumer();
      setActiveCommandRegistry(buildRegistry());
      const gateResolver = await buildMcpGateResolver(fx);
      expect(gateResolver).toBeDefined();
      const { server } = createSharkcraftServer({ name: 'r75', version: '0.0.0', cwd: fx, verbose: false, gateResolver: gateResolver! });
      const sent: Record<string, unknown>[] = [];
      const transport = {
        onmessage: undefined as undefined | ((message: unknown) => void),
        onclose: undefined as undefined | (() => void),
        onerror: undefined as undefined | ((error: Error) => void),
        async start(): Promise<void> {},
        async send(message: unknown): Promise<void> {
          sent.push(message as Record<string, unknown>);
        },
        async close(): Promise<void> {},
      };
      await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
      const request = async (id: number, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
        transport.onmessage?.({ jsonrpc: '2.0', id, method, params });
        for (let i = 0; i < 1_000; i += 1) {
          const reply = sent.find((m) => m['id'] === id);
          if (reply) return reply;
          await Bun.sleep(10);
        }
        throw new Error(`no reply to ${method}`);
      };
      try {
        await request(1, 'initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'r75', version: '0.0.0' },
        });
        transport.onmessage?.({ jsonrpc: '2.0', method: 'notifications/initialized' });
        for (const [id, name] of [
          [2, 'get_docs_check'],
          [3, 'get_release_readiness'],
        ] as const) {
          const reply = await request(id, 'tools/call', { name, arguments: {} });
          const result = reply['result'] as { isError?: boolean; content: { text: string }[] };
          expect({ name, isError: result.isError }).toEqual({ name, isError: true });
          expect(result.content.map((c) => c.text).join('\n')).toContain(
            'maintains SharkCraft itself and does not apply to this repository',
          );
        }
      } finally {
        await server.close();
      }
    },
    SPAWN_TIMEOUT_MS,
  );
});
