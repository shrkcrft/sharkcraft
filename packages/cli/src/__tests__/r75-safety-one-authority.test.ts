/**
 * r75 — ONE answer to "does this command write source?" (round 11 review OA-3).
 *
 * COMMAND_CATALOG declares every command's `safetyLevel` / `writesSource`, and
 * the safety audit reads it. The recommender classified by a regex instead,
 * which disagreed on 124 rows: `generated update`, `baseline update`, `check
 * wiring --fix`, `surface enable`, … read `read-only`, so the not-confident
 * withhold gate never withheld them. Now:
 *
 *   - the CLI injects the catalog's declared safety into the ranker
 *     (`catalogCommandSafety` → `IRecommendationRankingOptions.safetyOf`);
 *   - the regex is only the fallback (MCP `recommend_commands`, which cannot
 *     import the CLI, and uncatalogued strings), and it is locked equal to the
 *     catalog on every row the catalog's own audit counts as writing source.
 *
 * The audit predicate is the catalog's own: `writesSource || safetyLevel ===
 * writes-source` (the catalog is itself inconsistent on 17 rows, so neither
 * field alone is the truth).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { commandSafetyLevel, inspectSharkcraft } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '@shrkcrft/mcp-server';
import type { ParsedArgs } from '../command-registry.ts';
import { COMMAND_CATALOG, SafetyLevel, type ICommandCatalogEntry } from '../commands/command-catalog.ts';
import { recommendCommand } from '../commands/recommend.command.ts';
import { buildRegistry } from '../main.ts';
import { catalogCommandSafety } from '../surface/catalog-command-safety.ts';
import { cleanCommandPath, commandIndexFor, findCommandIndexEntry, setActiveCommandRegistry } from '../surface/command-index.ts';

const roots: string[] = [];
afterAll(() => {
  setActiveCommandRegistry(undefined);
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** The catalog audit's own predicate. */
const writes = (e: ICommandCatalogEntry): boolean => e.writesSource === true || e.safetyLevel === SafetyLevel.WritesSource;

describe('the fallback regex ≡ the catalog on every source writer (the MCP path)', () => {
  test('every audit-writer row is `writes-source` to the regex, and no other row is', () => {
    const missed = COMMAND_CATALOG.filter((e) => writes(e) && commandSafetyLevel(`shrk ${e.command}`) !== 'writes-source').map(
      (e) => e.command,
    );
    const over = COMMAND_CATALOG.filter((e) => !writes(e) && commandSafetyLevel(`shrk ${e.command}`) === 'writes-source').map(
      (e) => e.command,
    );
    expect({ missed, over }).toEqual({ missed: [], over: [] });
    // The review's named escapes, by name.
    for (const c of ['generated update --id x', 'baseline update', 'check wiring --fix --write', 'surface enable foo', 'migrate', 'spike', 'delegate']) {
      expect({ c, level: commandSafetyLevel(`shrk ${c}`) }).toEqual({ c, level: 'writes-source' });
    }
    for (const c of ['check wiring', 'surface list', 'generated check', 'baseline check']) {
      expect({ c, level: commandSafetyLevel(`shrk ${c}`) }).toEqual({ c, level: 'read-only' });
    }
  });
});

describe('the injected catalog safety (the CLI path)', () => {
  test('never under-classifies a writer, and equals the row exactly for a base command', () => {
    const registry = buildRegistry();
    setActiveCommandRegistry(registry);
    const index = commandIndexFor(registry);
    const underClassified: string[] = [];
    const mismatchedBase: string[] = [];
    for (const row of COMMAND_CATALOG) {
      const s = catalogCommandSafety(`shrk ${row.command}`, index);
      const writesSource = s?.writesSource ?? commandSafetyLevel(`shrk ${row.command}`) === 'writes-source';
      if (writes(row) && !writesSource) underClassified.push(row.command);
      const isBase = cleanCommandPath(row.command) === row.command && findCommandIndexEntry(index, row.command)?.catalogEntry?.command === row.command;
      if (isBase && s !== undefined && (s.safetyLevel !== row.safetyLevel || s.writesSource !== writes(row))) {
        mismatchedBase.push(`${row.command}: ${s.safetyLevel}/${s.writesSource} vs ${row.safetyLevel}/${writes(row)}`);
      }
    }
    expect({ underClassified, mismatchedBase }).toEqual({ underClassified: [], mismatchedBase: [] });
    // A flag variant's declared safety applies when the string carries the flag.
    expect(catalogCommandSafety('shrk check wiring --fix', index)?.writesSource).toBe(true);
    expect(catalogCommandSafety('shrk check wiring', index)?.writesSource).toBe(false);
  });

  test('a routing hint to catalog writers: labelled writes-source and never recommended when not confident — CLI and MCP', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-r75-safety-'));
    roots.push(root);
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
      'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx' };\n",
      'sharkcraft/task-routing-hints.ts':
        "export default [{ id: 'h.snap', title: 'Snapshots', match: { keywords: ['snapshots'] }, recommends: { commands: ['shrk generated update', 'shrk baseline update'] } }];\n",
    };
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), body);
    }
    setActiveCommandRegistry(buildRegistry());
    const a: ParsedArgs = {
      positional: ['refresh the snapshots'],
      flags: new Map<string, string | boolean>([['cwd', root], ['json', true]]),
      multiFlags: new Map(),
    };
    const orig = process.stdout.write.bind(process.stdout);
    let out = '';
    process.stdout.write = ((c: string | Uint8Array): boolean => {
      out += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
      return true;
    }) as typeof process.stdout.write;
    try {
      await recommendCommand.run(a);
    } finally {
      process.stdout.write = orig;
    }
    type Row = { command: string; safetyLevel: string; writesSource: boolean; suppressedReason?: string };
    const cli = JSON.parse(out) as { confident: boolean; recommendations: Row[]; ranked: Row[] };
    const inspection = await inspectSharkcraft({ cwd: root });
    const mcp = (await ALL_TOOLS.find((t) => t.name === 'recommend_commands')!.handler({ query: 'refresh the snapshots' }, { inspection, cwd: root }))
      .data as { confident: boolean; recommendations: Row[]; ranked: Row[] };
    for (const [surface, r] of [['cli', cli], ['mcp', mcp]] as const) {
      expect({ surface, confident: r.confident }).toEqual({ surface, confident: false });
      for (const command of ['shrk generated update', 'shrk baseline update']) {
        const row = r.ranked.find((x) => x.command === command);
        expect({ surface, command, level: row?.safetyLevel, writes: row?.writesSource, withheld: row?.suppressedReason !== undefined }).toEqual({
          surface,
          command,
          level: 'writes-source',
          writes: true,
          withheld: true,
        });
        expect(r.recommendations.some((x) => x.command === command)).toBe(false);
      }
    }
  }, 60_000);
});
