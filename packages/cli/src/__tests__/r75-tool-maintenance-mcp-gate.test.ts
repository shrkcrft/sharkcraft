/**
 * r75 — every MCP tool whose CLI sibling is a tool-maintenance command is
 * gated like its sibling (round 11 review MCP-2).
 *
 * `get_release_smoke_report` / `get_install_smoke_report` declared no
 * `cliCommand`, so the MCP gate never saw them: they were served in a consumer
 * repo while the CLI refused `release smoke` / `install smoke` (78). The lock
 * is derived from the catalog, so a new tool-maintenance row that claims
 * `mcpAvailable` cannot ship without a gated tool.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ALL_TOOLS } from '@shrkcrft/mcp-server';
import { CommandAudience, COMMAND_CATALOG } from '../commands/command-catalog.ts';
import { buildMcpGateResolver } from '../commands/mcp.command.ts';
import { buildRegistry } from '../main.ts';
import { cleanCommandPath, setActiveCommandRegistry } from '../surface/command-index.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const roots: string[] = [];
afterAll(() => {
  setActiveCommandRegistry(undefined);
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function consumer(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-tmgate-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'consumer-app', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'consumer-app' };\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

/** Base catalog rows (no flag variants) tagged tool-maintenance that claim an MCP tool. */
const ROWS = COMMAND_CATALOG.filter(
  (e) =>
    (e.intendedAudience ?? []).includes(CommandAudience.ToolMaintenance) &&
    e.mcpAvailable === true &&
    cleanCommandPath(e.command) === e.command,
);

describe('tool-maintenance MCP tools are gated like their CLI siblings', () => {
  test('every mcpAvailable tool-maintenance row names at least one MCP tool (cliCommand)', () => {
    expect(ROWS.length).toBeGreaterThan(0);
    const unbacked = ROWS.filter((r) => !ALL_TOOLS.some((t) => t.cliCommand === r.command)).map((r) => r.command);
    expect(unbacked).toEqual([]);
    const byName = new Map(ALL_TOOLS.map((t) => [t.name, t.cliCommand]));
    expect(byName.get('get_release_smoke_report')).toBe('release smoke');
    expect(byName.get('get_install_smoke_report')).toBe('install smoke');
  });

  test('each such tool is refused in a consumer repo and callable in the SharkCraft repo', async () => {
    setActiveCommandRegistry(buildRegistry());
    const tools = ALL_TOOLS.filter((t) => ROWS.some((r) => r.command === t.cliCommand));
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['get_release_smoke_report', 'get_install_smoke_report', 'get_docs_check']),
    );
    const inConsumer = await buildMcpGateResolver(consumer());
    expect(inConsumer).toBeDefined();
    const inRepo = await buildMcpGateResolver(REPO_ROOT);
    const refused = tools.filter((t) => inConsumer!(t) !== null).map((t) => t.name).sort();
    expect(refused).toEqual(tools.map((t) => t.name).sort());
    const refusedInRepo = tools.filter((t) => (inRepo ? inRepo(t) : null) !== null).map((t) => t.name);
    expect(refusedInRepo).toEqual([]);
  }, 120_000);
});
