/**
 * Pruning invariants.
 *
 * Asserts that cleanup decisions are honored at the type / runtime level:
 *
 *   1. The retired commands are physically absent from `COMMAND_CATALOG`.
 *   2. The retired MCP tools are physically absent from `ALL_TOOLS_FOR_AUDIT`.
 *   3. The canonical core commands (the product spine) are still in the
 *      catalog and visible by default.
 *   4. `defaultShowInHelp` hides every overlay-marked entry by default.
 *   5. Catalog meta navigation surfaces (`commands legacy`, etc.) are
 *      hidden but still resolvable.
 *   6. Aliases of the canonical surfaces have lifecycle `Alias` and point
 *      somewhere real.
 *   7. Safety-audit MCP tools are still in the audit list.
 *   8. Catalog doctor / ux-check produces zero errors / zero warnings.
 *
 * Tests are deliberately written as a single file so the round can grow
 * the surface back if a deletion turns out to have been wrong, without
 * having to touch many fixtures.
 */
import { describe, expect, test } from 'bun:test';
import {
  COMMAND_CATALOG,
  CommandLifecycle,
  R46_OVERLAY,
  commandLifecycle,
  defaultShowInHelp,
} from '../commands/command-catalog.ts';
import { buildCommandsUxReport, buildDocsCheckReport } from '../commands/commands.command.ts';
// DX#4 — `ALL_TOOLS_FOR_AUDIT` deleted (parallel static list); use ALL_TOOLS directly.
import { ALL_TOOLS } from '../../../mcp-server/src/tools/index.ts';

const RETIRED_CLI: readonly string[] = [
  // PART 2.1 compliance.
  'compliance profiles',
  'compliance get',
  'compliance check',
  'compliance report',
  'compliance evidence',
  // PART 2.2 release trains.
  'train list',
  'train new',
  'train status',
  'train report',
  'train readiness',
  // PART 2.3 demo.
  'demo script',
  'demo list',
  'demo workflow pr-review',
  'demo workflow pr-review --provider gitlab',
  'demo workflow pr-review --provider bitbucket',
  'demo package',
  'demo package --validate',
  // PART 2.6 migration.
  'migration readiness',
  'migration profiles',
  // PART 2.7 decisions ceremony.
  'decisions doctor',
  'decisions get',
  'decisions list',
  'decisions new',
  'decisions report',
  // PART 2.8 stability.
  'stability map',
  'stability area <id>',
  // PART 2.9 whats-new / product check / api report.
  'whats-new',
  'product check',
  'api report',
  // PART 4 ranker explain. The original ranker-explain `why` verb was
  // retired in. feedback3 re-introduces `shrk why <file>` as a
  // file-onboarding verb (closes the dangling promise from
  // ide.command.ts:112). Same name, different purpose — name is
  // legitimately back in service. Removed from the retired list to
  // reflect that reality.
  'why-not',
  // PART 5 aliases.
  'find',
  'next',
  'search-tuning',
  'pr description',
  'changes report',
  // PART 10 intelligence.
  'intelligence graph',
  'intelligence explain',
  'intelligence node',
  'intelligence path',
  'intelligence query',
  'intelligence stats',
  // PART 14 handoff / map.
  'handoff',
  'map',
];

const RETIRED_MCP: readonly string[] = [
  // PART 2.1 compliance.
  'list_compliance_profiles',
  'get_compliance_profile',
  'run_compliance_check',
  'preview_compliance_evidence_packet',
  // PART 2.2 release trains.
  'list_release_trains',
  'get_release_train',
  // PART 2.3 demo.
  'get_demo_script_preview',
  'get_demo_workflow_preview',
  'get_demo_package_preview',
  'get_demo_package_validation',
  // PART 2.7 decisions.
  'list_decisions',
  'get_decision',
  'preview_decision_draft',
  'get_decisions_report',
  // PART 2.8 stability.
  'get_stability_map',
  // PART 2.6 migration.
  'list_migration_profiles',
  'get_migration_readiness',
];

const SPINE_VISIBLE: readonly string[] = [
  'doctor',
  'inspect',
  'recommend',
  'context',
  'search',
  'check boundaries',
  'impact',
  'graph',
  'coverage',
  'drift',
  'gen',
  'apply',
  'fix preview',
  'packs list',
  'packs doctor',
  'packs sign',
  'ci scaffold github-actions',
  'safety audit',
  'preflight',
  // `explore` demoted to Advanced; spine is opt-in via Primary/Common only.
  // self-config doctor / packs signature-status / packs contributions /
  //       presets list|get|explain / graph why / plan review now in the catalog.
  'self-config doctor',
  'packs signature-status',
  'packs contributions',
  'presets list',
  'presets get',
  'presets explain',
  'graph why',
  'plan review',
];

const HIDDEN_BUT_RESOLVABLE: readonly string[] = [
  'commands legacy',
  'commands machine',
  'commands overlaps',
  'commands primary',
  'commands surface',
  // `commands taxonomy` hard-deleted; the catalog exposes the
  // same data via the `--taxonomy` filter on `commands`.
];

describe('physical deletions', () => {
  test('retired CLI commands are absent from COMMAND_CATALOG', () => {
    const present = new Set(COMMAND_CATALOG.map((e) => e.command));
    for (const cmd of RETIRED_CLI) {
      expect(present.has(cmd)).toBe(false);
    }
  });

  test('retired MCP tools are absent from ALL_TOOLS', () => {
    // DX#4 — `ALL_TOOLS_FOR_AUDIT` deleted; audit-list parity is now
    // by construction (derived from ALL_TOOLS at runtime).
    const present = new Set(ALL_TOOLS.map((t) => t.name));
    for (const name of RETIRED_MCP) {
      expect(present.has(name)).toBe(false);
    }
  });
});

describe('product spine still present', () => {
  test('every canonical spine command is in the catalog', () => {
    const present = new Set(COMMAND_CATALOG.map((e) => e.command));
    for (const cmd of SPINE_VISIBLE) {
      expect(present.has(cmd)).toBe(true);
    }
  });

  test('every canonical spine command is visible by default', () => {
    const byName = new Map(COMMAND_CATALOG.map((e) => [e.command, e] as const));
    for (const cmd of SPINE_VISIBLE) {
      const entry = byName.get(cmd);
      expect(entry).toBeDefined();
      expect(defaultShowInHelp(entry!)).toBe(true);
    }
  });
});

describe('overlay invariants', () => {
  test('every R46_OVERLAY entry hides the command from default help', () => {
    const byName = new Map(COMMAND_CATALOG.map((e) => [e.command, e] as const));
    for (const cmd of Object.keys(R46_OVERLAY)) {
      const entry = byName.get(cmd);
      if (!entry) continue; // overlay still mentions retired-and-deleted entries for typo-correction.
      expect(defaultShowInHelp(entry)).toBe(false);
    }
  });

  test('every overlay-marked deprecated command resolves Deprecated via commandLifecycle', () => {
    const byName = new Map(COMMAND_CATALOG.map((e) => [e.command, e] as const));
    for (const [cmd, overlay] of Object.entries(R46_OVERLAY)) {
      if (overlay.verdict !== 'deprecated' && overlay.verdict !== 'retired') continue;
      const entry = byName.get(cmd);
      if (!entry) continue;
      const lc = commandLifecycle(entry);
      expect(lc === CommandLifecycle.Deprecated || lc === CommandLifecycle.Retired).toBe(true);
    }
  });

  test('hidden catalog meta surfaces remain resolvable', () => {
    const present = new Set(COMMAND_CATALOG.map((e) => e.command));
    for (const cmd of HIDDEN_BUT_RESOLVABLE) {
      expect(present.has(cmd)).toBe(true);
    }
  });
});

describe('safety regressions', () => {
  test('safety audit MCP tools survive', () => {
    // DX#4 — audit-list derived from ALL_TOOLS at runtime.
    const present = new Set(ALL_TOOLS.map((t) => t.name));
    expect(present.has('get_safety_audit')).toBe(true);
    expect(present.has('get_safety_audit_deep')).toBe(true);
    expect(present.has('doctor_packs')).toBe(true);
    expect(present.has('get_self_config_doctor')).toBe(true);
  });

  test('apply / plan / boundaries / check core CLI surface survives', () => {
    const present = new Set(COMMAND_CATALOG.map((e) => e.command));
    expect(present.has('apply')).toBe(true);
    expect(present.has('plan')).toBe(true);
    expect(present.has('check boundaries')).toBe(true);
    expect(present.has('check')).toBe(true);
  });
});

describe('catalog hygiene', () => {
  test('commands ux-check is green (zero errors / zero warnings)', () => {
    const r = buildCommandsUxReport();
    expect(r.summary.errors).toBe(0);
    expect(r.summary.warnings).toBe(0);
  });

  test('docs-check finds no doc promoting a deprecated command', async () => {
    const report = await buildDocsCheckReport();
    const promotes = report.issues.find((i) => i.code === 'doc-promotes-deprecated');
    expect(promotes).toBeUndefined();
  });
});
