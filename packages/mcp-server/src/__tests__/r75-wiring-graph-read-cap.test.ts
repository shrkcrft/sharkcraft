/**
 * Round 11 (integration review) — MCP `get_wiring_graph` settles against what
 * the registration graph READ.
 *
 * It used to answer `unprovidedCount: 0` over an idiom file the reader never
 * read (over the 1MB cap), where `shrk wiring unprovided` said NOT VERIFIED.
 * Both now read ONE helper (@shrkcrft/boundaries `registrationUnprovidedVerdict`
 * / `registrationOrphansVerdict`): the unread file is named, and an absence it
 * could refute (a provider that may sit in it) is `unproven`, never a finding.
 *
 * Real files over the real cap, the real config loader, the real tool from
 * ALL_TOOLS. MCP stays read-only: nothing is written.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MAX_SCAN_FILE_BYTES } from '@shrkcrft/boundaries';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { clearPackDiscoveryCache } from '@shrkcrft/packs';
import { ALL_TOOLS } from '../tools/index.ts';

const TIMEOUT_MS = 60_000;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
beforeEach(() => clearPackDiscoveryCache());

const IDIOMS =
  "registrationGraph: [ { name: 'di', " +
  "declared: { files: ['src/**/*.ts'], pattern: 'export const ([A-Z_]+) = new InjectionToken' }, " +
  "provided: { files: ['src/prov*.ts'], pattern: 'provide[(]([A-Z_]+)' }, " +
  "consumed: { files: ['src/use*.ts'], pattern: 'inject[(]([A-Z_]+)' } } ]";

/** A real file just over the one reader's cap: `body`, then padding. */
function overCap(body: string): string {
  return `${body}\n// ${'x'.repeat(MAX_SCAN_FILE_BYTES + 16)}\n`;
}

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-mcp-wiring-cap-'));
  roots.push(root);
  const all: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'fx', ${IDIOMS} };\n`,
    'src/tokens.ts': "export const A_TOKEN = new InjectionToken('a');\n",
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

interface IWiringGraphData {
  readonly verdict: string;
  readonly unprovidedCount: number;
  readonly unprovided: readonly { token: string }[];
  readonly unprovidedUnproven?: readonly { token: string }[];
  readonly unread?: readonly { path: string }[];
  readonly shortfall?: string;
  readonly nextCommand: string;
}

async function wiringGraph(root: string): Promise<IWiringGraphData> {
  const tool = ALL_TOOLS.find((t) => t.name === 'get_wiring_graph');
  if (!tool) throw new Error('no get_wiring_graph tool');
  const inspection = await inspectSharkcraft({ cwd: root });
  return (await tool.handler({}, { inspection, cwd: root })).data as IWiringGraphData;
}

describe('get_wiring_graph over an unread idiom file', () => {
  test('a consumer file over the cap: not-verified, the file named — never "unprovidedCount: 0" as a pass', async () => {
    const root = workspace({
      'src/prov.ts': 'provide(A_TOKEN);\n',
      'src/use.ts': 'inject(A_TOKEN);\n',
      'src/use-big.ts': overCap('inject(C_TOKEN);'),
    });
    const before = readdirSync(root).sort();
    const data = await wiringGraph(root);
    expect({ verdict: data.verdict, unprovidedCount: data.unprovidedCount }).toEqual({
      verdict: 'not-verified',
      unprovidedCount: 0,
    });
    expect(data.unread?.map((u) => u.path)).toEqual(['src/use-big.ts']);
    expect(data.shortfall).toContain('src/use-big.ts');
    expect(data.shortfall).toContain('over the 1MB read cap');
    expect(data.nextCommand).toContain('shrk wiring unprovided');
    // Read-only: nothing written.
    expect(readdirSync(root).sort()).toEqual(before);
  }, TIMEOUT_MS);

  test('control: the same consumer in a small file IS read — C_TOKEN is unprovided, verdict fail, no unread key', async () => {
    const root = workspace({
      'src/prov.ts': 'provide(A_TOKEN);\n',
      'src/use.ts': 'inject(A_TOKEN);\n',
      'src/use-big.ts': 'inject(C_TOKEN);\n',
    });
    const data = await wiringGraph(root);
    expect({ verdict: data.verdict, tokens: data.unprovided.map((u) => u.token) }).toEqual({
      verdict: 'fail',
      tokens: ['C_TOKEN'],
    });
    expect(data.unread).toBeUndefined();
  }, TIMEOUT_MS);

  test('the only provider sits in a file over the cap: A_TOKEN is unproven, not unprovided', async () => {
    const root = workspace({
      'src/use.ts': 'inject(A_TOKEN);\n',
      'src/prov-big.ts': overCap('provide(A_TOKEN);'),
    });
    const data = await wiringGraph(root);
    expect({ verdict: data.verdict, unprovidedCount: data.unprovidedCount }).toEqual({
      verdict: 'not-verified',
      unprovidedCount: 0,
    });
    expect(data.unprovidedUnproven?.map((u) => u.token)).toEqual(['A_TOKEN']);
    expect(data.shortfall).toContain('A_TOKEN');
    expect(data.shortfall).toContain('src/prov-big.ts');
  }, TIMEOUT_MS);
});
