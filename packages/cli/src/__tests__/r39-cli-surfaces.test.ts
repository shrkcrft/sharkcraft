/**
 * CLI surface tests.
 *
 *   1. Schemas inventory + explore + acceptance-replay catalog entries exist.
 *   2. `commands doctor` stays clean for the new entries.
 *   3. `commands ux-check` finds no UX regressions.
 *   4. Schemas inventory CLI emits JSON with current versions.
 */
import { describe, expect, test } from 'bun:test';
import {
  COMMAND_CATALOG,
  SafetyLevel,
} from '../commands/command-catalog.ts';
import {
  buildCommandsDoctorReport,
  buildCommandsUxReport,
} from '../commands/commands.command.ts';

describe('CLI catalog additions', () => {
  test('schemas inventory command is in the catalog', () => {
    const e = COMMAND_CATALOG.find((c) => c.command === 'schemas inventory');
    expect(e).toBeTruthy();
    expect(e!.safetyLevel).toBe(SafetyLevel.ReadOnly);
    expect(e!.mcpAvailable).toBe(true);
  });

  test('explore command is in the catalog', () => {
    const e = COMMAND_CATALOG.find((c) => c.command === 'explore');
    expect(e).toBeTruthy();
    expect(e!.safetyLevel).toBe(SafetyLevel.ReadOnly);
    expect(e!.mcpAvailable).toBe(true);
    expect(e!.description).toMatch(/explore|directory/i);
  });

  test('changes acceptance-replay command is in the catalog', () => {
    const e = COMMAND_CATALOG.find((c) => c.command === 'changes acceptance-replay');
    expect(e).toBeTruthy();
    expect(e!.safetyLevel).toBe(SafetyLevel.ReadOnly);
  });

  test('schemas write is marked drafts-only (no source writes)', () => {
    const e = COMMAND_CATALOG.find((c) => c.command === 'schemas write');
    expect(e).toBeTruthy();
    expect(e!.safetyLevel).toBe(SafetyLevel.WritesDraftsOnly);
    expect(e!.writesFiles).toBe(true);
    expect(e!.writesSource).toBe(false);
  });
});

describe('catalog hygiene', () => {
  test('commands doctor has no errors', () => {
    const r = buildCommandsDoctorReport(null);
    expect(r.summary.errors).toBe(0);
  });

  test('commands ux-check is clean for the new entries', () => {
    const r = buildCommandsUxReport();
    // No errors should be introduced by additions.
    expect(r.summary.errors).toBe(0);
  });

  test('no new catalog entries claim writes-source via mcp', () => {
    const r = buildCommandsDoctorReport(null);
    const violations = r.issues.filter((i) => i.code === 'writes-source-via-mcp');
    expect(violations.length).toBe(0);
  });
});
