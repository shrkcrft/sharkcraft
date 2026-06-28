import { describe, expect, test } from 'bun:test';
import { COMMAND_CATALOG, SafetyLevel } from '../commands/command-catalog.ts';
// Import via the package entry, not the private internal tool file: a deep
// cross-package import of an unexported module is a public-api-misuse arch
// violation (it kept the bare `shrk gate` perpetually red on this repo). The
// symbol is re-exported from the package root.
import { COMMAND_CATALOG_EXPORT } from '@shrkcrft/mcp-server';

const VALID_SAFETY: ReadonlySet<string> = new Set(Object.values(SafetyLevel));

describe('command catalog', () => {
  test('every entry has a command + description', () => {
    for (const e of COMMAND_CATALOG) {
      expect(typeof e.command).toBe('string');
      expect(e.command.length).toBeGreaterThan(0);
      expect(typeof e.description).toBe('string');
      expect(e.description.length).toBeGreaterThan(0);
      expect(typeof e.category).toBe('string');
      expect(e.category.length).toBeGreaterThan(0);
    }
  });

  test('every safety level is valid', () => {
    for (const e of COMMAND_CATALOG) {
      expect(VALID_SAFETY.has(e.safetyLevel)).toBe(true);
    }
  });

  test('no duplicate commands', () => {
    const seen = new Set<string>();
    for (const e of COMMAND_CATALOG) {
      expect(seen.has(e.command)).toBe(false);
      seen.add(e.command);
    }
  });

  test('writesSource implies writesFiles', () => {
    for (const e of COMMAND_CATALOG) {
      if (e.writesSource) expect(e.writesFiles).toBe(true);
    }
  });

  test('mcpAvailable=true never paired with writesSource=true', () => {
    for (const e of COMMAND_CATALOG) {
      if (e.mcpAvailable) {
        expect(e.writesSource).toBe(false);
      }
    }
  });

  test('MCP catalog mirror has the same command set as the CLI catalog', () => {
    const cliCommands = new Set(COMMAND_CATALOG.map((e) => e.command));
    const mcpCommands = new Set(COMMAND_CATALOG_EXPORT.map((e) => e.command));
    // The MCP catalog should be a non-strict subset of CLI commands (since
    // some commands are CLI-only and don't appear on the MCP side). At minimum
    // every MCP entry must be a real CLI command.
    for (const cmd of mcpCommands) {
      expect(cliCommands.has(cmd)).toBe(true);
    }
  });
});
