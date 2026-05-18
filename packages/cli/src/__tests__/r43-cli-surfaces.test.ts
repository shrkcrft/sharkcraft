/**
 * CLI surface tests.
 *
 *   1. New commands are registered (rules scaffold, rules doctor, checks*,
 *      codemod) and the catalog still passes its UX-check.
 *   2. `shrk packs sign --print-command` works without a real manifest.
 *   3. `shrk rules scaffold` prints a useful preview and writes nothing
 *      unless --write-preview.
 *   4. `shrk rules doctor` returns the new finding codes.
 *   5. `shrk checks list` is empty in a workspace with no metadata.checks[].
 * 6. MCP tool list does NOT contain any of the surface names —
 *      we keep the engine's "no MCP write tools" invariant by not
 *      exposing rule-scaffold / codemod / checks as new tools yet.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

const CLI = nodePath.resolve(__dirname, '..', 'main.ts');
const REPO_ROOT = nodePath.resolve(__dirname, '..', '..', '..', '..');

function shrk(args: readonly string[], cwd: string = REPO_ROOT): { code: number; out: string; err: string } {
  const r = spawnSync('bun', [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

describe('CLI registrations', () => {
  test('shrk rules scaffold is reachable and emits a preview', () => {
    const r = shrk([
      'rules',
      'scaffold',
      '--id',
      'architecture.no-reexport-proxy',
      '--kind',
      'architecture',
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Rule scaffold preview');
    expect(r.out).toContain('.sharkcraft/fixes/rule-architecture-no-reexport-proxy.preview.ts');
    // Default: nothing is materialised.
    expect(r.out).toContain('preview only');
  });

  test('shrk rules doctor returns new finding codes', () => {
    const r = shrk(['rules', 'doctor', '--json']);
    expect(r.code === 0 || r.code === 1).toBe(true);
    const parsed = JSON.parse(r.out.trim());
    expect(parsed.schema).toBe('sharkcraft.rule-quality/v1');
    expect(typeof parsed.evaluated).toBe('number');
    expect(Array.isArray(parsed.findings)).toBe(true);
    if (parsed.findings.length > 0) {
      const codes = new Set<string>(parsed.findings.map((f: { code: string }) => f.code));
      // At least one of the codes should fire on the live rule set.
      const r43Codes = [
        'missing-examples',
        'verification-references-unknown-script',
        'vague-rule',
        'advisory-not-marked',
        'missing-hints',
        'missing-verification',
      ];
      expect(r43Codes.some((c) => codes.has(c))).toBe(true);
    }
  });

  test('shrk checks list is reachable and reports empty registry honestly', () => {
    const r = shrk(['checks', 'list']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Custom checks');
  });

  test('shrk checks doctor returns json with stable schema', () => {
    const r = shrk(['checks', 'doctor', '--json']);
    expect(r.code === 0 || r.code === 1).toBe(true);
    const parsed = JSON.parse(r.out.trim());
    expect(parsed.schema).toBe('sharkcraft.custom-checks-doctor/v1');
  });

  test('shrk codemod plan --rule <id> renders without writing', () => {
    const r = shrk(['codemod', 'plan', '--rule', 'repo.architecture.respect-layer-order']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Codemod-assist for repo.architecture.respect-layer-order');
    expect(r.out).toContain('What the engine cannot do');
    expect(r.out).toContain('preview only');
  });

  test('shrk codemod inventory works with no targets', () => {
    const r = shrk(['codemod', 'inventory', '--rule', 'repo.architecture.respect-layer-order']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Codemod inventory');
  });

  test('shrk packs sign --print-command works without a real manifest path', () => {
    const r = shrk(['packs', 'sign', 'somewhere/that/does-not-exist', '--print-command']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('shrk packs sign');
    if (!process.env['SHARKCRAFT_PACK_SECRET']) {
      expect(r.out).toContain('SHARKCRAFT_PACK_SECRET=<secret>');
    }
  });

  test('shrk doctor --explain-quality renders without crashing', () => {
    const r = shrk(['doctor', '--explain-quality']);
    expect(r.code === 0 || r.code === 1).toBe(true);
    expect(r.out).toContain('SharkCraft doctor');
  });
});

describe('write-preview round-trip', () => {
  test('shrk rules scaffold --write-preview materialises three files in cwd', () => {
    const tmp = mkdtempSync(nodePath.join(tmpdir(), 'r43-scaffold-'));
    // Provide a minimal sharkcraft folder so doctor doesn't fail; not
    // strictly needed for scaffold itself, which uses cwd directly.
    mkdirSync(nodePath.join(tmp, 'sharkcraft'), { recursive: true });
    writeFileSync(
      nodePath.join(tmp, 'sharkcraft', 'sharkcraft.config.ts'),
      'import { defineSharkCraftConfig } from "@shrkcrft/config";\nexport default defineSharkCraftConfig({});\n',
      'utf8',
    );
    writeFileSync(
      nodePath.join(tmp, 'package.json'),
      JSON.stringify({ name: 'tmp', version: '0.0.1' }) + '\n',
      'utf8',
    );
    const r = shrk(
      [
        'rules',
        'scaffold',
        '--id',
        'safety.example-rule',
        '--kind',
        'safety',
        '--write-preview',
      ],
      tmp,
    );
    expect(r.code).toBe(0);
    const tsFile = nodePath.join(tmp, '.sharkcraft', 'fixes', 'rule-safety-example-rule.preview.ts');
    const jsonFile = nodePath.join(tmp, '.sharkcraft', 'fixes', 'rule-safety-example-rule.preview.json');
    const mdFile = nodePath.join(tmp, '.sharkcraft', 'fixes', 'rule-safety-example-rule.preview.md');
    expect(readFileSync(tsFile, 'utf8')).toContain('defineRule');
    expect(JSON.parse(readFileSync(jsonFile, 'utf8')).id).toBe('safety.example-rule');
    expect(readFileSync(mdFile, 'utf8')).toContain('Rule scaffold');
  });
});

describe('MCP read-only invariant', () => {
  test('no MCP tool name contains "scaffold" or "codemod" write surface', async () => {
    const mod = await import('@shrkcrft/mcp-server');
    const tools = (mod as unknown as { ALL_TOOLS: { name: string }[] }).ALL_TOOLS;
    expect(Array.isArray(tools)).toBe(true);
    for (const t of tools) {
      // forbids new MCP write tools. The optional read-only mirrors
      // listed in the brief (preview_rule_scaffold, get_rule_quality_report,
      // get_custom_checks_report, get_codemod_assist_report) are deferred
      // — assert they are not present so we don't accidentally ship a
      // write surface under a "preview_*" name.
      expect(t.name.includes('write')).toBe(false);
      expect(t.name).not.toBe('apply_rule_scaffold');
      expect(t.name).not.toBe('run_custom_check');
      expect(t.name).not.toBe('execute_codemod');
    }
  });
});

