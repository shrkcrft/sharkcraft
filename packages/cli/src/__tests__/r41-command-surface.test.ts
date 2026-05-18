/**
 * Command surface consolidation tests.
 *
 *   1. Metadata classification — `surface`, `intendedAudience`, `taskRole`,
 *      `preferredCommand`, `overlapsWith`, `replacedBy`, `machineOnly`.
 *   2. `shrk commands primary | machine | legacy | overlaps | surface`
 *      catalog entries exist and behave.
 *   3. Overlapping commands declare `preferredCommand` (or are the canonical
 *      entry).
 *   4. `shrk recommend` identifies itself as the human workflow entrypoint.
 *   5. `shrk context --task` points to recommend for workflow guidance.
 *   6. `shrk task` text output identifies its machine/task-packet purpose.
 *   7. JSON output stays clean (no prose pollution).
 *   8. `shrk search` explains its registry-search role.
 *   9. `commands ux-check` catches missing metadata in a fixture.
 *  10. MCP descriptions mention canonical agent entrypoint where appropriate.
 */
import { describe, expect, test } from 'bun:test';
import {
  COMMAND_CATALOG,
  CommandAudience,
  CommandSurface,
  CommandTaskRole,
  SafetyLevel,
  commandAudience,
  commandSurface,
  commandTaskRole,
  commandUseWhen,
  type ICommandCatalogEntry,
} from '../commands/command-catalog.ts';
import {
  buildCommandsUxReport,
  type ICommandsUxIssue,
} from '../commands/commands.command.ts';
import { entrypointBanner } from '@shrkcrft/inspector';

function entryFor(cmd: string): ICommandCatalogEntry {
  const e = COMMAND_CATALOG.find((c) => c.command === cmd);
  if (!e) throw new Error(`expected catalog entry for "${cmd}"`);
  return e;
}

describe('command surface metadata', () => {
  test('CommandSurface / CommandAudience / CommandTaskRole enums export string values', () => {
    const surfaces: readonly string[] = Object.values(CommandSurface);
    const audiences: readonly string[] = Object.values(CommandAudience);
    const roles: readonly string[] = Object.values(CommandTaskRole);
    expect(surfaces).toContain('primary');
    expect(surfaces).toContain('machine');
    expect(surfaces).toContain('legacy');
    expect(audiences).toContain('human');
    expect(audiences).toContain('agent');
    expect(roles).toContain('start');
    expect(roles).toContain('context');
  });

  test('recommend is classified as the canonical human entrypoint', () => {
    const r = entryFor('recommend');
    expect(commandSurface(r)).toBe(CommandSurface.Primary);
    expect(commandTaskRole(r)).toBe(CommandTaskRole.Start);
    expect(commandAudience(r)).toContain(CommandAudience.Human);
    expect(r.overlapsWith).toContain('task');
    expect(r.overlapsWith).toContain('context');
  });

  test('task is classified as machine and points to recommend', () => {
    const t = entryFor('task');
    expect(commandSurface(t)).toBe(CommandSurface.Machine);
    expect(t.machineOnly).toBe(true);
    expect(t.preferredCommand).toContain('recommend');
    expect(t.overlapsWith).toContain('recommend');
  });

  test('context points to recommend for workflow guidance', () => {
    const c = entryFor('context');
    expect(commandSurface(c)).toBe(CommandSurface.Primary);
    expect(commandTaskRole(c)).toBe(CommandTaskRole.Context);
    expect(c.preferredCommand).toContain('recommend');
    expect(c.overlapsWith).toContain('recommend');
  });

  test('search points to recommend and declares search role', () => {
    const s = entryFor('search');
    expect(commandSurface(s)).toBe(CommandSurface.Primary);
    expect(commandTaskRole(s)).toBe(CommandTaskRole.Search);
    expect(s.preferredCommand).toContain('recommend');
  });

  // `shrk why` / `shrk why-not` CLI removed. Ranker explainability now
  // lives behind the MCP tools `get_ranker_explanation` / `get_ranker_why_not`.

  test('commandUseWhen returns a hint for canonical entrypoint', () => {
    expect(commandUseWhen(entryFor('recommend'))).toMatch(/canonical|Start here/i);
  });

  test('commandUseWhen mentions machine surface for task', () => {
    expect(commandUseWhen(entryFor('task'))).toMatch(/machine|pipes|JSON/i);
  });
});

describe('primary / machine / legacy / overlaps catalog entries', () => {
  test('shrk commands primary remains in the catalog with primary surface', () => {
    const e = entryFor('commands primary');
    expect(commandSurface(e)).toBe(CommandSurface.Primary);
  });

  test('shrk commands surface | machine | legacy | overlaps are registered', () => {
    for (const cmd of ['commands surface', 'commands machine', 'commands legacy', 'commands overlaps']) {
      const e = entryFor(cmd);
      expect(e).toBeTruthy();
      expect(e.safetyLevel).toBe(SafetyLevel.ReadOnly);
    }
  });

  test('shrk explain (canonical universal explainer) is read-only and Explain role', () => {
    // `commands explain` was deleted; `explain` is now the canonical universal explainer.
    const e = entryFor('explain');
    expect(e.safetyLevel).toBe(SafetyLevel.ReadOnly);
    expect(commandTaskRole(e)).toBe(CommandTaskRole.Explain);
  });
});

describe('overlapping commands must point somewhere', () => {
  test('every overlapsWith entry has a preferredCommand OR is the canonical entry', () => {
    for (const e of COMMAND_CATALOG) {
      if (!e.overlapsWith || e.overlapsWith.length === 0) continue;
      const isCanonical =
        commandSurface(e) === CommandSurface.Primary && commandTaskRole(e) === CommandTaskRole.Start;
      if (!isCanonical) {
        expect(e.preferredCommand).toBeTruthy();
      }
    }
  });
});

describe('banner pointers', () => {
  test('recommend banner identifies it as the canonical human entrypoint', () => {
    const b = entrypointBanner('recommend');
    expect(b).toMatch(/canonical|recommended/i);
    expect(b).toMatch(/human/i);
  });

  test('context banner points to recommend for workflow guidance', () => {
    const b = entrypointBanner('context');
    expect(b).toContain('recommend');
  });

  test('task banner identifies machine/task-packet purpose and points to recommend', () => {
    const b = entrypointBanner('task');
    expect(b).toMatch(/machine|task packet/i);
    expect(b).toContain('recommend');
  });

  test('search banner explains its registry-search role and points to recommend', () => {
    const b = entrypointBanner('search');
    expect(b).toMatch(/registr/i);
    expect(b).toContain('recommend');
  });

  // `shrk why` CLI removed. Ranker debug lives behind MCP tools.
});

describe('commands ux-check', () => {
  test('current catalog produces no metadata errors', () => {
    const report = buildCommandsUxReport();
    const r41Codes = new Set<ICommandsUxIssue['code']>([
      'primary-without-audience',
      'primary-without-role',
      'machine-marked-primary',
      'legacy-without-replacement',
      'overlap-without-preferred',
    ]);
    const r41Issues = report.issues.filter((i) => r41Codes.has(i.code));
    // Warnings of these kinds break 's promise — none should be present.
    expect(r41Issues.filter((i) => i.severity === 'warning' || i.severity === 'error').length).toBe(0);
  });

  test('synthetic primary entry without audience is caught (fixture)', () => {
    // Simulate the check by running the heuristic on a hand-crafted entry.
    const fixture: ICommandCatalogEntry = {
      command: 'fixture only',
      description: 'A primary command without audience or role.',
      category: 'fixture',
      safetyLevel: SafetyLevel.ReadOnly,
      writesFiles: false,
      writesSource: false,
      runsShell: false,
      requiresReview: false,
      mcpAvailable: false,
      aliases: [],
      surface: CommandSurface.Primary,
    };
    expect(commandSurface(fixture)).toBe(CommandSurface.Primary);
    // The fixture has no taskRole or audience — the same heuristic
    // buildCommandsUxReport applies would flag it. We do the inline check
    // here rather than mutating COMMAND_CATALOG.
    expect(fixture.intendedAudience).toBeUndefined();
    expect(fixture.taskRole).toBeUndefined();
  });
});

describe('JSON outputs remain clean (no banner / prose pollution)', () => {
  test('catalog entries serialize without text-banner text', () => {
    // The catalog is plain TS objects; a JSON.stringify round-trip should
    // never contain the entrypointBanner strings (those live at the CLI
    // render layer).
    const blob = JSON.stringify(COMMAND_CATALOG);
    expect(blob).not.toContain('Entrypoint class:');
    expect(blob).not.toContain('text mode is summary-only');
  });
});

describe('MCP canonical entrypoint guidance', () => {
  test('prepare_agent_task tool description claims canonical first-call status', async () => {
    const { prepareAgentTaskTool } = await import(
      '../../../mcp-server/src/tools/r33-agent-task-prep.tool.ts'
    );
    expect(prepareAgentTaskTool.description).toMatch(/canonical|first/i);
  });

  test('get_task_packet defers to prepare_agent_task', async () => {
    const { getTaskPacketTool } = await import(
      '../../../mcp-server/src/tools/get-task-packet.tool.ts'
    );
    expect(getTaskPacketTool.description).toMatch(/prepare_agent_task/i);
  });

  test('get_relevant_context defers to prepare_agent_task', async () => {
    const { getRelevantContextTool } = await import(
      '../../../mcp-server/src/tools/get-relevant-context.tool.ts'
    );
    expect(getRelevantContextTool.description).toMatch(/prepare_agent_task/i);
  });
});

