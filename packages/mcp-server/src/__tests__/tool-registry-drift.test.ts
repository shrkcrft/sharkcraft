import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ALL_TOOLS } from '../tools/all-tools.ts';

/**
 * Tool-registry drift guard.
 *
 * Two failure modes have bitten this codebase:
 *
 *   1. ACCIDENTAL DROP — a fully-implemented `export const fooTool` exists in a
 *      `tools/*.tool.ts` file but is missing from the frozen `ALL_TOOLS` array,
 *      so the wire never advertises it. (The `compress_context maxTokens`-style
 *      dead-in-production bug, but for whole tools.)
 *   2. DEAD EXPORT — a tool was intentionally retired from `ALL_TOOLS` but its
 *      export lingered, looking registerable, inviting a "fix" that silently
 *      resurrects a deleted feature.
 *
 * This test enumerates EVERY exported `IToolDefinition` across `tools/*.tool.ts`
 * at runtime and asserts each is either:
 *   - registered in `ALL_TOOLS`, OR
 *   - on the explicit `RETIRED_TOOLS` allowlist (with a reason string).
 *
 * Anything else turns the suite red, so neither failure mode can recur silently.
 *
 * The allowlist is intentionally bidirectional: a retired tool that gets
 * re-registered (without removing its allowlist entry) ALSO fails, forcing the
 * author to reconcile the retirement record (and its CLI-side pruning guards,
 * `packages/cli/src/__tests__/r46-pruning.test.ts` / `r48-pruning.test.ts`)
 * deliberately rather than by accident.
 */

/**
 * Tools that exist as exports but are deliberately NOT wired into `ALL_TOOLS`.
 * Keyed by wire name → the retirement reason. The CLI siblings of every entry
 * here were physically deleted in the same round, so re-registering the MCP
 * tool would advertise a feature whose command surface is gone. Each reason
 * cites the authoritative CLI pruning guard that also asserts the tool's
 * absence.
 */
const RETIRED_TOOLS: Readonly<Record<string, string>> = {
  query_repository_intelligence:
    'Retired in R48 (repository-intelligence universe); CLI sibling `intelligence query` deleted. Asserted absent by cli r48-pruning.test.ts (R48_HARD_DELETED_MCP).',
  simulate_workflow:
    'Retired in R48 — `simulate_plan` covers it; no surviving CLI sibling. Asserted absent by cli r48-pruning.test.ts (R48_HARD_DELETED_MCP).',
  preview_ingest_adoption_plan:
    'Retired in R48 (ingest preview); CLI `ingest adopt *` collapsed into `onboard adopt`. Asserted absent by cli r48-pruning.test.ts (R48_HARD_DELETED_MCP).',
  preview_compliance_evidence_packet:
    'Retired in R46 (PART 2.1 compliance); CLI `compliance evidence` deleted. Asserted absent by cli r46-pruning.test.ts (RETIRED_MCP).',
  list_release_trains:
    'Retired in R46 (PART 2.2 release trains); CLI `train *` deleted. Asserted absent by cli r46-pruning.test.ts (RETIRED_MCP).',
  get_release_train:
    'Retired in R46 (PART 2.2 release trains); CLI `train *` deleted. Asserted absent by cli r46-pruning.test.ts (RETIRED_MCP).',
};

/**
 * HTML-report tools that were not merely de-registered but DELETED from
 * `runtime-reports.tool.ts` (the local dashboard already renders that HTML).
 * They must no longer be defined as exports anywhere under `tools/`.
 */
const DELETED_HTML_TOOLS: readonly string[] = [
  'get_session_html_report',
  'get_quality_html_report',
  'get_safety_html_report',
  'get_review_html_report',
];

const TOOLS_DIR = join(import.meta.dir, '..', 'tools');

interface IExportedTool {
  name: string;
  symbol: string;
  file: string;
}

function isToolDefinition(value: unknown): value is { name: string } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === 'string' &&
    typeof v.description === 'string' &&
    typeof v.inputSchema === 'object' &&
    v.inputSchema !== null &&
    typeof v.handler === 'function'
  );
}

async function collectExportedTools(): Promise<IExportedTool[]> {
  const files = readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.tool.ts'));
  const out: IExportedTool[] = [];
  for (const file of files) {
    const mod = (await import(pathToFileURL(join(TOOLS_DIR, file)).href)) as Record<string, unknown>;
    for (const [symbol, value] of Object.entries(mod)) {
      if (isToolDefinition(value)) out.push({ name: value.name, symbol, file });
    }
  }
  return out;
}

const exportedTools = await collectExportedTools();
const exportedNames = new Set(exportedTools.map((t) => t.name));
const registeredNames = new Set(ALL_TOOLS.map((t) => t.name));

describe('MCP tool-registry drift guard', () => {
  test('the enumeration actually found tools (guard the guard)', () => {
    expect(exportedTools.length).toBeGreaterThan(0);
    // ALL_TOOLS is the union of registered tool objects; it must be a subset of
    // what the source files export (every registered tool is exported somewhere).
    expect(registeredNames.size).toBeGreaterThan(0);
  });

  test('every exported tool is registered in ALL_TOOLS or explicitly retired', () => {
    const orphans = exportedTools.filter(
      (t) => !registeredNames.has(t.name) && !(t.name in RETIRED_TOOLS),
    );
    if (orphans.length > 0) {
      const lines = orphans
        .map((o) => `  - ${o.name} (export ${o.symbol} in tools/${o.file})`)
        .join('\n');
      throw new Error(
        `Tool-registry drift: ${orphans.length} exported IToolDefinition(s) are neither in ` +
          `ALL_TOOLS nor on the RETIRED_TOOLS allowlist:\n${lines}\n` +
          `Either wire each into packages/mcp-server/src/tools/all-tools.ts (accidental drop), ` +
          `or add it to RETIRED_TOOLS here with a reason (intentional retirement).`,
      );
    }
    expect(orphans).toEqual([]);
  });

  test('no retired tool is accidentally registered in ALL_TOOLS', () => {
    const resurrected = Object.keys(RETIRED_TOOLS).filter((name) => registeredNames.has(name));
    if (resurrected.length > 0) {
      throw new Error(
        `Retired tool(s) re-registered without removing the RETIRED_TOOLS entry: ` +
          `${resurrected.join(', ')}. If the re-registration is intentional, remove the ` +
          `allowlist entry AND update the CLI pruning guards (r46/r48-pruning.test.ts).`,
      );
    }
    expect(resurrected).toEqual([]);
  });

  test('every RETIRED_TOOLS entry is a real exported-but-unregistered tool with a reason', () => {
    for (const [name, reason] of Object.entries(RETIRED_TOOLS)) {
      // The allowlist must not go stale: the export must still exist...
      expect(exportedNames.has(name)).toBe(true);
      // ...and it must genuinely be absent from ALL_TOOLS.
      expect(registeredNames.has(name)).toBe(false);
      // ...and carry a non-empty justification.
      expect(typeof reason).toBe('string');
      expect(reason.trim().length).toBeGreaterThan(0);
    }
  });

  test('the four dashboard-duplicate HTML report tools are deleted, not just de-registered', () => {
    for (const name of DELETED_HTML_TOOLS) {
      // No tools/*.tool.ts file may still export them...
      expect(exportedNames.has(name)).toBe(false);
      // ...and they must not be registered.
      expect(registeredNames.has(name)).toBe(false);
      // ...and they must not be quietly parked on the retirement allowlist
      // (the decision was deletion, so there is no lingering export to retire).
      expect(name in RETIRED_TOOLS).toBe(false);
    }
  });
});
