/**
 * Round 11 (integration lane) — items 9, 11 and 12.
 *
 *   9. Command strings the INSPECTOR generates into guidance (agent contracts,
 *      role views, task risk, plan simulation, the repository knowledge model)
 *      resolve against THE command index. `shrk api report`, `shrk agent
 *      graph` and `shrk decisions new` never existed, and guidance that names
 *      a dead command is exactly what the one command authority exists to kill.
 *  11. `shrk doctor` never prints "Ready ✓" next to a compiled pack build with
 *      no build record (never compared with its source). It is NOT VERIFIED
 *      (2), as in `packs doctor`, and a repo without one is unchanged.
 *  12. `packs signature-status` over zero signed packs, and `packs test` over a
 *      manifest that declares nothing, examined nothing. Both settle to 2, with
 *      `--allow-empty` as the valve.
 *
 * Real registries (`buildRegistry()` → the command index), real workspaces
 * through the real inspector, the real handlers.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { blankZoneKinds, lexCodeZones } from '@shrkcrft/boundaries';
import { CommandResolutionStatus } from '@shrkcrft/inspector';
import type { ParsedArgs } from '../command-registry.ts';
import { doctorCommand } from '../commands/doctor.command.ts';
import { packsSignatureStatusCommand } from '../commands/packs.command.ts';
import { packsTestCommand } from '../commands/packs-new.ts';
import { buildRegistry } from '../main.ts';
import { buildCommandIndex } from '../surface/command-index.ts';
import { resolveCommandString } from '../surface/resolve-command-string.ts';

const SLOW = 120_000;
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');

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
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = '';
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    out += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((): boolean => true) as typeof process.stderr.write;
  try {
    return { code: await h.run(a), out };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-lane-'));
  roots.push(root);
  write(root, 'package.json', JSON.stringify({ name: 'r75-lane', version: '0.0.0', type: 'module', private: true }));
  write(root, 'sharkcraft/sharkcraft.config.ts', "export default { projectName: 'r75-lane' };\n");
  for (const [rel, body] of Object.entries(files)) write(root, rel, body);
  return root;
}

const UNKNOWN = new Set<CommandResolutionStatus>([
  CommandResolutionStatus.UnknownVerb,
  CommandResolutionStatus.UnknownSubverb,
  CommandResolutionStatus.UnknownScript,
  CommandResolutionStatus.UnknownTool,
]);

// ── 9. inspector-generated command strings ──────────────────────────────────

/**
 * Where generated guidance lives: EVERY non-test inspector and CLI source file
 * (command bodies, failure footers, the landing screen, gates, quality, finish,
 * diff, …), plus the live MCP command-discovery tools whose `Next:` hint names
 * a CLI command. Not a hand-kept list of files: the review that widened this
 * lock found the same dead commands in eleven sibling inspector files the old
 * six-file list never scanned, and round 11's final pass found a dozen more in
 * CLI command files the inspector-only lock never read (`shrk session show`,
 * `shrk commands suggest`, `shrk plan verify`, `shrk find`, …).
 */
const GUIDANCE_ROOTS = ['packages/inspector/src', 'packages/cli/src'];
const GUIDANCE_FILES = ['packages/mcp-server/src/tools/r31-command-discovery.tool.ts'];

function guidanceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) {
        if (name !== '__tests__' && name !== 'dist' && name !== 'node_modules') walk(abs);
      } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
        out.push(relative(REPO_ROOT, abs));
      }
    }
  };
  for (const root of GUIDANCE_ROOTS) walk(join(REPO_ROOT, root));
  return [...new Set([...out, ...GUIDANCE_FILES])].sort();
}

/**
 * Literals that START with `shrk ` but are prose ABOUT shrk, never a command
 * (as captured below). Keyed by file, so an exemption cannot widen to another
 * file, and each must still occur — a stale exemption fails its own test.
 */
const PROSE: Readonly<Record<string, readonly string[]>> = {
  // "shrk doesn't have a `<attempt>` command." — the dispatcher's own refusal.
  'packages/cli/src/main.ts': ['shrk doesn'],
  // "shrk has no `<verb>` command" — the resolver's own reason text.
  'packages/cli/src/surface/resolve-command-string.ts': ['shrk has no'],
  // "shrk v<version> — …" — the landing screen's version banner.
  'packages/cli/src/surface/no-args-landing.ts': ['shrk v'],
};

/**
 * Every `shrk …` literal in CODE, cut at the first interpolation. Comments are
 * blanked first with the repo's own lexer (`lexCodeZones`), so prose that
 * describes a retired command is not read as guidance. The literal may open
 * with indentation or a `$ ` prompt (`  shrk search "<x>"` in a "Next
 * commands:" block), and a run of 2+ spaces ends the command (an aligned
 * `shrk doctor        health check` column). A placeholder (`shrk …`) and a
 * usage line (`shrk [--cwd <dir>] …`) name no command.
 */
function commandLiterals(raw: string): string[] {
  const source = blankZoneKinds(raw, lexCodeZones(raw), new Set(['comment'] as const)).content;
  const out: string[] = [];
  const re = /['"`][ \t]*(?:\$[ \t]+)?(shrk [^'"`$\\]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const cmd = m[1]!.split(/\s{2,}/)[0]!.trim();
    const tokens = cmd.split(/\s+/);
    const head = tokens[1] ?? '';
    if (tokens.length < 2 || head.startsWith('…') || head.startsWith('...') || head.startsWith('[')) continue;
    out.push(cmd);
  }
  return [...new Set(out)];
}

/** Commands that never existed, or were retired, and must never be generated again. */
const RETIRED = [
  'shrk api report',
  'shrk agent graph',
  'shrk decisions new',
  'shrk diagnostics suggest',
  'shrk intelligence graph',
  'shrk migration readiness',
  'shrk migration profiles',
  'shrk handoff',
  'shrk intent',
  'shrk compliance',
  'shrk stability map',
  'shrk product check',
  'shrk session show',
  // Round 11 review: `dev plan` on a legacy session named `session report`
  // (`shrk report session` refuses a legacy session; `dev report <id>` works),
  // and the unregistered `stabilityCommand` named `stability area`.
  'shrk session report',
  'shrk stability area',
  'shrk commands suggest',
  'shrk why-not',
  'shrk demo ',
  'shrk quality baseline',
];

describe('item 9 — guidance the inspector generates names only commands that exist', () => {
  test('every shrk command string in inspector + owned CLI guidance resolves against THE command index', () => {
    const index = buildCommandIndex(buildRegistry());
    const dead: string[] = [];
    let probed = 0;
    const files = guidanceFiles();
    expect(files.length).toBeGreaterThan(300);
    for (const rel of files) {
      for (const cmd of commandLiterals(readFileSync(join(REPO_ROOT, rel), 'utf8'))) {
        if (PROSE[rel]?.includes(cmd) === true) continue;
        probed += 1;
        const res = resolveCommandString(index, cmd);
        if (UNKNOWN.has(res.status)) dead.push(`${rel}: ${cmd} (${res.status})`);
      }
    }
    expect(probed).toBeGreaterThan(500);
    expect(dead).toEqual([]);
  });

  test('every prose exemption still names a literal in its file (no stale exemption)', () => {
    for (const [rel, literals] of Object.entries(PROSE)) {
      const found = commandLiterals(readFileSync(join(REPO_ROOT, rel), 'utf8'));
      for (const literal of literals) {
        expect({ rel, literal, present: found.includes(literal) }).toEqual({ rel, literal, present: true });
      }
    }
  });

  test('retired commands are gone from generated guidance (code, not comments)', () => {
    const hits: string[] = [];
    for (const rel of guidanceFiles()) {
      const raw = readFileSync(join(REPO_ROOT, rel), 'utf8');
      const code = blankZoneKinds(raw, lexCodeZones(raw), new Set(['comment'] as const)).content;
      for (const retired of RETIRED) if (code.includes(retired)) hits.push(`${rel}: ${retired}`);
    }
    expect(hits).toEqual([]);
  });
});

// ── 11. doctor over an unverifiable compiled pack build ─────────────────────

const ruleEntry = (summary: string): string =>
  `export default [{ id: 'distpack.rule', title: 'Rule', type: 'rule', priority: 'high', summary: '${summary}', content: '${summary} content', tags: [], scope: [], appliesWhen: [] }];\n`;

/** A pack serving dist/assets/rules.js built from src/assets/rules.ts; `record` is its build record. */
function compiledPack(record: 'none' | 'fresh-map'): string {
  const src = ruleEntry('NEW source');
  const pack = 'node_modules/@r11/distpack';
  return project({
    [`${pack}/package.json`]: JSON.stringify({
      name: '@r11/distpack',
      version: '0.0.1',
      type: 'module',
      sharkcraft: { manifest: './dist/sharkcraft.plugin.js' },
    }),
    [`${pack}/dist/sharkcraft.plugin.js`]:
      "export default { schema: 'sharkcraft.pack/v1', info: { name: '@r11/distpack', version: '0.0.1' }, contributions: { ruleFiles: ['./dist/assets/rules.js'] } };\n",
    [`${pack}/dist/assets/rules.js`]: record === 'fresh-map' ? src : ruleEntry('OLD compiled'),
    [`${pack}/src/assets/rules.ts`]: src,
    ...(record === 'fresh-map'
      ? {
          [`${pack}/dist/assets/rules.js.map`]: JSON.stringify({
            version: 3,
            sources: ['../../src/assets/rules.ts'],
            sourcesContent: [src],
            mappings: '',
          }),
        }
      : {}),
  });
}

describe('item 11 — doctor never reads "Ready ✓" over an unverifiable pack build', () => {
  test('a compiled pack with no build record: 2 NOT VERIFIED, text ≡ --json (ready false)', async () => {
    const root = compiledPack('none');
    const text = await run(doctorCommand, args(root, []));
    expect(text.code).toBe(2);
    expect(text.out).toContain('NOT VERIFIED');
    expect(text.out).toContain('@r11/distpack');
    expect(text.out).not.toContain('Ready for AI-agent use. ✓');
    const json = JSON.parse((await run(doctorCommand, args(root, [], { json: true }))).out) as {
      exitCode: number;
      ready: boolean;
      shortfalls?: string[];
      coverage?: { unit: string }[];
    };
    expect({ exit: json.exitCode, ready: json.ready }).toEqual({ exit: 2, ready: false });
    expect(json.shortfalls?.some((s) => s.includes('compiled pack builds'))).toBe(true);
    // --strict counts the warning, as `packs doctor --strict` makes it an error.
    expect((await run(doctorCommand, args(root, [], { strict: true }))).code).toBe(1);
  }, SLOW);

  test('a compiled pack whose build record matches its source is examined: no doctor shortfall', async () => {
    const root = compiledPack('fresh-map');
    const json = JSON.parse((await run(doctorCommand, args(root, [], { json: true }))).out) as {
      exitCode: number;
      coverage?: unknown[];
      shortfalls?: string[];
    };
    expect(json.coverage).toBeUndefined();
    expect(json.shortfalls).toBeUndefined();
    expect(json.exitCode).not.toBe(2);
  }, SLOW);
});

// ── 12. packs verbs over an empty scope ─────────────────────────────────────

describe('item 12 — an empty scope settles to 2, with --allow-empty as the valve', () => {
  test('packs signature-status over zero signed packs: 2 + the hint; --allow-empty → 0 accepted', async () => {
    const root = project({});
    const text = await run(packsSignatureStatusCommand, args(root, []));
    expect(text.code).toBe(2);
    expect(text.out).toContain('NOT VERIFIED');
    expect(text.out).toContain('0 signed packs to examine');
    expect(text.out).toContain('Pass --allow-empty');
    const json = JSON.parse((await run(packsSignatureStatusCommand, args(root, [], { json: true }))).out) as {
      exitCode: number;
      verdict: string;
    };
    expect({ exit: json.exitCode, verdict: json.verdict }).toEqual({ exit: 2, verdict: 'not-verified' });
    const accepted = await run(packsSignatureStatusCommand, args(root, [], { 'allow-empty': true }));
    expect(accepted.code).toBe(0);
    expect(accepted.out).toContain('accepted by --allow-empty');
  }, SLOW);

  test('packs test over a manifest that declares no contribution file: 2; --allow-empty → 0', async () => {
    const root = project({
      'mypack/package.json': JSON.stringify({
        name: '@r11/empty',
        version: '0.0.1',
        type: 'module',
        sharkcraft: { manifest: './sharkcraft.plugin.js' },
      }),
      'mypack/sharkcraft.plugin.js':
        "export default { schema: 'sharkcraft.pack/v1', info: { name: '@r11/empty', version: '0.0.1' }, contributions: {} };\n",
    });
    const text = await run(packsTestCommand, args(root, ['mypack']));
    expect(text.code).toBe(2);
    expect(text.out).toContain('NOT VERIFIED');
    expect(text.out).toContain('0 declared contribution files to examine');
    expect(text.out).toContain('Pass --allow-empty');
    const accepted = await run(packsTestCommand, args(root, ['mypack'], { 'allow-empty': true }));
    expect(accepted.code).toBe(0);
  }, SLOW);
});
