import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDelegateAnalysisReport,
  buildDelegateFailureFacts,
  crossCheckFindings,
  runGroundingReport,
  type IDelegateFailureContext,
  type IGroundingFacts,
} from '../delegate-grounding.ts';
import { inspectSharkcraft } from '../sharkcraft-inspector.ts';

const FACTS: IGroundingFacts = {
  groundedOn: 'task-risk',
  summary: 'Task risk: high (score 20).',
  entities: ['src/foo.ts', 'high-fan-in-file', 'boundary-violations-error'],
  raw: null,
};

describe('crossCheckFindings', () => {
  test('a finding whose refs all resolve is grounded', () => {
    const r = crossCheckFindings([{ message: 'risky', refs: ['src/foo.ts'] }], FACTS);
    expect(r.groundedCount).toBe(1);
    expect(r.unverifiedCount).toBe(0);
    expect(r.findings[0]?.grounded).toBe(true);
  });

  test('a ref matched by basename is grounded', () => {
    const r = crossCheckFindings([{ message: 'x', refs: ['foo.ts'] }], FACTS);
    expect(r.findings[0]?.grounded).toBe(true);
  });

  test('a ref echoing the display form (brackets/backticks) still grounds', () => {
    // A real local model cited reason codes as `[boundary-violations-error]` and
    // files as `` `src/foo.ts` `` — the surrounding delimiters must not un-ground it.
    const r = crossCheckFindings(
      [
        { message: 'a', refs: ['[boundary-violations-error]'] },
        { message: 'b', refs: ['`src/foo.ts`'] },
      ],
      FACTS,
    );
    expect(r.findings[0]?.grounded).toBe(true);
    expect(r.findings[1]?.grounded).toBe(true);
    expect(r.groundedCount).toBe(2);
  });

  test('a fabricated ref is flagged unverified (kept, not dropped, by default)', () => {
    const r = crossCheckFindings([{ message: 'made up', refs: ['src/ghost.ts'] }], FACTS);
    expect(r.groundedCount).toBe(0);
    expect(r.unverifiedCount).toBe(1);
    expect(r.findings[0]?.grounded).toBe(false);
    expect(r.findings[0]?.unverifiedRefs).toEqual(['src/ghost.ts']);
  });

  test('an unanchored finding (no refs, no entity mention) is unverified', () => {
    const r = crossCheckFindings([{ message: 'vague claim about nothing' }], FACTS);
    expect(r.findings[0]?.grounded).toBe(false);
    expect(r.unverifiedCount).toBe(1);
  });

  test('a finding with no refs but a ground-truth entity in its message is grounded (prose fallback)', () => {
    // A real model (gpt-oss:120b) stated facts in prose without a refs array —
    // "greet is declared in src/foo.ts"; the mention must ground it.
    const r = crossCheckFindings(
      [
        { message: 'The greet function is declared in src/foo.ts at line 1.' },
        { message: 'high-fan-in-file is a hotspot to be careful with.' },
      ],
      FACTS,
    );
    expect(r.groundedCount).toBe(2);
    expect(r.findings[0]?.grounded).toBe(true);
    expect(r.findings[0]?.refs).toContain('src/foo.ts');
  });

  test('a finding with one bad ref among good ones is not grounded', () => {
    const r = crossCheckFindings([{ message: 'x', refs: ['src/foo.ts', 'src/ghost.ts'] }], FACTS);
    expect(r.findings[0]?.grounded).toBe(false);
    expect(r.findings[0]?.unverifiedRefs).toEqual(['src/ghost.ts']);
  });

  test('strict mode DROPS non-grounded findings', () => {
    const r = crossCheckFindings(
      [
        { message: 'grounded', refs: ['src/foo.ts'] },
        { message: 'fabricated', refs: ['src/ghost.ts'] },
      ],
      FACTS,
      { strict: true },
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.message).toBe('grounded');
    expect(r.groundedCount).toBe(1);
    expect(r.unverifiedCount).toBe(1); // the dropped one still counts as unverified
  });
});

describe('buildDelegateAnalysisReport', () => {
  test('grounding-only report when no model ran', () => {
    const report = buildDelegateAnalysisReport({
      recipeId: 'arch-risk-review',
      groundedOn: 'task-risk',
      task: 'refactor the loader',
      provider: 'none',
      facts: FACTS,
      crossCheck: crossCheckFindings([], FACTS),
      modelUnavailable: true,
      generatedAt: '2026-07-03T00:00:00.000Z',
    });
    expect(report.mode).toBe('analysis');
    expect(report.findings).toHaveLength(0);
    expect(report.provider).toBe('none');
    expect(report.markdown).toContain('No local LLM');
    expect(report.markdown).toContain('Task risk: high'); // the ground truth is surfaced
    expect(report.uncertainty.confidence).toBe('unknown');
  });

  test('tags grounded vs unverified findings in the markdown', () => {
    const report = buildDelegateAnalysisReport({
      recipeId: 'arch-risk-review',
      groundedOn: 'task-risk',
      task: 't',
      provider: 'fake-model',
      facts: FACTS,
      crossCheck: crossCheckFindings(
        [
          { message: 'real risk', refs: ['src/foo.ts'] },
          { message: 'invented risk', refs: ['src/ghost.ts'] },
        ],
        FACTS,
      ),
      generatedAt: '2026-07-03T00:00:00.000Z',
    });
    expect(report.groundedCount).toBe(1);
    expect(report.unverifiedCount).toBe(1);
    expect(report.markdown).toContain('✓ grounded');
    expect(report.markdown).toContain('⚠ unverified');
  });

  test('surfaces an escalation hint + fan-out count when provided', () => {
    const report = buildDelegateAnalysisReport({
      recipeId: 'test-gap-scan',
      groundedOn: 'test-impact',
      task: 't',
      provider: 'fake',
      facts: FACTS,
      crossCheck: crossCheckFindings([{ message: 'missing test', refs: ['src/foo.ts'] }], FACTS),
      escalateTo: 'scaffold-test-stub',
      fanOutSlices: 3,
      generatedAt: '2026-07-04T00:00:00.000Z',
    });
    expect(report.escalation?.recipe).toBe('scaffold-test-stub');
    expect(report.fanOutSlices).toBe(3);
    expect(report.markdown).toContain('Suggested escalation');
    expect(report.markdown).toContain('fan-out slices: 3');
  });
});

describe('buildDelegateFailureFacts', () => {
  test('collects refused + dropped-op + verification entities from a failure', () => {
    const facts = buildDelegateFailureFacts({
      status: 'verify-failed',
      message: 'tsc failed',
      refused: ['sharkcraft.config.mjs'],
      droppedOps: [{ kind: 'replace', targetPath: 'src/a.ts' }],
      commandsFailed: ['barrel-tsc'],
    });
    expect(facts.entities).toContain('sharkcraft.config.mjs');
    expect(facts.entities).toContain('src/a.ts');
    expect(facts.entities).toContain('barrel-tsc');
    expect(facts.entities).toContain('verify-failed');
    expect(facts.summary).toContain('tsc failed');
  });
});

describe('runGroundingReport', () => {
  test('unknown grounding id degrades to empty ground truth (defensive)', async () => {
    // A bogus id (never reached in practice — config validation gates it).
    const facts = await runGroundingReport('bogus', 'task', {} as never);
    expect(facts.entities).toEqual([]);
    expect(facts.summary).toContain('no grounding runner');
  });

  test('delegate-failure grounding builds facts from the supplied failure', async () => {
    const failure: IDelegateFailureContext = {
      status: 'conflicts',
      message: 'plan diverged',
      conflicts: ['src/missing.ts: no such file'],
      allowedOps: ['export'],
      attempt: 1,
    };
    const facts = await runGroundingReport('delegate-failure', 't', {} as never, { failure });
    expect(facts.groundedOn).toBe('delegate-failure');
    expect(facts.entities).toContain('src/missing.ts');
    expect(facts.entities).toContain('export');
    expect(facts.summary).toContain('conflicts');
  });

  test('delegate-failure grounding without a failure context degrades to empty', async () => {
    const facts = await runGroundingReport('delegate-failure', 't', {} as never, {});
    expect(facts.entities).toEqual([]);
    expect(facts.summary).toContain('needs a failure context');
  });

  test('plan-simulation grounding without a plan path degrades to empty', async () => {
    const facts = await runGroundingReport('plan-simulation', 't', {} as never, {});
    expect(facts.entities).toEqual([]);
    expect(facts.summary).toContain('needs a --plan');
  });

  test('task-risk grounding wires to the deterministic report over a real project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-grounding-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'index.ts'), 'export const a = 1;\n');
      const inspection = await inspectSharkcraft({ cwd: root });
      const facts = await runGroundingReport('task-risk', 'refactor the index', inspection);
      expect(facts.groundedOn).toBe('task-risk');
      expect(facts.summary).toContain('Task risk');
      expect(Array.isArray(facts.entities)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('agent-brief grounding wires to the deterministic brief over a real project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-grounding-ab-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'index.ts'), 'export const a = 1;\n');
      const inspection = await inspectSharkcraft({ cwd: root });
      const facts = await runGroundingReport('agent-brief', 'refactor the index', inspection);
      expect(facts.groundedOn).toBe('agent-brief');
      expect(facts.summary).toContain('Agent brief');
      expect(Array.isArray(facts.entities)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('test-impact grounding wires to the deterministic report over a real project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-grounding-ti-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'bun test' } }));
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'index.ts'), 'export const a = 1;\n');
      const inspection = await inspectSharkcraft({ cwd: root });
      const facts = await runGroundingReport('test-impact', 'src/index.ts', inspection);
      expect(facts.groundedOn).toBe('test-impact');
      expect(facts.summary).toContain('Test impact');
      expect(Array.isArray(facts.entities)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
