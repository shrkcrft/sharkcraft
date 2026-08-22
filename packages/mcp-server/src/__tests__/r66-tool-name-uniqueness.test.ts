/**
 * `ALL_TOOLS` must not register two tools under the same wire name.
 *
 * `create-mcp-server.ts` builds its dispatch table as
 * `new Map(ALL_TOOLS.map((t) => [t.name, t]))` — LAST WINS. A duplicate name
 * therefore compiles green, type-checks green, and ships: `tools/list`
 * advertises the name twice while `tools/call` can only ever reach one of the
 * two implementations. The other tool is silently absent from the wire.
 *
 * This happened twice for real (`list_helpers`, then `get_helper` — the
 * helper-registry tools in `r28-helpers.tool.ts` colliding with the pack-helper
 * tools in `r33-routing-helpers.tool.ts`), and the second one survived the pass
 * that fixed the first. It is exactly the "declared here, registered there"
 * class shrk's own wiring plane exists to catch, so it gets a mechanical guard
 * rather than a convention.
 */
import { describe, expect, test } from 'bun:test';
import { ALL_TOOLS } from '../tools/all-tools.ts';
import { createSharkcraftServer } from '../server/create-mcp-server.ts';
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from '../server/mcp-server-config.ts';

describe('ALL_TOOLS registration integrity', () => {
  test('every wire name is unique', () => {
    const seen = new Map<string, number>();
    for (const tool of ALL_TOOLS) seen.set(tool.name, (seen.get(tool.name) ?? 0) + 1);
    const duplicates = [...seen.entries()]
      .filter(([, count]) => count > 1)
      .map(([name, count]) => `${name} (x${count})`);
    expect(duplicates).toEqual([]);
  });

  test('no tool object is listed twice', () => {
    const seen = new Set<unknown>();
    const repeated: string[] = [];
    for (const tool of ALL_TOOLS) {
      if (seen.has(tool)) repeated.push(tool.name);
      seen.add(tool);
    }
    expect(repeated).toEqual([]);
  });

  test("the REAL server's dispatch table exposes every registered tool", () => {
    // Asserted against the actual construction path, not a re-implementation
    // of it here — the bug was in `toolsByName`, so that is what gets checked.
    const { state } = createSharkcraftServer({
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
      cwd: process.cwd(),
    });
    expect(state.toolsByName.size).toBe(ALL_TOOLS.length);
  });

  test('both helper families are separately reachable', () => {
    // The concrete regression: the helper-registry trio and the pack-helper
    // pair must each keep their own names.
    const names = new Set(ALL_TOOLS.map((t) => t.name));
    for (const n of ['list_helpers', 'get_helper', 'preview_helper_plan']) {
      expect(names.has(n)).toBe(true);
    }
    for (const n of ['list_pack_helpers', 'get_pack_helper']) {
      expect(names.has(n)).toBe(true);
    }
  });
});
