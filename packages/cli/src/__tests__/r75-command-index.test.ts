/**
 * r75 — THE command index (spec 4.5#2): `surface list` is the exhaustive
 * dispatch inventory, every row says what it does, and every view of "which
 * commands exist" (surface list, commands doctor, help) reads the same index.
 *
 * Before round 11 `surface list` enumerated COMMAND_CATALOG: 75 registered
 * verbs were missing from "the callable-command inventory", 55 flag-variant
 * rows were presented as separate commands, and all ~436 extended rows printed
 * the same placeholder sentence. `commands doctor` compared top-level handlers
 * only and said "OK ✓".
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildRegistry } from '../main.ts';
import { CommandRegistry, type ParsedArgs } from '../command-registry.ts';
import { PositionalMode } from '../dispatch/positional-mode.ts';
import { COMMAND_CATALOG } from '../commands/command-catalog.ts';
import { buildCommandsDoctorReport } from '../commands/commands.command.ts';
import { makeHelpCommand } from '../commands/help.command.ts';
import { CommandDispatchKind } from '../surface/command-dispatch-kind.ts';
import {
  buildCommandIndex,
  cleanCommandPath,
  setActiveCommandRegistry,
} from '../surface/command-index.ts';
import {
  buildSurfaceSummary,
  SURFACE_SUMMARY_SCHEMA,
  type ISurfaceCommandView,
} from '../surface/surface-summary.ts';
import { TierSource, type ITierResolverContext } from '../surface/tier.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const SPAWN_TIMEOUT_MS = 120_000;

const CONTEXT: ITierResolverContext = {
  spineCommands: new Set<string>(),
  packContributions: new Map<string, string>(),
  surfaceConfig: undefined,
  isToolRepo: true,
};

function rowsOf(summary: ReturnType<typeof buildSurfaceSummary>): ISurfaceCommandView[] {
  return [...summary.tiers.core, ...summary.tiers.extended, ...summary.tiers.experimental];
}

function shrk(cwd: string, argv: readonly string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('bun', ['run', CLI_MAIN, ...argv], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function workspace(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-cmdindex-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

function captureStdout(fn: () => number): { code: number; out: string } {
  const orig = process.stdout.write.bind(process.stdout);
  let out = '';
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    out += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    return { code: fn(), out };
  } finally {
    process.stdout.write = orig;
  }
}

describe('r75 — the command index is the exhaustive dispatch inventory', () => {
  const registry = buildRegistry();
  const index = buildCommandIndex(registry);
  const summary = buildSurfaceSummary(CONTEXT, index);
  const rows = rowsOf(summary);

  test('every registered handler path appears exactly once among the surface rows', () => {
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.command, (counts.get(r.command) ?? 0) + 1);
    const missing: string[] = [];
    const duplicated: string[] = [];
    for (const { path } of registry.listAll()) {
      const p = path.join(' ');
      const n = counts.get(p) ?? 0;
      if (n === 0) missing.push(p);
      if (n > 1) duplicated.push(p);
    }
    expect(missing).toEqual([]);
    expect(duplicated).toEqual([]);
    expect(summary.registryBacked).toBe(true);
    expect(summary.schema).toBe(SURFACE_SUMMARY_SCHEMA);
    expect(SURFACE_SUMMARY_SCHEMA).toBe('sharkcraft.surface.v2');
  });

  test('every subverb a handler DECLARES is a first-class row, exactly once', () => {
    // No production handler declares subverbs yet (wave 3 adds the
    // declarations); the index must read them the moment one does.
    const r = new CommandRegistry();
    r.register({
      name: 'widget',
      description: 'Widgets.',
      usage: 'shrk widget <make|break>',
      subverbs: [
        { name: 'make', description: 'Make one widget.', usage: 'shrk widget make' },
        { name: 'break', description: 'Break one widget.', usage: 'shrk widget break' },
      ],
      positionals: PositionalMode.None,
      run: () => 0,
    });
    const idx = buildCommandIndex(r);
    const make = idx.byPath.get('widget make');
    expect(make?.dispatch).toBe(CommandDispatchKind.Subverb);
    expect(make?.declared).toBe(true);
    expect(make?.description).toBe('Make one widget.');
    expect(make?.usage).toBe('shrk widget make');
    const all = rowsOf(buildSurfaceSummary(CONTEXT, idx));
    expect(all.filter((v) => v.command === 'widget make')).toHaveLength(1);
    expect(all.filter((v) => v.command === 'widget break')).toHaveLength(1);
    // …and the real registry's declared subverbs, whatever they become.
    for (const { path, handler } of registry.listAll()) {
      for (const sv of handler.subverbs ?? []) {
        const p = [...path, sv.name].join(' ');
        expect({ p, n: rows.filter((v) => v.command === p).length }).toEqual({ p, n: 1 });
      }
    }
  });

  test('a catalog-documented internal subverb is listed as a subverb of its real handler', () => {
    const wiring = index.byPath.get('check wiring');
    expect(wiring?.dispatch).toBe(CommandDispatchKind.Subverb);
    expect(wiring?.parent).toBe('check');
    expect(wiring?.catalogued).toBe(true);
  });

  test('no row has an empty description or the old placeholder; no row carries a flag', () => {
    for (const r of rows) {
      expect({ c: r.command, d: r.description.trim().length > 0 }).toEqual({ c: r.command, d: true });
      expect(r.detail ?? '').not.toContain('default for catalog entries');
      expect(r.command.includes(' --')).toBe(false);
    }
  });

  test('flag-variant catalog rows fold into their base command', () => {
    const variants = COMMAND_CATALOG.filter((e) => /\s--/.test(e.command));
    expect(variants.length).toBeGreaterThan(0);
    for (const e of variants) {
      const base = rows.find((r) => r.command === cleanCommandPath(e.command));
      expect({ e: e.command, folded: base?.variants.includes(e.command.trim()) ?? false }).toEqual({
        e: e.command,
        folded: true,
      });
    }
  });

  test('two views agree: commands doctor `registry-path-not-in-catalog` ≡ uncatalogued index rows', () => {
    const report = buildCommandsDoctorReport(registry);
    const doctorCount = report.issues.filter((i) => i.code === 'registry-path-not-in-catalog').length;
    const indexCount = index.entries.filter(
      (e) => e.dispatch !== CommandDispatchKind.Meta && !e.catalogued,
    ).length;
    expect(doctorCount).toBe(indexCount);
    expect(report.summary.uncatalogued).toBe(indexCount);
    expect(summary.totals.uncatalogued).toBe(indexCount);
    // The path-level pass examined every registered path.
    expect(report.coverage.expected).toBe(registry.listAll().length);
    expect(report.coverage.examined).toBe(report.coverage.expected);
  });

  test('help topics come from the index: every indexed subverb is a help topic', () => {
    const help = makeHelpCommand(registry);
    const unreachable = index.entries
      .filter((e) => e.dispatch === CommandDispatchKind.Subverb)
      .filter((e) => {
        const res = captureStdout(() =>
          help.run({ positional: [...e.tokens], flags: new Map() } as ParsedArgs) as number,
        );
        return res.code !== 0 || !res.out.includes(e.description.slice(0, 20));
      })
      .map((e) => e.path);
    expect(unreachable).toEqual([]);
  });

  test('without a registry the listing is relabelled a partial catalog, never the dispatch table', () => {
    setActiveCommandRegistry(undefined);
    const fallback = buildSurfaceSummary(CONTEXT);
    expect(fallback.registryBacked).toBe(false);
    expect(rowsOf(fallback).every((r) => r.dispatch !== CommandDispatchKind.Trie)).toBe(true);
  });
});

describe('r75 — `surface list --json` / `surface explain` over the index (spawned from source)', () => {
  test(
    '`surface list --json` is schema v2, registry-backed, and totals.callable counts the callable rows',
    () => {
      const root = workspace({ 'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'fx' };\n` });
      try {
        const res = shrk(root, ['surface', 'list', '--json']);
        expect(res.status).toBe(0);
        const s = JSON.parse(res.stdout) as ReturnType<typeof buildSurfaceSummary>;
        expect(s.schema).toBe('sharkcraft.surface.v2');
        expect(s.registryBacked).toBe(true);
        const all = rowsOf(s);
        expect(s.totals.callable).toBe(all.filter((r) => r.callable).length);
        // The 75 once-missing registered verbs are present.
        for (const p of ['knowledge list', 'gates check', 'docs references', 'templates list']) {
          expect(all.some((r) => r.command === p)).toBe(true);
        }
        for (const r of all) {
          expect(typeof r.description).toBe('string');
          expect(typeof r.dispatch).toBe('string');
          expect(typeof r.catalogued).toBe('boolean');
          expect(Array.isArray(r.audience)).toBe(true);
          expect(Array.isArray(r.variants)).toBe(true);
        }
        // Text: description column, never the placeholder.
        const text = shrk(root, ['surface', 'list']);
        expect(text.status).toBe(0);
        expect(text.stdout).not.toContain('default for catalog entries');
        expect(text.stdout).toContain('uncatalogued');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    '`surface explain` renders the description and explains a default-tier row from its source',
    () => {
      const registry = buildRegistry();
      const rows = rowsOf(buildSurfaceSummary(CONTEXT, buildCommandIndex(registry)));
      const defaultRow = rows.find((r) => r.source === TierSource.Default && !r.command.includes(' '));
      expect(defaultRow).toBeDefined();
      const root = workspace({ 'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'fx' };\n` });
      try {
        const res = shrk(root, ['surface', 'explain', defaultRow!.command]);
        expect(res.status).toBe(0);
        expect(res.stdout).toContain('description');
        expect(res.stdout).toContain('default tier (not in a spine pipeline, not pack-contributed)');
        // A multi-word internal subverb is one command.
        const sub = shrk(root, ['surface', 'explain', 'check', 'wiring']);
        expect(sub.status).toBe(0);
        expect(sub.stdout).toContain('subverb');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );
});
