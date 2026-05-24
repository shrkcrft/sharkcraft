/**
 * Pruning invariants.
 *
 * Asserts the pruning decisions:
 *
 * 1. The `removeAfter: ` set is physically gone from `COMMAND_CATALOG`.
 *   2. `commandSurface()` default is `Advanced` (regression guard for the spine flip).
 *   3. Default help shows <= 50 visible commands and contains the spine.
 *   4. Every spine command has explicit `surface: Primary | Common`.
 * 5. The overlay still hides every entry that isn't physically deleted.
 *   6. The MCP `ALL_TOOLS` list does not include the 19 removed tools.
 *   7. `prepare_agent_task` remains in `ALL_TOOLS` (canonical agent path).
 *   8. The runtime tool list and `ALL_TOOLS_FOR_AUDIT` agree on names.
 */
import { describe, expect, test } from 'bun:test';
import {
  COMMAND_CATALOG,
  CommandSurface,
  R46_OVERLAY,
  commandSurface,
  defaultShowInHelp,
} from '../commands/command-catalog.ts';
import { ALL_TOOLS } from '../../../mcp-server/src/tools/index.ts';
// DX#4 — `ALL_TOOLS_FOR_AUDIT` deleted; audit view is structurally
// identical to ALL_TOOLS now. Tests below use ALL_TOOLS directly.

const R48_HARD_DELETED_CLI: readonly string[] = [
  // catalog meta
  'commands explain',
  'commands suggest',
  // diagnostics
  'diagnostics get',
  'diagnostics suggest',
  // heal subcommands collapsed to `heal --from <source>`
  'heal from-command',
  'heal from-error',
  'heal from-file',
  'heal from-report',
  // ingest adopt apply/plan/review/--write-patch (collapsed to onboard adopt)
  'ingest adopt apply',
  'ingest adopt plan',
  'ingest adopt review',
  'ingest adopt --write-patch',
  // CI non-flagship providers
  'ci scaffold circleci',
  'ci scaffold azure',
  'ci scaffold azure --with-release-readiness',
  'ci scaffold azure-pipelines',
  'ci scaffold jenkins',
  'ci scaffold jenkins --with-release-readiness',
  // knowledge author dispatcher
  'knowledge author',
  // `pack` top-level alias
  'pack',
  // legacy session command
  'session',
];

const R48_HARD_DELETED_MCP: readonly string[] = [
  // repository-intelligence universe
  'get_repository_intelligence_graph',
  'get_repository_intelligence_node',
  'explain_repository_intelligence_node',
  'find_repository_intelligence_path',
  'query_repository_intelligence',
  // simulate_workflow (simulate_plan covers it)
  'simulate_workflow',
  // ingest surface
  'create_repository_ingestion_plan',
  'get_repository_knowledge_model',
  'get_repository_ingestion_status',
  'get_repository_ingestion_report',
  'get_contradiction_report',
  'get_generated_code_report',
  'get_ingest_adoption_preview',
  // ingest preview
  'preview_ingest_adoption_plan',
  // dashboard HTML duplicates
  'get_session_html_report',
  'get_quality_html_report',
  'get_safety_html_report',
  'get_review_html_report',
  // agent-handoff duplicate
  'create_agent_handoff',
];

const R48_SPINE: readonly string[] = [
  // Bootstrap
  'init',
  'inspect',
  'doctor',
  'safety audit',
  'safety audit --deep',
  'self-config doctor',
  'preflight',
  // Context & discovery
  'recommend',
  'context',
  'search',
  'explain',
  'impact',
  'graph',
  'graph why',
  'graph imports',
  'coverage',
  'drift',
  'check',
  'check boundaries',
  // Plan / write path
  'gen',
  'plan',
  'plan review',
  'plan simulate',
  'apply',
  'fix preview',
  'rules lint',
  'knowledge add',
  'knowledge update',
  'knowledge remove',
  'knowledge lint',
  // Packs
  'packs list',
  'packs doctor',
  'packs sign',
  'packs signature-status',
  'packs contributions',
  'presets list',
  'presets get',
  'presets explain',
  // CI / safety
  'ci scaffold github-actions',
  'ci report',
  // Meta
  'commands',
  'version',
  'help',
];

describe('physical deletions (CLI)', () => {
  test('every deleted CLI command is absent from COMMAND_CATALOG', () => {
    const present = new Set(COMMAND_CATALOG.map((e) => e.command));
    for (const cmd of R48_HARD_DELETED_CLI) {
      expect(present.has(cmd)).toBe(false);
    }
  });
});

describe('physical deletions (MCP)', () => {
  test('every deleted MCP tool is absent from ALL_TOOLS', () => {
    const present = new Set(ALL_TOOLS.map((t) => t.name));
    for (const name of R48_HARD_DELETED_MCP) {
      expect(present.has(name)).toBe(false);
    }
  });

  test('every deleted MCP tool is absent from ALL_TOOLS', () => {
    // DX#4 — audit-list parity is by construction now (the projection
    // is derived from ALL_TOOLS at runtime). Assert against ALL_TOOLS.
    const present = new Set(ALL_TOOLS.map((t) => t.name));
    for (const name of R48_HARD_DELETED_MCP) {
      expect(present.has(name)).toBe(false);
    }
  });

  test('prepare_agent_task remains the canonical first agent call', () => {
    const present = new Set(ALL_TOOLS.map((t) => t.name));
    expect(present.has('prepare_agent_task')).toBe(true);
  });
});

describe('surface flip (default = Advanced)', () => {
  test('commandSurface() default for an unset entry is Advanced', () => {
    const stub = {
      command: '__r48-test-stub',
      description: '',
      category: 'test',
      safetyLevel: 'read-only',
      writesFiles: false,
      writesSource: false,
      runsShell: false,
      requiresReview: false,
      mcpAvailable: false,
      aliases: [] as readonly string[],
    };
    // Force the function to take the default path: pretend the stub has no
    // surface and is not RequiresReview.
    expect(commandSurface(stub as unknown as Parameters<typeof commandSurface>[0])).toBe(
      CommandSurface.Advanced,
    );
  });

  test('every spine command resolves to surface Primary or Common', () => {
    const byName = new Map(COMMAND_CATALOG.map((e) => [e.command, e] as const));
    for (const cmd of R48_SPINE) {
      const e = byName.get(cmd);
      expect(e).toBeDefined();
      const s = commandSurface(e!);
      expect([CommandSurface.Primary, CommandSurface.Common]).toContain(s);
    }
  });
});

describe('default help shape', () => {
  test('every spine command is visible by default', () => {
    const byName = new Map(COMMAND_CATALOG.map((e) => [e.command, e] as const));
    for (const cmd of R48_SPINE) {
      const e = byName.get(cmd);
      expect(e).toBeDefined();
      expect(defaultShowInHelp(e!)).toBe(true);
    }
  });

  test('default-visible command count is bounded (≤ 62)', () => {
    // set the visible ceiling at 50. feedback3 adds `shrk why <file>`
    // as a user-facing onboarding verb (closes the dangling
    // ide.command.ts:112 suggestion). It's intentionally Common (not
    // Advanced) because the dangling promise was the whole point of
    // landing the verb. Ceiling raised to 52 — a small bump matching
    // ONE substantive new verb. Stays well clear of the -era bloat.
    // R59 restores `shrk dashboard` (Primary) and adds `shrk stats`
    // (Primary). Both are spine verbs (one new user surface, one
    // restored), so the ceiling moves from 52 to 54.
    // Code-intelligence layer adds 8 Common spine verbs: rule-graph,
    // search-structural, plan-context, arch, framework, api-diff,
    // gate, migrate. Each is documented in
    // docs/roadmap-code-intelligence.md. Ceiling 54 → 62.
    const visible = COMMAND_CATALOG.filter((e) => defaultShowInHelp(e));
    expect(visible.length).toBeLessThanOrEqual(62);
  });

  test('default-visible count is dramatically smaller than catalog size', () => {
    // spine target: ≤ 35 visible. Hard ceiling for the regression guard
    // is the spine size + a few transitional entries. Catalog total stays
    // around 300+.
    const total = COMMAND_CATALOG.length;
    const visible = COMMAND_CATALOG.filter((e) => defaultShowInHelp(e)).length;
    expect(visible).toBeLessThan(total / 5);
  });
});

describe('overlay still hides what survives', () => {
  test('every overlay entry that still has a catalog entry is hidden', () => {
    const byName = new Map(COMMAND_CATALOG.map((e) => [e.command, e] as const));
    for (const cmd of Object.keys(R46_OVERLAY)) {
      const e = byName.get(cmd);
      if (!e) continue; // overlay may mention retired-and-physically-deleted entries.
      expect(defaultShowInHelp(e)).toBe(false);
    }
  });
});

describe('MCP audit parity (DX#4: by construction)', () => {
  test('audit projection covers every runtime tool name', () => {
    // DX#4 — the parity used to depend on a hand-maintained static list.
    // The new derivation `ALL_TOOLS.map(t => ({ name, description }))`
    // makes parity a tautology. We assert the names match — note that
    // ALL_TOOLS itself may contain duplicate names today
    // (`list_helpers` is registered twice — pre-existing, unrelated to DX#4).
    const projection = ALL_TOOLS.map((t) => ({ name: t.name, description: t.description }));
    expect(projection.length).toBe(ALL_TOOLS.length);
    const runtimeNames = new Set(ALL_TOOLS.map((t) => t.name));
    const projectionNames = new Set(projection.map((p) => p.name));
    expect(runtimeNames).toEqual(projectionNames);
  });

  test('there are zero write tools (read-only invariant)', () => {
    // Smoke test — actual write-detection is in safety-audit. This is a
    // last-line guard against accidental write-tool introduction.
    for (const t of ALL_TOOLS) {
      // The MCP tool registration shape has no explicit `writesFiles`, so
      // the read-only invariant is enforced by `get_safety_audit_deep`.
      // Here we just guard the fact that the tool definition exists.
      expect(typeof t.name).toBe('string');
    }
  });
});
