/**
 * r75 — `shrk recommend` renders THE ranked list (spec 2.1 / 2.1#2 / 2.1#3 /
 * 2.1#4 / 2.2), from the CLI spawned from source over a real fixture.
 *
 *   - a no-confident-match query says so ("No confident match") and never
 *     prints the confident "=== Recommended commands" heading;
 *   - `--require-confident` turns "no confident match" into a branchable 2
 *     (and global `--strict` into 1); a confident answer stays 0;
 *   - `--json` nextCommand is the first rendered row (planning and hint rows);
 *   - `--verbose` shows the matched hint and its commands (the old "Best
 *     actions" section read fields the search hit does not have and printed
 *     an empty header);
 *   - MCP `recommend_commands` returns the SAME commands as the CLI;
 *   - `shrk context` Top commands carry the hint's commands, attributed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '@shrkcrft/mcp-server';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const SPAWN_TIMEOUT_MS = 120_000;

let root = '';

function shrk(argv: readonly string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('bun', ['run', CLI_MAIN, ...argv], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

interface IRecommendJson {
  recommendations: { command: string; source?: string; sourceId?: string; weak?: boolean }[];
  nextCommand: string;
  confident: boolean;
  verdict: string;
  gated: { command: string }[];
  routingMatches: { hint: { id: string } }[];
  search: { sections: { bestActions: { id: string; nextCommand?: string }[] } } | null;
  rankerMatch: { topTemplate: { id: string } | null; topPipeline: { id: string } | null } | null;
  exitCode?: number;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'shrk-r75-recrender-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'r75-recrender', version: '0.0.0', private: true }),
    'src/billing/index.ts': 'export const billing = 1;\n',
    'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'r75-recrender', templateFiles: ['templates.ts'], pipelineFiles: ['pipelines.ts'] };\n`,
    'sharkcraft/templates.ts': `export default [{
  id: 'billing.feature',
  name: 'Billing feature module',
  description: 'Creates a billing feature module under src/billing/.',
  tags: ['billing', 'feature'],
  scope: ['typescript'],
  appliesWhen: ['generate-code'],
  variables: [{ name: 'name', required: true, description: 'kebab-case name' }],
  targetPath: ({ name }: { name: string }) => \`src/billing/\${name}.ts\`,
  content: () => 'export const x = 1;\\n',
}];
`,
    'sharkcraft/pipelines.ts': `export default [{
  id: 'billing-create-feature',
  title: 'Billing: create new feature',
  description: 'Scaffold a new billing feature module with service, route and tests.',
  tags: ['feature', 'generation', 'billing'],
  inputs: [{ name: 'task', required: true }],
  steps: [{ id: 'billing-scaffold', type: 'generate', references: ['billing.feature'], description: 'Generate the billing feature skeleton.' }],
}];
`,
    'sharkcraft/task-routing-hints.ts': `export default [
  { id: 'pricing-block', title: 'Pricing block kind (create)', match: { keywords: ['pricing', 'block'] }, recommends: { commands: ['shrk gen pricing.block <name> --dry-run'] } },
  { id: 'billing-refactor', title: 'Billing refactor playbook', match: { keywords: ['billing', 'refactor'], phrases: ['billing module'] }, recommends: { commands: ['shrk graph importers src/billing/index.ts', 'shrk check orphans'] } },
  { id: 'billing-analyze', title: 'Billing dependency analysis', match: { keywords: ['billing', 'dependencies'], phrases: ['billing dependencies'] }, recommends: { commands: ['shrk graph hubs --scope src/billing'] } },
  { id: 'boundary-repair', title: 'Repair a boundary violation', match: { keywords: ['boundary', 'violation'], phrases: ['boundary violation'] }, recommends: { commands: ['shrk check boundaries --explain'] } },
];
`,
  };
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('r75 recommend — human render of THE list', () => {
  test(
    'no confident match: says so, lists weak candidates, never the confident heading; --require-confident → 2, --strict → 1',
    () => {
      const text = shrk(['recommend', 'add a table']);
      expect(text.status).toBe(0);
      expect(text.stdout).toContain('No confident match');
      expect(text.stdout).not.toContain('=== Recommended commands');
      expect(text.stdout).toContain('⚠ Coverage gap');
      expect(text.stdout).not.toMatch(/^\s+\$ shrk gen /m);
      expect(shrk(['recommend', 'add a table', '--require-confident']).status).toBe(2);
      expect(shrk(['recommend', 'add a table', '--require-confident', '--strict']).status).toBe(1);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    'a confident hint answer headlines the hint, attributed, and --require-confident stays 0',
    () => {
      const res = shrk(['recommend', 'refactor the billing module', '--require-confident']);
      expect(res.status).toBe(0);
      const lines = res.stdout.split('\n');
      const heading = lines.findIndex((l) => l.startsWith('=== Recommended commands'));
      expect(heading).toBeGreaterThanOrEqual(0);
      expect(lines[heading + 1]).toBe(
        '  $ shrk graph importers src/billing/index.ts  [read-only] — routing hint "billing-refactor" (score 7, floor 3)',
      );
      // The scaffold is suppressed, and the suppression is printed — never silent.
      expect(res.stdout).toMatch(/suppressed: shrk gen billing\.feature <name> --dry-run — writes source/);
      expect(res.stdout).not.toContain('Coverage gap');
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    '--verbose shows the matched hint with its commands (no empty "Best actions" header)',
    () => {
      const res = shrk(['recommend', 'refactor the billing module', '--verbose']);
      expect(res.stdout).toContain('billing-refactor');
      expect(res.stdout).toContain('shrk graph importers');
      expect(res.stdout).toContain('commands: shrk graph importers src/billing/index.ts · shrk check orphans');
      expect(res.stdout).not.toContain('Best actions (from universal search):');
    },
    SPAWN_TIMEOUT_MS,
  );

  test('lock: no phantom-cast read of the search hit in recommend.command.ts', () => {
    const src = readFileSync(join(REPO_ROOT, 'packages/cli/src/commands/recommend.command.ts'), 'utf8');
    expect(src).not.toContain('as { action?');
    expect(src).not.toContain('ROUTING_HINT_PROMOTE_THRESHOLD');
    expect(src).not.toContain('CREATE_BUILD_VERBS');
  });

  test(
    'an invalid --min-score is a usage error (3)',
    () => {
      expect(shrk(['recommend', 'refactor the billing module', '--min-score', '0']).status).toBe(3);
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe('r75 recommend --json — nextCommand is the first rendered row', () => {
  test(
    'planning query: grounding is row 1 and the next command',
    () => {
      const json = JSON.parse(shrk(['recommend', 'analyze the billing dependencies', '--json']).stdout) as IRecommendJson;
      expect(json.recommendations[0]!.command).toBe('shrk grounding "analyze the billing dependencies" --json');
      expect(json.nextCommand).toBe(json.recommendations[0]!.command);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    'hint-promoted create query: the hint command is row 1 and the next command; the evidence keys stay',
    () => {
      const json = JSON.parse(shrk(['recommend', 'add a pricing block kind', '--json']).stdout) as IRecommendJson;
      expect(json.recommendations[0]!.command).toBe('shrk gen pricing.block <name> --dry-run');
      expect(json.recommendations[0]!.source).toBe('routing-hint');
      expect(json.nextCommand).toBe(json.recommendations[0]!.command);
      expect(json.confident).toBe(true);
      expect(json.verdict).toBe('confident');
      expect(json.routingMatches[0]!.hint.id).toBe('pricing-block');
      expect(json.search!.sections.bestActions.some((a) => a.id === 'pricing-block')).toBe(true);
      expect('rankerMatch' in json).toBe(true);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    '--require-confident --json carries the exit code it returns',
    () => {
      const res = shrk(['recommend', 'add a table', '--json', '--require-confident']);
      expect(res.status).toBe(2);
      const json = JSON.parse(res.stdout) as IRecommendJson;
      expect(json.confident).toBe(false);
      expect(json.exitCode).toBe(2);
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe('r75 recommend — MCP and context read the same list', () => {
  test(
    'PARITY: MCP recommend_commands returns the CLI --json commands (minus surface-gated rows)',
    async () => {
      const tool = ALL_TOOLS.find((t) => t.name === 'recommend_commands');
      expect(tool).toBeDefined();
      const inspection = await inspectSharkcraft({ cwd: root });
      for (const q of [
        'add a pricing block kind',
        'refactor the billing module',
        'analyze the billing dependencies',
        'fix the boundary violation in billing',
      ]) {
        const cli = JSON.parse(shrk(['recommend', q, '--json']).stdout) as IRecommendJson;
        const res = (await tool!.handler({ query: q }, { inspection, cwd: root })) as {
          data: { recommendations: { command: string }[]; confident: boolean };
        };
        const gated = new Set(cli.gated.map((g) => g.command));
        const mcp = res.data.recommendations.map((r) => r.command).filter((c) => !gated.has(c));
        expect({ q, commands: mcp }).toEqual({ q, commands: cli.recommendations.map((r) => r.command) });
        expect(res.data.confident).toBe(cli.confident);
      }
    },
    SPAWN_TIMEOUT_MS * 2,
  );

  test(
    '`shrk context` Top commands carry the matched hint\'s commands, attributed',
    () => {
      const res = shrk(['context', '--task', 'refactor the billing module', '--summary']);
      expect(res.stdout).toContain(
        '  $ shrk graph importers src/billing/index.ts  — routing hint "billing-refactor" (score 7, floor 3)',
      );
    },
    SPAWN_TIMEOUT_MS,
  );
});
