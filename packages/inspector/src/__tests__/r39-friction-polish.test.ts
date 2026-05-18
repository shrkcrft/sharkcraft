/**
 * Friction polish tests.
 *
 *   1. Schema inventory lists multi-version schemas and current versions.
 *   2. Entrypoint matrix now has search/why/task-text entries with seeAlso.
 *   3. entrypointBanner covers the new ids.
 *   4. exploreArea infers role / surfaces tests / detects MCP-tool risk.
 *   5. Acceptance replay always emits baseline gates and fires conditional
 *      gates on MCP-only changes.
 *   6. ChangesSummary respects --round label via options.
 *   7. Schema inventory references actually exist as engine schemas.
 */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';

import {
  ACCEPTANCE_REPLAY_SCHEMA,
  AREA_EXPLORE_SCHEMA,
  buildAcceptanceReplay,
  buildChangesSummary,
  buildEntrypointMatrix,
  buildSchemaInventory,
  EntrypointClass,
  entrypointBanner,
  exploreArea,
  findSchemaInventoryEntry,
  inspectSharkcraft,
  ReplayProfile,
  SCHEMA_INVENTORY_SCHEMA,
  SchemaStatus,
} from '../index.ts';
import type { IChangesSummaryReport } from '../changes-summary.ts';

function mkProject(): string {
  return mkdtempSync(nodePath.join(tmpdir(), 'shrk-r39-'));
}

describe('schema inventory', () => {
  it('lists multi-version schemas with current version flagged', () => {
    const report = buildSchemaInventory();
    expect(report.schema).toBe(SCHEMA_INVENTORY_SCHEMA);
    expect(report.entries.length).toBeGreaterThan(10);
    expect(report.multiVersionIds.length).toBeGreaterThanOrEqual(1);
    // self-config-doctor is the canonical multi-version example (v1 + v2).
    const selfCfg = findSchemaInventoryEntry('sharkcraft.self-config-doctor');
    expect(selfCfg).not.toBeNull();
    expect(selfCfg!.versions.length).toBeGreaterThanOrEqual(2);
    expect(selfCfg!.currentVersion).toBe('v2');
    const v1 = selfCfg!.versions.find((v) => v.version === 'v1')!;
    expect(v1.status).toBe(SchemaStatus.Backcompat);
  });

  it('every inventory entry has a non-empty summary', () => {
    const report = buildSchemaInventory();
    for (const e of report.entries) {
      expect(e.id).toMatch(/^sharkcraft\./);
      expect(e.summary.length).toBeGreaterThan(5);
      expect(e.versions.length).toBeGreaterThanOrEqual(1);
      const hasCurrent = e.versions.some(
        (v) => v.version === e.currentVersion && v.status === SchemaStatus.Current,
      );
      expect(hasCurrent).toBe(true);
    }
  });

  it('returns null for unknown ids', () => {
    expect(findSchemaInventoryEntry('sharkcraft.nope')).toBeNull();
  });
});

describe('entrypoint matrix extensions', () => {
  it('includes search-registry and task-text entries', () => {
    const matrix = buildEntrypointMatrix();
    const ids = matrix.entries.map((e) => e.id);
    expect(ids).toContain('search-registry');
    expect(ids).toContain('task-text');
    expect(ids).toContain('why');
  });

  it('task-text seeAlso includes recommend', () => {
    const matrix = buildEntrypointMatrix();
    const taskText = matrix.entries.find((e) => e.id === 'task-text');
    expect(taskText).toBeTruthy();
    expect(taskText!.class).toBe(EntrypointClass.MachineJson);
    expect(taskText!.seeAlso ?? []).toContain('recommend');
  });

  it('search-registry classifies as machine-json and points at recommend', () => {
    const matrix = buildEntrypointMatrix();
    const searchEntry = matrix.entries.find((e) => e.id === 'search-registry');
    expect(searchEntry).toBeTruthy();
    expect(searchEntry!.class).toBe(EntrypointClass.MachineJson);
    expect(searchEntry!.seeAlso ?? []).toContain('recommend');
  });

  it('entrypointBanner covers task-json / search / why', () => {
    expect(entrypointBanner('task-json')).toContain('machine-json');
    expect(entrypointBanner('search')).toContain('recommend');
    expect(entrypointBanner('why')).toContain('ranker');
  });
});

describe('explore area', () => {
  it('infers MCP tools role + risk for the tools dir', async () => {
    const root = mkProject();
    try {
      mkdirSync(nodePath.join(root, 'packages/mcp-server/src/tools'), {
        recursive: true,
      });
      writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
      writeFileSync(
        nodePath.join(root, 'packages/mcp-server/src/tools/index.ts'),
        '// tools index',
      );
      writeFileSync(
        nodePath.join(root, 'packages/mcp-server/src/tools/foo.tool.ts'),
        '// foo tool',
      );
      const inspection = await inspectSharkcraft({ cwd: root });
      const report = exploreArea({
        inspection,
        path: 'packages/mcp-server/src/tools',
      });
      expect(report.schema).toBe(AREA_EXPLORE_SCHEMA);
      expect(report.exists).toBe(true);
      expect(report.role).toContain('MCP read-only tools');
      // MCP tool dir risk surfaces.
      const mcpRisk = report.risks.find((r) => r.kind === 'mcp-tool-dir');
      expect(mcpRisk).toBeTruthy();
      expect(report.fileCount).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('marks non-existent paths as exists=false', async () => {
    const root = mkProject();
    try {
      writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
      const inspection = await inspectSharkcraft({ cwd: root });
      const report = exploreArea({ inspection, path: 'does/not/exist' });
      expect(report.exists).toBe(false);
      expect(report.fileCount).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('related commands surface from injected catalog by token overlap', async () => {
    const root = mkProject();
    try {
      mkdirSync(nodePath.join(root, 'packages/cli/src/commands'), { recursive: true });
      writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
      writeFileSync(
        nodePath.join(root, 'packages/cli/src/commands/foo.command.ts'),
        '// foo command',
      );
      const inspection = await inspectSharkcraft({ cwd: root });
      const report = exploreArea({
        inspection,
        path: 'packages/cli/src/commands',
        commandCatalog: [
          { command: 'commands' },
          { command: 'commands doctor' },
          { command: 'unrelated thing' },
        ],
        mcpToolNames: ['get_repository_commands', 'list_random'],
      });
      expect(report.relatedCommands).toContain('commands');
      expect(report.relatedCommands).toContain('commands doctor');
      expect(report.relatedCommands).not.toContain('unrelated thing');
      expect(report.relatedMcpTools).toContain('get_repository_commands');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('acceptance replay', () => {
  function summaryFixture(overrides: Partial<IChangesSummaryReport> = {}): IChangesSummaryReport {
    return {
      schema: 'sharkcraft.changes-summary/v1',
      generatedAt: new Date().toISOString(),
      source: 'since',
      ref: 'HEAD~1',
      totalFiles: 3,
      filesByArea: {},
      files: [],
      touchedCommands: [],
      touchedMcpTools: [],
      touchedSchemas: [],
      touchedDocs: [],
      touchedTests: [],
      touchedPackAssets: [],
      safetyRelevantFiles: [],
      risk: 'low',
      riskReasons: [],
      suggestedValidationCommands: [],
      likelyPrSummary: 'fixture',
      ...overrides,
    } as IChangesSummaryReport;
  }

  it('always emits baseline gates', () => {
    const summary = summaryFixture();
    const report = buildAcceptanceReplay({ summary });
    expect(report.schema).toBe(ACCEPTANCE_REPLAY_SCHEMA);
    const cmds = report.commands.map((c) => c.command);
    expect(cmds).toContain('bun x tsc -p tsconfig.base.json --noEmit');
    expect(cmds).toContain('bun test');
    expect(cmds).toContain('shrk doctor');
  });

  it('fires safety audit on MCP-tool touches', () => {
    const summary = summaryFixture({
      touchedMcpTools: ['packages/mcp-server/src/tools/foo.tool.ts'],
      safetyRelevantFiles: ['packages/mcp-server/src/tools/foo.tool.ts'],
    });
    const report = buildAcceptanceReplay({ summary });
    const cmds = report.commands.map((c) => c.command);
    expect(cmds).toContain('shrk safety audit --deep');
  });

  it('honours round label', () => {
    const summary = summaryFixture();
    const report = buildAcceptanceReplay({ summary, roundLabel: 'cycle-39' });
    expect(report.roundLabel).toBe('cycle-39');
  });

  it('strict profile picks up all gates regardless of trigger', () => {
    const summary = summaryFixture();
    const standard = buildAcceptanceReplay({ summary, profile: ReplayProfile.Standard });
    const strict = buildAcceptanceReplay({ summary, profile: ReplayProfile.Strict });
    expect(strict.commands.length).toBeGreaterThan(standard.commands.length);
  });
});

describe('changes summary round label', () => {
  it('roundLabel option propagates to report', async () => {
    const root = mkProject();
    try {
      writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
      const inspection = await inspectSharkcraft({ cwd: root });
      const report = await buildChangesSummary(inspection, {
        files: ['foo.ts'],
        roundLabel: 'cycle-39',
      });
      expect(report.roundLabel).toBe('cycle-39');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

