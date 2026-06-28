/**
 * Tombstone tests.
 *
 * Verifies that every command file hard-deleted in stays deleted:
 *   - the `.command.ts` file is absent
 *   - the catalog has no `command: 'X'` entry for the removed surface
 *   - the registry does not register the command
 *   - the new authoring verbs (rules update, templates scaffold/doctor,
 *     pack author preview --kind rule|template) wire up correctly
 *
 * Also locks the surface lockdown: visible default still ≈ 32.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { COMMAND_CATALOG } from '../commands/command-catalog.ts';

const COMMANDS_DIR = nodePath.resolve(__dirname, '../commands');

const DELETED_FILES: readonly string[] = [
  'dev-cycle.command.ts',
  'ci-predict.command.ts',
  'heal.command.ts',
  // 'dashboard-export.command.ts' restored in R59 (was a partial
  // deletion that took down `shrk dashboard` along with it).
  'policy-overrides.command.ts',
  'agent-graph.command.ts',
  'pack-quality.command.ts',
  'pipeline-quality.command.ts',
  'packs-quality-docs.command.ts',
  'quality-baseline.command.ts',
  'drift-baseline.command.ts',
  'examples-golden.command.ts',
  'intent.command.ts',
  'routing.command.ts',
  'view.command.ts',
];

const DELETED_CATALOG_COMMANDS: readonly string[] = [
  'intent',
  'view',
  // 'dashboard export' / 'dashboard diff' restored in R59.
  'packs quality',
  'packs docs',
  'packs score',
  'packs compatibility',
  'examples golden',
  'examples golden --init',
  'policy overrides',
  'policy overrides audit',
  'agent graph',
  'agent graph query',
  'quality baseline create',
  'quality baseline compare',
  'quality baseline diff',
  'quality baseline prune',
  'quality baseline history',
  'drift baseline create',
  'drift baseline compare',
  'pipelines lint',
  'pipelines test',
];

describe('hard-delete tombstones', () => {
  test('every deleted.command.ts file is gone', () => {
    for (const file of DELETED_FILES) {
      const abs = nodePath.join(COMMANDS_DIR, file);
      expect(existsSync(abs)).toBe(false);
    }
  });

  test('every deleted catalog entry is gone', () => {
    const present = new Set(COMMAND_CATALOG.map((e) => e.command));
    for (const cmd of DELETED_CATALOG_COMMANDS) {
      expect(present.has(cmd)).toBe(false);
    }
  });

  test('migrate group / commands-taxonomy (deletions) stay deleted', () => {
    const present = new Set(COMMAND_CATALOG.map((e) => e.command));
    expect(present.has('migrate project-coupling audit')).toBe(false);
    expect(present.has('commands taxonomy')).toBe(false);
  });

  test('audit project-coupling is wired (registry, not catalog)', async () => {
    // `shrk audit project-coupling` is registered on the
    // registry (catalog entry intentionally absent — the verb is
    // advanced and not on the spine). The contract is that the command
    // resolves end-to-end.
    const { auditProjectCouplingCommand } = await import('../commands/audit.command.ts');
    expect(auditProjectCouplingCommand.name).toBe('project-coupling');
    expect(auditProjectCouplingCommand.usage).toContain('shrk audit project-coupling');
  });
});

describe('new authoring verbs are registered', () => {
  test('`rules update <id>` exists as a rules subverb', async () => {
    const { rulesUpdateCommand } = await import('../commands/rules.command.ts');
    expect(rulesUpdateCommand.name).toBe('update');
    expect(rulesUpdateCommand.usage).toContain('shrk rules update');
  });

  test('`templates scaffold` / `add` / `doctor` exist', async () => {
    const {
      templatesScaffoldCommand,
      templatesAddCommand,
      templatesDoctorCommand,
    } = await import('../commands/templates.command.ts');
    expect(templatesScaffoldCommand.name).toBe('scaffold');
    expect(templatesAddCommand.name).toBe('add');
    expect(templatesDoctorCommand.name).toBe('doctor');
  });

  test('`templates lint --fix-preview` is documented', async () => {
    const { templatesLintCommand } = await import('../commands/template-quality.command.ts');
    expect(templatesLintCommand.usage).toContain('--fix-preview');
  });

  test('`pack author preview --kind rule|template` no longer returns deferred-stub for those kinds', async () => {
    // Smoke: the command imports the scaffold deps. If those imports
    // are missing the test will throw, which is the failure path.
    const { packAuthorPreviewCommand } = await import('../commands/pack-author.command.ts');
    expect(packAuthorPreviewCommand.description).toMatch(/[Rr]ule.*template.*kinds forward/);
  });
});

describe('surface lockdown holds', () => {
  test('total catalog entries stay within the round-by-round budget', () => {
    // had 342 entries; removed ~23. adds the `spec` family
    // (1 parent + 8 subcommands = +9) for the intent-artifact surface,
    // raising the ceiling to 350 with the justification documented in
    // .sharkcraft/reports/r57-spec-audit.md §9. adds 6 entries:
    // knowledge propose, schemas emit, rounds capture/list/show, diff
    // rounds — raising the ceiling to 360 with the justification in
    // .sharkcraft/reports/r58-feedback-gap-audit.md. R59 restores
    // dashboard (+ export, + diff) and adds `shrk stats` (+4 entries
    // total), raising the ceiling to 365.
    // Code-intelligence layer migration adds 8 top-level commands:
    // rule-graph, search-structural, plan-context, arch, framework,
    // api-diff, gate, migrate. Each is a one-line entry, raising the
    // ceiling to 374. Smart-context embeddings layer adds three more
    // (smart-context embeddings-build, embeddings-status, and the new
    // top-level `spike` command that scaffolds saved focused-plan
    // first-spikes) — ceiling 378. `shrk watch` adds one more to
    // complete the parallel-agent feed loop — ceiling 379. Daemon
    // management (`watch list/stop/prune`) + `deps-audit` add four
    // more — ceiling 384. `scaffold-validate` + `move-plan` round
    // out the delegatable-task surface — ceiling 386. The token-compression
    // layer adds four deterministic, reversible commands — `compress` / `expand`
    // (Compress-Cache-Retrieve) and `align` / `unalign` (KV-cache alignment) —
    // raising the ceiling to 392 (see docs/compression.md). The dev
    // subcommand catalog is then reconciled with the runtime handler:
    // `dev status`, `dev next`, and `dev continue` were real subcommands
    // missing from the catalog (surface-drift fix) — +3 entries, ceiling 395.
    expect(COMMAND_CATALOG.length).toBeLessThan(395);
    // Sanity: not absurdly small.
    expect(COMMAND_CATALOG.length).toBeGreaterThan(250);
  });
});
