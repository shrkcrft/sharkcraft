import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');

function shrk(args: readonly string[], cwd: string) {
  const res = spawnSync('bun', ['run', CLI_MAIN, ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout?.toString() ?? '',
    stderr: res.stderr?.toString() ?? '',
  };
}

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-drift-safety-'));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  mkdirSync(join(root, 'sharkcraft', 'node_modules', '@shrkcrft'), { recursive: true });
  for (const [n, t] of [
    ['config', 'packages/config'],
    ['knowledge', 'packages/knowledge'],
    ['templates', 'packages/templates'],
  ] as const) {
    spawnSync('ln', ['-s', join(REPO_ROOT, t), join(root, 'sharkcraft', 'node_modules', '@shrkcrft', n)]);
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'q', version: '0.0.0' }));
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    `export default { projectName: 'q', knowledgeFiles: [], ruleFiles: [], pathFiles: [], templateFiles: [], docsFiles: [] };\n`,
  );
  return root;
}

interface IQualityJson {
  readonly items: {
    id: string;
    status: string;
    severity: string;
    repro: string;
    data?: Record<string, unknown>;
  }[];
}

describe('shrk quality drift gate', () => {
  test('json output includes a drift gate carrying its own counts', () => {
    const root = makeFixture();
    const r = shrk(['--cwd', root, 'quality', '--json'], root);
    const out = JSON.parse(r.stdout) as IQualityJson;
    const drift = out.items.find((g) => g.id === 'drift');
    expect(drift).toBeDefined();
    // The gate's payload rides on the gate, not on a one-off top-level key —
    // otherwise every new gate has to negotiate its own field with consumers.
    expect(drift!.data).toBeDefined();
    expect(typeof drift!.data!['errors']).toBe('number');
  });

  test('--require-drift-clean makes the drift gate blocking', () => {
    const root = makeFixture();
    const r = shrk(['--cwd', root, 'quality', '--require-drift-clean', '--json'], root);
    const out = JSON.parse(r.stdout) as IQualityJson;
    expect(out.items.find((g) => g.id === 'drift')!.severity).toBe('error');
  });

  test('every gate names the command that reproduces it alone', () => {
    const root = makeFixture();
    const r = shrk(['--cwd', root, 'quality', '--json'], root);
    const out = JSON.parse(r.stdout) as IQualityJson;
    expect(out.items.length).toBeGreaterThan(1);
    for (const item of out.items) expect(item.repro.startsWith('shrk ')).toBe(true);
  });
});

describe('shrk safety audit', () => {
  test('json output exposes commands grouped by safety level', () => {
    const root = makeFixture();
    const r = shrk(['--cwd', root, 'safety', 'audit', '--json'], root);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as {
      mcp: { anyWritable: boolean; tools: { name: string }[] };
      commands: { writesSource: unknown[] };
      recommendations: string[];
    };
    expect(out.mcp.anyWritable).toBe(false);
    expect(out.mcp.tools.length).toBeGreaterThan(0);
    expect(Array.isArray(out.commands.writesSource)).toBe(true);
  });
});

describe('shrk commands doctor', () => {
  // Round 11 §5.1: `commands doctor` audits SharkCraft's OWN command catalog —
  // a tool-maintenance command. It runs where its object lives (the SharkCraft
  // repo); in a consumer fixture like makeFixture() it is gated, exit 78.
  test('json output reports passed=true with no errors (in the SharkCraft repo)', () => {
    const r = shrk(['--cwd', REPO_ROOT, 'commands', 'doctor', '--json'], REPO_ROOT);
    const out = JSON.parse(r.stdout) as {
      passed: boolean;
      summary: { errors: number };
    };
    expect(out.summary.errors).toBe(0);
    expect(out.passed).toBe(true);
  });

  test('in a consumer repo it is gated (exit 78), never a failing check', () => {
    const root = makeFixture();
    const r = shrk(['--cwd', root, 'commands', 'doctor', '--json'], root);
    expect(r.status).toBe(78);
    // Round 11 docs review (intentional): under `--json` the refusal is the
    // documented machine body on stdout — schema + reasonCode — instead of the
    // text on stderr (the gate used to print the text alone, so `--json` read
    // zero bytes).
    const body = JSON.parse(r.stdout) as { schema: string; reasonCode: string; reason: string };
    expect(body.schema).toBe('sharkcraft.surface.not-enabled.v1');
    expect(body.reasonCode).toBe('tool-maintenance');
    expect(body.reason).toContain('maintains SharkCraft itself');
  });
});
