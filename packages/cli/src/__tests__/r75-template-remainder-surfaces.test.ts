/**
 * r75 — a template's declared remainder (`notScaffolded` / `manualSteps`)
 * reaches every machine surface (round 11 review R11-GAP-7, spec 4.6#3).
 *
 * `templates get --json` carried the two fields; MCP `get_template` and the
 * task packet did not, although docs/template-system.md said MCP readers got
 * them — only `create_generation_plan` did. Now `templates get --json` ≡ MCP
 * `get_template` (one shape, `templateRemainderFields`), and a task packet's
 * template rows carry the declared ones (`task --json`, MCP `get_task_packet`).
 *
 * Real temp project, the real template loader, command handlers and the
 * registered MCP tools.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '@shrkcrft/mcp-server';
import { templateRemainderLines } from '@shrkcrft/templates';
import type { ParsedArgs } from '../command-registry.ts';
import { taskCommand } from '../commands/task.command.ts';
import { templatesGetCommand } from '../commands/templates.command.ts';

const SLOW = 120_000;

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
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return { code: await h.run(a), out };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

function tool(name: string): (typeof ALL_TOOLS)[number] {
  const t = ALL_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`MCP tool ${name} is not registered`);
  return t;
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const NOT_SCAFFOLDED = ['build-config'];
const MANUAL_STEPS = [{ description: 'Add the library to the tsconfig path map', covers: ['path-alias'] }];

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-remainder-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx', templateFiles: ['templates.ts'] };\n",
    'sharkcraft/templates.ts': `export default [{
  id: 'workspace.lib',
  name: 'Workspace library',
  description: 'Creates a new workspace library package with an index module.',
  tags: ['workspace', 'library', 'package'],
  scope: ['typescript'],
  appliesWhen: ['generate-code'],
  variables: [{ name: 'name', required: true, description: 'kebab-case name' }],
  targetPath: ({ name }: { name: string }) => \`packages/\${name}/src/index.ts\`,
  content: () => 'export const x = 1;\\n',
  notScaffolded: ${JSON.stringify(NOT_SCAFFOLDED)},
  manualSteps: ${JSON.stringify(MANUAL_STEPS)},
}];
`,
    'src/a.ts': 'export const a = 1;\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

describe('the template remainder on every machine surface (R11-GAP-7)', () => {
  test('`templates get --json` ≡ MCP `get_template`: notScaffolded, manualSteps and the printed remainderLines', async () => {
    const root = project();
    const cli = JSON.parse((await run(templatesGetCommand, args(root, ['workspace.lib'], { json: true }))).out) as Record<
      string,
      unknown
    >;
    const inspection = await inspectSharkcraft({ cwd: root });
    const mcp = (await tool('get_template').handler({ id: 'workspace.lib' }, { inspection, cwd: root })).data as Record<
      string,
      unknown
    >;
    const pick = (o: Record<string, unknown>): Record<string, unknown> => ({
      notScaffolded: o['notScaffolded'],
      manualSteps: o['manualSteps'],
      remainderLines: o['remainderLines'],
    });
    expect(pick(mcp)).toEqual(pick(cli));
    expect(pick(cli)).toEqual({
      notScaffolded: NOT_SCAFFOLDED,
      manualSteps: MANUAL_STEPS,
      remainderLines: [...templateRemainderLines({ notScaffolded: NOT_SCAFFOLDED, manualSteps: MANUAL_STEPS })],
    });
  }, SLOW);

  test("a task packet's template row carries the declared remainder — `task --json` ≡ MCP `get_task_packet`", async () => {
    const root = project();
    const task = 'create a new workspace library package';
    const cli = JSON.parse((await run(taskCommand, args(root, [task], { json: true }))).out) as {
      relevantTemplates: { id: string; notScaffolded?: string[]; manualSteps?: unknown[] }[];
    };
    const inspection = await inspectSharkcraft({ cwd: root });
    const mcp = (await tool('get_task_packet').handler({ task }, { inspection, cwd: root })).data as {
      relevantTemplates: { id: string; notScaffolded?: string[]; manualSteps?: unknown[] }[];
    };
    const cliRow = cli.relevantTemplates.find((t) => t.id === 'workspace.lib');
    const mcpRow = mcp.relevantTemplates.find((t) => t.id === 'workspace.lib');
    expect(cliRow).toMatchObject({ notScaffolded: NOT_SCAFFOLDED, manualSteps: MANUAL_STEPS });
    expect(mcpRow).toEqual(cliRow);
  }, SLOW);
});
