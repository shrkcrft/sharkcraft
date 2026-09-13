/**
 * r75 — the self-config doctor's command-string coverage row names a reason
 * ONLY when there is a gap (round 11 review MCP-7).
 *
 * The row carried "command index not injected — NOT VERIFIED" unconditionally,
 * so the CLI's fully verified run (examined == expected) told JSON readers it
 * was not verified. With the CLI's command index injected every string is
 * resolved and the row has no reason; the bare (MCP) path examines none and
 * keeps it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildSelfConfigDoctorReportV2, COMMAND_INDEX_NOT_INJECTED, inspectSharkcraft } from '@shrkcrft/inspector';
import { buildRegistry } from '../main.ts';
import { warmCliReferenceRegistries } from '../surface/cli-command-resolver.ts';
import { setActiveCommandRegistry } from '../surface/command-index.ts';

const roots: string[] = [];
afterAll(() => {
  setActiveCommandRegistry(undefined);
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-probe-reason-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx' };\n",
    'sharkcraft/task-routing-hints.ts':
      "export default [{ id: 'h.cmds', title: 'Command hint', match: { keywords: ['cmds'] }, recommends: { commands: ['shrk doctor', 'shrk no-such-verb'] } }];\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

type Row = { unit: string; expected: number; examined: number; reason?: string };
const commandRow = (coverage: readonly Row[]): Row | undefined => coverage.find((c) => c.unit === 'command strings');

describe('self-config doctor — the command-strings row', () => {
  test('CLI (index injected): every string examined, NO reason; bare (MCP): none examined, the reason names why', async () => {
    const root = fixture();
    setActiveCommandRegistry(buildRegistry());
    const cli = await inspectSharkcraft({ cwd: root });
    await warmCliReferenceRegistries(cli);
    const cliRow = commandRow((await buildSelfConfigDoctorReportV2(cli)).coverage as readonly Row[]);
    expect(cliRow).toBeDefined();
    expect(cliRow!.examined).toBe(cliRow!.expected);
    expect(cliRow!.reason).toBeUndefined();

    const bare = await inspectSharkcraft({ cwd: root });
    const bareRow = commandRow((await buildSelfConfigDoctorReportV2(bare)).coverage as readonly Row[]);
    expect(bareRow).toBeDefined();
    expect(bareRow!.examined).toBeLessThan(bareRow!.expected);
    expect(bareRow!.reason).toBe(COMMAND_INDEX_NOT_INJECTED);
  }, 60_000);
});
