/**
 * Round 11 (C#one-boundary-check-authority / C#severity-default) — every
 * boundary surface gives ONE answer.
 *
 * The MCP `check_boundaries` and `get_changed_boundary_report` tools used to
 * hand-assemble scan + evaluate WITHOUT the tsconfig alias map, so a violation
 * `shrk check boundaries` reported through an alias was invisible to an agent;
 * and `boundaries list / get / explain` rendered an unset severity as
 * `warning` while the evaluator enforced it as `error`. All of them now route
 * through `runBoundaryCheck` / `boundaryRuleSeverity`.
 *
 * Real temp project, real tsconfig paths, a real sharkcraft/boundaries.ts, the
 * real registered MCP handlers and the real command handlers.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '@shrkcrft/mcp-server';
import { checkCommand } from '../commands/check.command.ts';
import { boundariesExplainCommand } from '../commands/boundaries.command.ts';
import { runFinishGates } from '../finish/run-finish.ts';
import type { ParsedArgs } from '../command-registry.ts';

function args(root: string, positional: string[], flags: Record<string, string | boolean> = {}): ParsedArgs {
  return {
    positional,
    flags: new Map<string, string | boolean>([['cwd', root], ...Object.entries(flags)]),
    multiFlags: new Map(),
  };
}

async function run(h: { run(a: ParsedArgs): Promise<number> | number }, a: ParsedArgs): Promise<{ code: number; out: string }> {
  const orig = process.stdout.write.bind(process.stdout);
  let out = '';
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    out += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    return { code: await h.run(a), out };
  } finally {
    process.stdout.write = orig;
  }
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** core must not reach ui — core imports it through a tsconfig alias. The rule sets NO severity. */
function aliasProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-parity-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@app/ui': ['packages/ui/src/index.ts'] } } }),
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx', boundaryFiles: ['boundaries.ts'] };\n",
    'sharkcraft/boundaries.ts':
      "export default [{ id: 'core.no-ui', title: 'core must not import ui', from: ['packages/core/**'], forbiddenImports: ['packages/ui/**'] }];\n",
    'packages/core/a.ts': "import { Button } from '@app/ui';\nexport const a = Button;\n",
    'packages/ui/src/index.ts': 'export const Button = 1;\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const tool = (name: string) => {
  const t = ALL_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`MCP tool ${name} is not registered`);
  return t;
};

type Violation = { file: string; line: number; importSpecifier: string; resolvedVia?: string };
const keyOf = (v: Violation): string => `${v.file}:${v.line} ${v.importSpecifier} via ${v.resolvedVia ?? '-'}`;

describe('CLI, both MCP boundary tools and finish report ONE violation set and ONE verdict', () => {
  test('including the alias-resolved violation the MCP tools used to miss', async () => {
    const root = aliasProject();
    const cli = await run(checkCommand, args(root, ['boundaries'], { json: true }));
    const cliJson = JSON.parse(cli.out) as { violations: Violation[]; gate: { exit: number } };
    const expected = ['packages/core/a.ts:1 @app/ui via packages/ui/src/index.ts'];
    expect(cliJson.violations.map(keyOf)).toEqual(expected);
    expect(cli.code).toBe(1);
    expect(cliJson.gate.exit).toBe(1);

    const inspection = await inspectSharkcraft({ cwd: root });
    const ctx = { inspection, cwd: root };
    const full = (await tool('check_boundaries').handler({}, ctx)).data as {
      violations: Violation[];
      verdict: string;
      exitCode: number;
    };
    expect(full.violations.map(keyOf)).toEqual(expected);
    expect({ verdict: full.verdict, exitCode: full.exitCode }).toEqual({ verdict: 'fail', exitCode: cli.code });

    const changed = (await tool('get_changed_boundary_report').handler({ files: ['packages/core/a.ts'] }, ctx)).data as {
      typescript: { included: Violation[]; verdict: string; exitCode: number };
    };
    expect(changed.typescript.included.map(keyOf)).toEqual(expected);
    expect(changed.typescript.verdict).toBe('fail');

    const finish = await runFinishGates({
      cwd: root,
      mode: 'files',
      scope: { projectRoot: root, files: ['packages/core/a.ts'] },
    });
    const gate = finish.gates.find((g) => g.name === 'boundaries')!;
    expect(gate.status).toBe('fail');
    expect(gate.items.map((i) => `${i.file}:${i.line}`)).toEqual(['packages/core/a.ts:1']);
    expect(finish.exit).toBe(1);
  });

  test('the MCP boundary handlers write nothing', async () => {
    const root = aliasProject();
    const snapshot = (): string[] => {
      const out: string[] = [];
      const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
          const p = join(dir, name);
          const s = statSync(p);
          if (s.isDirectory()) walk(p);
          else out.push(`${relative(root, p)} ${s.size} ${s.mtimeMs}`);
        }
      };
      walk(root);
      return out.sort();
    };
    const inspection = await inspectSharkcraft({ cwd: root });
    const before = snapshot();
    const ctx = { inspection, cwd: root };
    await tool('check_boundaries').handler({}, ctx);
    await tool('check_boundaries').handler({ ruleId: 'core.no-ui' }, ctx);
    await tool('get_changed_boundary_report').handler({ files: ['packages/core/a.ts'] }, ctx);
    await tool('get_diff_check_report').handler({ files: ['packages/core/a.ts'] }, ctx);
    expect(snapshot()).toEqual(before);
  });
});

describe('an unset severity is `error` everywhere (C#severity-default)', () => {
  test('`boundaries explain --json` shows the severity the evaluator enforces', async () => {
    const root = aliasProject();
    const explain = JSON.parse((await run(boundariesExplainCommand, args(root, ['core.no-ui'], { json: true }))).out);
    const cli = JSON.parse((await run(checkCommand, args(root, ['boundaries'], { json: true }))).out) as {
      violations: { severity: string }[];
    };
    expect(explain.severity).toBe('error');
    expect(explain.severity).toBe(cli.violations[0]!.severity);
  });

  test('grep lock: no boundary-rule call site defaults severity to "warning"', () => {
    const repo = resolve(import.meta.dir, '..', '..', '..', '..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith('.ts')) {
          const text = readFileSync(p, 'utf8');
          if (!text.includes('boundaryRegistry') && !text.includes('@shrkcrft/boundaries')) continue;
          text.split('\n').forEach((line, i) => {
            if (/severity\s*\?\?\s*['"]warning['"]/.test(line)) offenders.push(`${relative(repo, p)}:${i + 1}`);
          });
        }
      }
    };
    for (const pkg of readdirSync(join(repo, 'packages'))) {
      const src = join(repo, 'packages', pkg, 'src');
      try {
        if (statSync(src).isDirectory()) walk(src);
      } catch {
        // a package without src/ has nothing to lock
      }
    }
    expect(offenders).toEqual([]);
  });
});
