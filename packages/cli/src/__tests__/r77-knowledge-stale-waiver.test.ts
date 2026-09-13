/**
 * r77 — knowledge stale-check: the ✓ line never contradicts a STALE row above
 * it (round 13, lane A; DECISIONS §6, V3 skeptic "the knowledge plane already
 * HAS a per-reference valve").
 *
 * `required: false` (the default) is honoured by `--ci` / `--strict` / `--fail-on
 * required`: a missing non-required reference does not fail the run. But the
 * run printed its STALE row and then "N of M knowledge entries verified — no
 * stale or missing references. ✓", with no acceptance recorded. The waiver is
 * now an acceptance (`accepted by required: false …`, in `gate.accepted`), and
 * the ✓ sentence names the waived references instead of denying them.
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
  root = mkdtempSync(join(tmpdir(), 'shrk-r77-knowledge-waiver-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx', knowledgeFiles: ['knowledge.ts'] };\n",
    'src/a.ts': 'export const a = 1;\n',
    'sharkcraft/knowledge.ts': `export default [
  { id: 'fx.live', title: 'Live', type: 'architecture', priority: 'high', tags: [], content: 'About a.', references: [{ kind: 'file', path: 'src/a.ts' }] },
  { id: 'fx.planned', title: 'Planned', type: 'architecture', priority: 'high', tags: [], content: 'The widget layout.', references: [{ kind: 'file', path: 'src/widgets/vue/widget.ts', note: 'planned' }] },
];
`,
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('r77 knowledge stale-check — the required:false waiver is an acceptance', () => {
  test(
    '--ci: exit 0, the STALE row stays, the ✓ line names the waived reference and the acceptance is printed',
    () => {
      const r = shrk(['knowledge', 'stale-check', '--ci']);
      expect(r.code).toBe(0);
      expect(r.out).toContain('src/widgets/vue/widget.ts');
      expect(r.out).not.toContain('no stale or missing references');
      expect(r.out).toContain('1 failing reference(s) listed above do not block this mode');
      expect(r.out).toContain('accepted by required: false (--ci fails on required references only)');
      const json = JSON.parse(shrk(['knowledge', 'stale-check', '--ci', '--json']).out) as { gate: { exit: number; accepted: string[] } };
      expect(json.gate.exit).toBe(0);
      expect(json.gate.accepted.join('\n')).toContain('accepted by required: false');
      expect(json.gate.accepted.join('\n')).toContain('fx.planned → file:src/widgets/vue/widget.ts');
    },
    TIMEOUT_MS,
  );

  test(
    '--fail-on required names the categories that waived it; the legacy default still fails (1), with no acceptance',
    () => {
      const required = shrk(['knowledge', 'stale-check', '--fail-on', 'required']);
      expect(required.code).toBe(0);
      expect(required.out).toContain('accepted by the fail-on categories (required)');
      const legacy = shrk(['knowledge', 'stale-check']);
      expect(legacy.code).toBe(1);
      expect(legacy.out).not.toContain('accepted by');
    },
    TIMEOUT_MS,
  );
});
