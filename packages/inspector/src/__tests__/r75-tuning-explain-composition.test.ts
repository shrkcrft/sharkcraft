/**
 * r75 — DO-NOT-REGRESS: `search tuning explain` exposes per-key composition.
 *
 * Spec, "Verified working this round — do NOT regress":
 *
 *   "`search tuning explain --json` shows a boost key's applied composition,
 *    which is what proved the 166 doctor warnings in 3.5 were false.
 *    Introspection that contradicts a check is exactly what makes a check
 *    fixable."
 *
 * r14-search-tuning-composition locks `tuningBoostFor` in isolation and
 * r13-tuning-explain only the empty case, so neither reaches the explain
 * REPORT over a real loaded workspace. Round 11 (3.5) rewrites the tuning
 * doctor, whose target resolution has to keep agreeing with this composition,
 * so the composition is locked here first. The fixture is a real mkdtemp
 * workspace (sharkcraft.config.ts + knowledge.ts + search-tuning.ts) loaded by
 * the real inspector, never a hand-built inspection.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { explainSearchTuning, inspectSharkcraft } from '../index.ts';

const TIMEOUT_MS = 30_000;
const DOC_ID = 'knowledge:auth.login-flow';

/**
 * One knowledge entry tagged `auth`, two tunings boosting that same tag, and
 * a task hint on `t.two` that boosts the entry by its FULL `<kind>:<id>` doc id
 * when the query contains `login`.
 */
function tuningWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-tuning-'));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
  writeFileSync(
    join(root, 'sharkcraft', 'knowledge.ts'),
    `export const loginFlow = {
  id: 'auth.login-flow',
  title: 'Auth login flow',
  type: 'architecture',
  priority: 'high',
  tags: ['auth', 'login'],
  content: 'How the auth login flow issues a session token after the password check.',
};
`,
  );
  writeFileSync(
    join(root, 'sharkcraft', 'search-tuning.ts'),
    `export default [
  { id: 't.one', boostTags: { auth: 3 } },
  {
    id: 't.two',
    boostTags: { auth: 2 },
    taskHints: [{ whenTokens: ['login'], boostIds: { '${DOC_ID}': 2 } }],
  },
];
`,
  );
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    `export default { projectName: 'fx', knowledgeFiles: ['knowledge.ts'] };\n`,
  );
  return root;
}

function byTuningId(a: { tuningId: string }, b: { tuningId: string }): number {
  return a.tuningId.localeCompare(b.tuningId);
}

describe('r75 search tuning explain — per-key composition over a real workspace', () => {
  test(
    'two tunings on one tag compose under `tag:auth` with both contributors and the combined value',
    async () => {
      const root = tuningWorkspace();
      try {
        const inspection = await inspectSharkcraft({ cwd: root });
        const report = await explainSearchTuning(inspection, 'auth login');
        expect(report.loadedTunings.map((t) => t.id).sort()).toEqual(['t.one', 't.two']);

        const hit = report.topResults.find((r) => r.docId === DOC_ID);
        expect(hit).toBeDefined();
        const tag = hit!.composition?.find((c) => c.key === 'tag:auth');
        expect(tag).toBeDefined();
        expect(tag!.strategy).toBe('sum');
        expect([...tag!.contributors].sort(byTuningId)).toEqual([
          { tuningId: 't.one', value: 3 },
          { tuningId: 't.two', value: 2 },
        ]);
        expect(tag!.combined).toBe(5);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS,
  );

  test(
    'a task hint keyed by the full `<kind>:<id>` doc id surfaces as a task-hint reason AND a composition key',
    async () => {
      const root = tuningWorkspace();
      try {
        const inspection = await inspectSharkcraft({ cwd: root });
        const report = await explainSearchTuning(inspection, 'auth login');
        const hit = report.topResults.find((r) => r.docId === DOC_ID);
        expect(hit).toBeDefined();

        const reason = hit!.reasons.find((r) => r.includes(`task-hint:id:${DOC_ID}`));
        expect(reason).toBeDefined();
        expect(reason).toContain('tuning:t.two');
        expect(reason).toContain('+2');

        const hintKey = hit!.composition?.find((c) => c.key === `task-hint:id:${DOC_ID}`);
        expect(hintKey).toBeDefined();
        expect([...hintKey!.contributors]).toEqual([{ tuningId: 't.two', value: 2 }]);
        expect(hintKey!.combined).toBe(2);

        // "Applied" composition: the per-key values account for the whole
        // delta the tuning moved this hit by (well under the global cap).
        const applied = (hit!.composition ?? []).reduce((sum, c) => sum + c.combined, 0);
        expect(applied).toBe(7);
        expect(hit!.delta).toBe(applied);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS,
  );

  test(
    'a task hint whose whenTokens are absent from the query contributes nothing to the composition',
    async () => {
      // The negative control that keeps the positive assertions honest: the
      // report shows what was APPLIED, not every key a tuning declares.
      const root = tuningWorkspace();
      try {
        const inspection = await inspectSharkcraft({ cwd: root });
        const report = await explainSearchTuning(inspection, 'auth');
        const hit = report.topResults.find((r) => r.docId === DOC_ID);
        expect(hit).toBeDefined();
        expect((hit!.composition ?? []).map((c) => c.key)).toEqual(['tag:auth']);
        expect(hit!.reasons.some((r) => r.includes('task-hint:'))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS,
  );
});
