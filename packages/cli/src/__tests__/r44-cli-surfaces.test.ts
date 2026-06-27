/**
 * CLI surface tests for the authoring loop.
 *
 *   1. New commands are registered:
 *        shrk knowledge add / update / remove / lint / author
 *        shrk provenance list / show / report
 *        shrk pack author status / preview / pending / validate
 *        shrk packs pending (alias)
 *   2. Knowledge add preview prints expected layout and writes nothing
 *      unless --write-preview.
 *   3. Knowledge remove refuses a missing entry honestly.
 *   4. Knowledge lint --json returns the expected schema.
 *   5. Provenance list reports empty ledger honestly.
 *   6. Pack-author pending shows missing-secret hint when secret not set.
 *   7. write-preview round-trips: drafts land under .sharkcraft/authoring/.
 * 8. MCP tool list does NOT contain any write surface.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

const CLI = nodePath.resolve(__dirname, '..', 'main.ts');
const REPO_ROOT = nodePath.resolve(__dirname, '..', '..', '..', '..');

function shrk(args: readonly string[], cwd: string = REPO_ROOT): { code: number; out: string; err: string } {
  const r = spawnSync('bun', [CLI, ...args], {
    cwd,
    // Close the child's stdin (immediate EOF). Without this the CLI can block
    // reading stdin in a foreign cwd, and the spawn hangs the full 60s timeout
    // — which under suite load cascades 5s timeouts onto other spawn tests.
    // Matches the established helper pattern (e.g. graph-export.test.ts).
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

function freshWorkspace(label: string): string {
  const tmp = mkdtempSync(nodePath.join(tmpdir(), `r44-${label}-`));
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
  return tmp;
}

describe('CLI registrations', () => {
  test('shrk knowledge add prints a preview and writes nothing by default', () => {
    const r = shrk([
      'knowledge',
      'add',
      '--id',
      'team.r44-style',
      '--title',
      'Team style',
      '--summary',
      'A short summary.',
      '--content',
      'A long enough content body to clear the lint threshold for testing.',
      '--reason',
      'CLI test',
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Knowledge add preview: team.r44-style');
    expect(r.out).toContain('.sharkcraft/authoring/knowledge-add-team-r44-style.draft.ts');
    expect(r.out).toContain('preview only');
  });

  test('shrk knowledge update refuses an unknown id', () => {
    const r = shrk([
      'knowledge',
      'update',
      'project.does-not-exist',
      '--summary',
      'New',
    ]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('refusal:');
    expect(r.out).toMatch(/No entry/);
  });

  test('shrk knowledge remove refuses missing id', () => {
    const r = shrk(['knowledge', 'remove', 'project.does-not-exist']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/nothing to remove/);
  });

  test('shrk knowledge lint --json returns the expected schema', () => {
    const r = shrk(['knowledge', 'lint', '--json']);
    expect(r.code === 0 || r.code === 1).toBe(true);
    // The output may contain JSON; we expect schema string in there.
    // Whitespace-agnostic so it holds for minified (default) and pretty output.
    expect(r.out).toMatch(/"schema":\s*"sharkcraft\.knowledge-lint\/v1"/);
  });

  test('shrk provenance list works with empty ledger', () => {
    const tmp = freshWorkspace('provenance-empty');
    const r = shrk(['provenance', 'list'], tmp);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Provenance entries (0)');
  });

  test('shrk pack author status surfaces every kind', () => {
    const r = shrk(['pack', 'author', 'status']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Pack author status');
    expect(r.out).toContain('knowledge');
    expect(r.out).toContain('search-tuning');
    expect(r.out).toContain('feedback-rule');
    expect(r.out).toContain('agent-test');
  });

  test('shrk pack author pending shows missing-secret guidance when no secret in env', () => {
    const r = shrk(['pack', 'author', 'pending']);
    expect(r.code).toBe(0);
    if (!process.env['SHARKCRAFT_PACK_SECRET']) {
      expect(r.out).toMatch(/SHARKCRAFT_PACK_SECRET/);
    }
  });

  test('shrk packs pending alias is registered', () => {
    const r = shrk(['packs', 'pending']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Pack pending state');
  });

  test('shrk pack author preview --kind knowledge returns implemented=true', () => {
    const r = shrk(['pack', 'author', 'preview', '--kind', 'knowledge', '--id', 'team.style']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('implemented: true');
  });

  test('shrk pack author preview --kind feedback-rule returns deferred', () => {
    const r = shrk(['pack', 'author', 'preview', '--kind', 'feedback-rule', '--id', 'team.flag']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('implemented: false');
    expect(r.out).toContain('knowledge kind is implemented');
  });
});

describe('write-preview round-trip', () => {
  test('knowledge add --write-preview materialises three files and records provenance', () => {
    const tmp = freshWorkspace('add-write-preview');
    const r = shrk(
      [
        'knowledge',
        'add',
        '--id',
        'team.r44-roundtrip',
        '--title',
        'round-trip',
        '--summary',
        'A short summary.',
        '--content',
        'A long enough content body to clear the lint threshold for testing.',
        '--reason',
        'round-trip test',
        '--write-preview',
      ],
      tmp,
    );
    expect(r.code).toBe(0);
    const draft = nodePath.join(
      tmp,
      '.sharkcraft',
      'authoring',
      'knowledge-add-team-r44-roundtrip.draft.ts',
    );
    const manifest = nodePath.join(
      tmp,
      '.sharkcraft',
      'authoring',
      'knowledge-add-team-r44-roundtrip.manifest.json',
    );
    const explainer = nodePath.join(
      tmp,
      '.sharkcraft',
      'authoring',
      'knowledge-add-team-r44-roundtrip.md',
    );
    expect(existsSync(draft)).toBe(true);
    expect(existsSync(manifest)).toBe(true);
    expect(existsSync(explainer)).toBe(true);
    expect(readFileSync(draft, 'utf8')).toContain('id: "team.r44-roundtrip"');
    const provenance = nodePath.join(tmp, '.sharkcraft', 'asset-provenance.jsonl');
    expect(existsSync(provenance)).toBe(true);
    const ledger = readFileSync(provenance, 'utf8');
    expect(ledger).toContain('"team.r44-roundtrip"');
    expect(ledger).toContain('"sharkcraft.asset-provenance/v1"');
    // And the pack-author pending view should see the drafts now:
    const pending = shrk(['pack', 'author', 'pending'], tmp);
    expect(pending.code).toBe(0);
    expect(pending.out).toContain('knowledge-add-team-r44-roundtrip.draft.ts');
    expect(pending.out).toContain('Pending provenance');
  });
});

describe('MCP read-only invariant', () => {
  test('no MCP tool name is a new write surface', async () => {
    const mod = await import('@shrkcrft/mcp-server');
    const tools = (mod as unknown as { ALL_TOOLS: { name: string }[] }).ALL_TOOLS;
    expect(Array.isArray(tools)).toBe(true);
    for (const t of tools) {
      expect(t.name.includes('write')).toBe(false);
      // forbids the following hypothetical write tools — assert they
      // are not present so we don't accidentally ship one.
      expect(t.name).not.toBe('apply_knowledge_authoring');
      expect(t.name).not.toBe('apply_pack_author_preview');
      expect(t.name).not.toBe('record_provenance');
      expect(t.name).not.toBe('write_pack_asset');
      expect(t.name).not.toBe('apply_knowledge_lint_fix');
    }
  });
});

