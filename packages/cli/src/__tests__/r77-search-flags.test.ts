/**
 * r77 — the `search` group's flags (round 13, lane A; DECISIONS §6).
 *
 * The group parses every subverb's argv, and it declared only `--allow-empty`
 * boolean: in leading or in-path position `--fail-on-dead-units` swallowed the
 * next token — `search --fail-on-dead-units tuning doctor` ran a universal
 * search for "doctor" and `search tuning --fail-on-dead-units doctor` printed
 * the listing, both at exit 0, so the verdict verb became an informational
 * command. `search tuning doctor --format json` printed text, and
 * `--format markdown|html` was advertised but never rendered.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const CLI_MAIN = resolve(import.meta.dir, '..', 'main.ts');
const TIMEOUT_MS = 60_000;
let root = '';

function shrk(argv: readonly string[]): { readonly code: number; readonly out: string; readonly err: string } {
  const r = spawnSync('bun', [CLI_MAIN, '--cwd', root, '--no-hints', ...argv], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'shrk-r77-search-flags-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx', knowledgeFiles: ['knowledge.ts'] };\n",
    'sharkcraft/knowledge.ts':
      "export default [{ id: 'fx.other', title: 'Other', type: 'architecture', priority: 'high', tags: [], content: 'Other.' }];\n",
    // One dead boost: its target is missing and it is not marked.
    'sharkcraft/search-tuning.ts': "export default [{ id: 'fx.t', boostIds: { 'knowledge:fx.retired': 2 } }];\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('r77 search — the verdict verb keeps its flags in every position', () => {
  test(
    'plain: a dead boost key is NOT VERIFIED (2)',
    () => {
      const r = shrk(['search', 'tuning', 'doctor']);
      expect(r.code).toBe(2);
      expect(r.out).toContain('NOT VERIFIED');
    },
    TIMEOUT_MS,
  );

  for (const argv of [
    ['search', 'tuning', 'doctor', '--fail-on-dead-units'],
    ['search', 'tuning', '--fail-on-dead-units', 'doctor'],
    ['search', '--fail-on-dead-units', 'tuning', 'doctor'],
  ]) {
    test(
      `\`shrk ${argv.join(' ')}\` runs the doctor and fails on the dead unit (1)`,
      () => {
        const r = shrk(argv);
        expect({ code: r.code, doctor: r.out.includes('Tuning entries:') }).toEqual({ code: 1, doctor: true });
      },
      TIMEOUT_MS,
    );
  }

  test(
    '--strict in path position no longer swallows the subverb',
    () => {
      const r = shrk(['search', 'tuning', '--strict', 'doctor']);
      expect({ code: r.code, doctor: r.out.includes('Tuning entries:') }).toEqual({ code: 1, doctor: true });
    },
    TIMEOUT_MS,
  );

  test(
    '--format json prints JSON (it printed text); a leading --json does too',
    () => {
      for (const argv of [
        ['search', 'tuning', 'doctor', '--format', 'json'],
        ['search', '--json', 'tuning', 'doctor'],
      ]) {
        const r = shrk(argv);
        expect(r.code).toBe(2);
        const body = JSON.parse(r.out) as { exitCode: number; deadUnits: string[]; units: { dead: string[] } };
        expect(body.exitCode).toBe(2);
        expect(body.deadUnits).toEqual(['search-tuning key knowledge:fx.retired (missing)']);
        expect(body.units.dead.join('\n')).toContain('knowledge:fx.retired');
      }
    },
    TIMEOUT_MS,
  );

  test(
    '`search tuning list` renders text or JSON: --format json is JSON, markdown|html a usage error (2) — never the text listing',
    () => {
      const json = shrk(['search', 'tuning', 'list', '--format', 'json']);
      expect(json.code).toBe(0);
      expect((JSON.parse(json.out) as { id: string }[]).map((e) => e.id)).toEqual(['fx.t']);
      for (const format of ['markdown', 'html']) {
        const r = shrk(['search', 'tuning', 'list', '--format', format]);
        expect({ format, code: r.code, listed: r.out.includes('Search tuning (') }).toEqual({ format, code: 2, listed: false });
        expect(r.err).toContain('--format takes text or json');
      }
    },
    TIMEOUT_MS,
  );

  test(
    '--format markdown|html is a usage error (3) — never a silent text fallback',
    () => {
      for (const format of ['markdown', 'html']) {
        const r = shrk(['search', 'tuning', 'doctor', '--format', format]);
        expect({ format, code: r.code }).toEqual({ format, code: 3 });
        expect(r.err).toContain('--format takes text or json');
      }
    },
    TIMEOUT_MS,
  );
});
