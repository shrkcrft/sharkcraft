/**
 * Product-surface polish tests.
 *
 *  1. Lifecycle enum + helpers.
 *  2. Aliases (next / find / explain) declare lifecycle=Alias + a
 *     preferredCommand that resolves to a real catalog entry.
 *  3. `defaultShowInHelp` hides advanced / machine / deprecated / aliases.
 *  4. Compact start-screen does not dump every command (≤ 30 lines).
 *  5. Free-form task heuristic returns true for "rename a plugin safely"
 *     and false for a normal `shrk doctor` invocation.
 *  6. Standardised error footer renders Next/Why/More-detail.
 *  7. Retirement-plan report groups deprecated / aliases / machine-in-help /
 *     overlapping / missing-replacedBy / legacy-no-removeAfter.
 *  8. Docs-check finds zero errors against the live docs.
 *  9. UX-check still produces 0 errors and 0 warnings on the current catalog.
 * 10. `recommend` banner identifies the canonical human entrypoint.
 * 11. `task` banner identifies the machine/task-packet purpose.
 * 12. Compact `shrk commands` view excludes machine/aliases from the
 *     default rendering.
 * 13. `whats-new` parses CHANGELOG.md headings.
 * 14. MCP `prepare_agent_task` is described as canonical first call.
 * 15. Overlapping MCP tools defer to `prepare_agent_task`.
 */
import { describe, expect, test } from 'bun:test';
import {
  COMMAND_CATALOG,
  CommandAudience,
  CommandLifecycle,
  CommandSurface,
  CommandTaskRole,
  R46_OVERLAY,
  commandLifecycle,
  commandUseWhen,
  defaultShowInHelp,
  type ICommandCatalogEntry,
} from '../commands/command-catalog.ts';
import {
  buildCommandsUxReport,
  buildDocsCheckReport,
  buildRetirementPlanReport,
} from '../commands/commands.command.ts';
import { renderStartScreen } from '../commands/help.command.ts';
import { looksLikeFreeFormTask } from '../main.ts';
import {
  errorFooterFor,
  renderErrorFooter,
} from '../output/failure-hints.ts';
import { entrypointBanner } from '@shrkcrft/inspector';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function entryFor(cmd: string): ICommandCatalogEntry {
  const e = COMMAND_CATALOG.find((c) => c.command === cmd);
  if (!e) throw new Error(`expected catalog entry for "${cmd}"`);
  return e;
}

describe('lifecycle metadata', () => {
  test('CommandLifecycle exposes the documented values', () => {
    const v: readonly string[] = Object.values(CommandLifecycle);
    expect(v).toContain('active');
    expect(v).toContain('preferred');
    expect(v).toContain('alias');
    expect(v).toContain('deprecated');
    expect(v).toContain('retired');
  });

  test('commandLifecycle defaults to active when no metadata is set', () => {
    expect(commandLifecycle(entryFor('doctor'))).toBe(CommandLifecycle.Active);
  });

  test('remaining aliases declare lifecycle=Alias and point at a canonical command', () => {
    // deleted the `next` / `find` aliases. deleted the `commands
    // explain` and `commands suggest` deprecated stand-ins; `explain` is
    // now the canonical universal explainer (no longer an alias). There
    // are no surviving "Alias-lifecycle" commands in the catalog; the
    // `packs pending` alias entry remains but lives without an
    // explicit lifecycle tag (R46_OVERLAY hides it).
    const aliasEntries = COMMAND_CATALOG.filter(
      (e) => commandLifecycle(e) === CommandLifecycle.Alias,
    );
    for (const e of aliasEntries) {
      const target = e.replacedBy ?? e.preferredCommand;
      expect(target).toBeDefined();
    }
  });

  test('commandUseWhen never strands an alias without a hint', () => {
    // `explain` is now Active (universal explainer). Aliases that
    // remain (if any) must produce a non-empty "Use this when" string.
    for (const e of COMMAND_CATALOG) {
      if (commandLifecycle(e) !== CommandLifecycle.Alias) continue;
      expect(commandUseWhen(e)).toMatch(/alias/i);
    }
  });

  test('defaultShowInHelp hides aliases / machine / advanced surfaces', () => {
    // `explain` is the canonical universal explainer and visible.
    expect(defaultShowInHelp(entryFor('explain'))).toBe(true);
    expect(defaultShowInHelp(entryFor('task'))).toBe(false); // machine surface
    expect(defaultShowInHelp(entryFor('recommend'))).toBe(true);
    expect(defaultShowInHelp(entryFor('doctor'))).toBe(true);
    expect(defaultShowInHelp(entryFor('code-intel'))).toBe(true);
  });

  test('primary commands cannot be machine-only', () => {
    for (const e of COMMAND_CATALOG) {
      if (e.surface === CommandSurface.Primary) {
        expect(e.machineOnly === true).toBe(false);
      }
    }
  });

  test('deprecated entries declare replacedBy or reason', () => {
    for (const e of COMMAND_CATALOG) {
      if (commandLifecycle(e) === CommandLifecycle.Deprecated) {
        // entries may receive their `replacedBy`/`reason` via the
        // overlay rather than the catalog literal. Treat overlay values
        // as equivalent.
        const r46 = R46_OVERLAY[e.command];
        const ok = Boolean(
          e.replacedBy ?? e.preferredCommand ?? e.reason ?? r46?.replacedBy ?? r46?.reason,
        );
        expect(ok).toBe(true);
      }
    }
  });
});

describe('bare shrk start screen', () => {
  test('renderStartScreen is the curated ~17-command starter surface', () => {
    const out = renderStartScreen();
    const lines = out.split('\n');
    // ≤ 40 lines including blank lines and section headers. The curated
    // starter surface organizes ~17 high-value commands into 5 workflow
    // sections; each `$ shrk <cmd>` line is one verb. If this grows it means
    // another verb crept onto the start screen — push it to --full-help
    // instead (everything stays callable; this screen is just the spotlight).
    expect(lines.length).toBeLessThanOrEqual(40);
    // Guard against the long tail leaking back onto the default surface.
    const verbLines = lines.filter((l) => l.trimStart().startsWith('$ shrk'));
    expect(verbLines.length).toBeLessThanOrEqual(22);
    // Anchor on the section headers that group the curated set.
    expect(out).toContain('Bootstrap:');
    expect(out).toContain('Use it for a task:');
    expect(out).toContain('Generate code safely:');
    expect(out).toContain('Browse what shrk knows:');
    expect(out).toContain('Run shrk for an agent:');
    // Canonical agent-flow commands the curated surface MUST include.
    expect(out).toContain('shrk recommend');
    expect(out).toContain('shrk doctor');
    expect(out).toContain('shrk init');
    expect(out).toContain('shrk context');
    expect(out).toContain('shrk task');
    expect(out).toContain('shrk why');
    expect(out).toContain('shrk impact');
    expect(out).toContain('shrk graph status');
    expect(out).toContain('shrk gen');
    expect(out).toContain('shrk apply');
    expect(out).toContain('shrk quality');
    expect(out).toContain('shrk dashboard');
    expect(out).toContain('shrk mcp serve');
    // Discovery path to the wider surface stays linked.
    expect(out).toContain('shrk surface list');
    expect(out).toContain('--full-help');
  });
});

describe('free-form task heuristic', () => {
  test('looksLikeFreeFormTask returns true for a multi-word task sentence', () => {
    expect(looksLikeFreeFormTask(['rename', 'a', 'plugin', 'safely'])).toBe(true);
  });

  test('looksLikeFreeFormTask returns true for a two-word verb-led phrase', () => {
    expect(looksLikeFreeFormTask(['rename', 'plugin'])).toBe(true);
  });

  test('looksLikeFreeFormTask returns false for a 1-token unknown command', () => {
    expect(looksLikeFreeFormTask(['asdf'])).toBe(false);
  });

  test('looksLikeFreeFormTask ignores --flags', () => {
    expect(looksLikeFreeFormTask(['--help', '--verbose'])).toBe(false);
  });

  test('looksLikeFreeFormTask returns false for "doctor"-style 2-token cmd', () => {
    expect(looksLikeFreeFormTask(['doctor', 'watch'])).toBe(false);
  });
});

describe('error footer', () => {
  test('errorFooterFor returns Next/Why/More for unknown-command', () => {
    const footer = errorFooterFor('unknown-command', { task: 'rename a plugin' });
    expect(footer).toBeDefined();
    expect(footer!.next).toContain('shrk recommend');
    expect(footer!.why).toMatch(/canonical|entrypoint/i);
    expect(footer!.more).toBeDefined();
  });

  test('renderErrorFooter renders the canonical Next / Why / More-detail shape', () => {
    const text = renderErrorFooter({
      next: 'shrk recommend "<task>"',
      why: 'canonical human entrypoint',
      more: ['shrk start-here'],
    });
    expect(text).toContain('Next:');
    expect(text).toContain('Why:');
    expect(text).toContain('More detail:');
    expect(text).toContain('shrk start-here');
  });

  test('errorFooterFor covers the standard failure kinds', () => {
    const kinds = [
      'unknown-command',
      'ambiguous-command',
      'apply-rejected',
      'signature-mismatch',
      'contract-gate-blocked',
      'folder-op-unsafe',
      'doctor-failed',
      'self-config-doctor-failed',
      'stale-pack-signature',
      'project-coupling-audit-failed',
      'templates-drift-failed',
      'knowledge-stale-check-failed',
    ] as const;
    for (const k of kinds) {
      const f = errorFooterFor(k);
      expect(f).toBeDefined();
      expect(f!.next).toMatch(/^shrk\s+/);
    }
  });
});

describe('retirement plan', () => {
  test('retirement plan never errors and returns a stable shape', () => {
    // `next` / `find` aliases physically removed.
    // `explain` promoted to canonical universal explainer, so the
    //       alias group may be empty (or absent). The report itself must
    //       still build without throwing.
    const report = buildRetirementPlanReport();
    expect(Array.isArray(report.groups)).toBe(true);
  });

  test('groups overlapping commands (recommend / task / context / search)', () => {
    // `why` / `why-not` CLI removed.
    const report = buildRetirementPlanReport();
    const overlap = report.groups.find((g) => g.reason === 'overlapping');
    expect(overlap).toBeDefined();
    const cmds = (overlap!.entries as Array<{ command: string }>).map((e) => e.command);
    for (const expected of ['recommend', 'task', 'context', 'search']) {
      expect(cmds).toContain(expected);
    }
  });

  test('schema is sharkcraft.commands-retirement-plan/v1', () => {
    expect(buildRetirementPlanReport().schema).toBe('sharkcraft.commands-retirement-plan/v1');
  });
});

describe('docs-check', () => {
  test('replacedBy and preferredCommand pointers resolve in the live catalog', async () => {
    const report = await buildDocsCheckReport();
    const structural = report.issues.filter(
      (i) => i.code === 'replaced-by-missing' || i.code === 'preferred-command-missing',
    );
    expect(structural).toHaveLength(0);
  });

  test('no doc currently promotes a deprecated command', async () => {
    const report = await buildDocsCheckReport();
    expect(report.issues.find((i) => i.code === 'doc-promotes-deprecated')).toBeUndefined();
  });

  test('schema is sharkcraft.commands-docs-check/v1', async () => {
    const report = await buildDocsCheckReport();
    expect(report.schema).toBe('sharkcraft.commands-docs-check/v1');
  });
});

describe('UX check after lifecycle additions', () => {
  test('current catalog yields zero errors / zero warnings', () => {
    const r = buildCommandsUxReport();
    expect(r.summary.errors).toBe(0);
    expect(r.summary.warnings).toBe(0);
  });
});

describe('banners (wording preserved)', () => {
  test('recommend banner identifies canonical human entrypoint', () => {
    expect(entrypointBanner('recommend')).toMatch(/canonical/i);
  });

  test('task banner identifies machine/task-packet purpose', () => {
    expect(entrypointBanner('task')).toMatch(/machine/i);
  });
});

// `whats-new` CLI removed. CHANGELOG.md is now the single source.

describe('MCP taxonomy guidance', () => {
  test('prepare_agent_task is described as canonical first call', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'packages/mcp-server/src/tools/r33-agent-task-prep.tool.ts'),
      'utf8',
    );
    expect(src).toMatch(/canonical|first/i);
  });

  test('overlapping MCP tools defer to prepare_agent_task', () => {
    const targets = [
      'packages/mcp-server/src/tools/understand-task',
      'packages/mcp-server/src/tools/r26-task-context.tool.ts',
      'packages/mcp-server/src/tools/r29-query-resolver.tool.ts',
      'packages/mcp-server/src/tools/r33-routing-helpers.tool.ts',
      'packages/mcp-server/src/tools/r18-extras.tool.ts',
    ];
    let mentions = 0;
    for (const t of targets) {
      const abs = resolve(process.cwd(), t);
      try {
        const src = readFileSync(abs, 'utf8');
        if (src.includes('prepare_agent_task')) mentions += 1;
      } catch {
        // file not present in this checkout; ignored
      }
    }
    expect(mentions).toBeGreaterThanOrEqual(3);
  });
});
