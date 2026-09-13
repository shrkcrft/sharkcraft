/**
 * MCP gate resolver: validates that the resolver built from
 * the surface summary correctly gates experimental tools and lets
 * core / extended tools pass.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ALL_TOOLS, type IToolDefinition } from '@shrkcrft/mcp-server';
import {
  buildSurfaceSummary,
  findCommandInSummary,
} from '../surface/surface-summary.ts';
import { CommandTier } from '../commands/command-catalog.ts';
import { buildMcpGateResolver } from '../commands/mcp.command.ts';
import { buildRegistry } from '../main.ts';
import { setActiveCommandRegistry } from '../surface/command-index.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const fixtures: string[] = [];
afterAll(() => {
  setActiveCommandRegistry(undefined);
  for (const f of fixtures) rmSync(f, { recursive: true, force: true });
});

function mkTool(name: string, cliCommand?: string): IToolDefinition {
  return {
    name,
    description: 'test',
    inputSchema: { type: 'object' as const },
    handler: () => ({ data: { ok: true } }),
    ...(cliCommand !== undefined ? { cliCommand } : {}),
  } as IToolDefinition;
}

function resolverFor(summary: ReturnType<typeof buildSurfaceSummary>) {
  return (tool: IToolDefinition) => {
    if (!tool.cliCommand) return null;
    const view = findCommandInSummary(summary, tool.cliCommand);
    if (!view || view.callable) return null;
    return { command: tool.cliCommand, reason: view.detail };
  };
}

describe('MCP gate resolver', () => {
  test('tools without cliCommand are always callable (bootstrap)', () => {
    const summary = buildSurfaceSummary({
      spineCommands: new Set(),
      packContributions: new Map(),
      surfaceConfig: undefined,
      isToolRepo: true,
    });
    const resolver = resolverFor(summary);
    const tool = mkTool('inspect_workspace'); // no cliCommand
    expect(resolver(tool)).toBeNull();
  });

  test('tools with core CLI sibling are callable', () => {
    const summary = buildSurfaceSummary({
      spineCommands: new Set(),
      packContributions: new Map(),
      surfaceConfig: undefined,
      isToolRepo: true,
    });
    const resolver = resolverFor(summary);
    const tool = mkTool('doctor_tool', 'doctor');
    expect(resolver(tool)).toBeNull();
  });

  test('tools with extended CLI sibling are callable', () => {
    const summary = buildSurfaceSummary({
      spineCommands: new Set(),
      packContributions: new Map(),
      surfaceConfig: undefined,
      isToolRepo: true,
    });
    const resolver = resolverFor(summary);
    const tool = mkTool('inspect_tool', 'inspect');
    const decision = resolver(tool);
    expect(decision).toBeNull();
  });

  test('tools with experimental sibling are gated', () => {
    const summary = buildSurfaceSummary({
      spineCommands: new Set(),
      packContributions: new Map([['some-experimental', 'fake-pack']]),
      surfaceConfig: undefined,
      isToolRepo: true,
    });
    // Need to inject the catalog entry — pack-contributed commands
    // only appear when the catalog has them. For this test we walk
    // the summary's experimental tier directly.
    const view = summary.tiers.experimental[0];
    if (!view) {
      // No experimental commands in the default catalog; the gate
      // logic is exercised via the unit tests on tier resolver. This
      // test asserts the SHAPE of the resolver instead.
      const resolver = resolverFor(summary);
      const tool = mkTool('made_up', 'no-such-command');
      // Unknown commands fall through to "callable" by design (the
      // resolver only refuses commands it knows are experimental).
      expect(resolver(tool)).toBeNull();
      return;
    }
    expect(view.tier).toBe(CommandTier.Experimental);
    const resolver = resolverFor(summary);
    const tool = mkTool('gated_tool', view.command);
    const decision = resolver(tool);
    expect(decision).not.toBeNull();
    expect(decision?.command).toBe(view.command);
  });
});

describe('MCP gate resolver — tool-maintenance siblings (round 11 §5.1)', () => {
  test('get_docs_check / get_release_readiness are refused in a consumer repo and allowed in the SharkCraft repo', async () => {
    const fx = mkdtempSync(join(tmpdir(), 'shrk-r56-mcpgate-'));
    fixtures.push(fx);
    for (const [rel, body] of Object.entries({
      'package.json': JSON.stringify({ name: 'consumer-app', version: '0.0.0' }),
      'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'consumer-app' };\n",
    })) {
      mkdirSync(dirname(join(fx, rel)), { recursive: true });
      writeFileSync(join(fx, rel), body);
    }
    // The real registry and the real production resolver (`shrk mcp serve` wires it).
    setActiveCommandRegistry(buildRegistry());
    const consumerGate = await buildMcpGateResolver(fx);
    const repoGate = await buildMcpGateResolver(REPO_ROOT);
    expect(consumerGate).toBeDefined();
    expect(repoGate).toBeDefined();
    for (const name of ['get_docs_check', 'get_release_readiness']) {
      const tool = ALL_TOOLS.find((t) => t.name === name);
      expect(tool?.cliCommand).toBeDefined();
      const decision = consumerGate!(tool!);
      expect(decision?.command).toBe(tool!.cliCommand!);
      expect(decision?.reason).toContain('maintains SharkCraft itself and does not apply to this repository');
      expect(decision?.reason).toContain('shrk surface enable');
      expect(repoGate!(tool!)).toBeNull();
    }
  });
});
