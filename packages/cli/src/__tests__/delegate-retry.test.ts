import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok, type AppError, type Result } from '@shrkcrft/core';
import type { IAiProvider, IAiRequest, IAiResponse } from '@shrkcrft/ai';
import type { IGroundingFacts, IResolvedDelegateRecipe } from '@shrkcrft/inspector';
import {
  buildRetryAnalysisAdvisor,
  correctedInstruction,
  executeDelegateRun,
} from '../commands/delegate.command.ts';
import { buildDelegateAnalysisReport, crossCheckFindings } from '@shrkcrft/inspector';

const SECRET = 'retry-test-secret';
const BARREL = "export * from './a';\n";

/** A provider that records the messages it received and returns canned ops per call. */
function recordingSeqProvider(outputs: unknown[][]): { provider: IAiProvider; calls: IAiRequest[] } {
  const calls: IAiRequest[] = [];
  let i = 0;
  const provider: IAiProvider = {
    id: 'rec',
    name: 'rec',
    configure() {},
    isReady() {
      return true;
    },
    async send(request: IAiRequest): Promise<Result<IAiResponse, AppError>> {
      calls.push(request);
      const ops = outputs[Math.min(i, outputs.length - 1)];
      i += 1;
      return ok({ content: JSON.stringify({ ops }), model: 'fake' });
    },
  };
  return { provider, calls };
}

function fakeAnalysisProvider(findings: unknown[]): IAiProvider {
  return {
    id: 'fa',
    name: 'fa',
    configure() {},
    isReady() {
      return true;
    },
    async send(): Promise<Result<IAiResponse, AppError>> {
      return ok({ content: JSON.stringify({ findings }), model: 'fake-model' });
    },
  };
}

function setupProject(verificationCommands: Array<{ id: string; command: string }>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-delegate-retry-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'retry-demo' }));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'index.ts'), BARREL);
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.mjs'),
    `export default ${JSON.stringify({ verificationCommands }, null, 2)};\n`,
  );
  return root;
}

function analysisRecipe(over: Partial<IResolvedDelegateRecipe> = {}): IResolvedDelegateRecipe {
  return {
    id: 'retry-analysis',
    mode: 'analysis',
    groundedOn: 'delegate-failure',
    resolvedProvider: 'auto',
    guardrailGlobs: [],
    allowedOps: [],
    verificationIds: [],
    unboundVerificationIds: [],
    verificationBound: false,
    groundingBound: true,
    delegatable: true,
    source: 'config',
    ...over,
  };
}

describe('executeDelegateRun — assisted retry', () => {
  test('the corrected instruction from the advisor reaches the next attempt prompt', async () => {
    const root = setupProject([{ id: 'has-added', command: "grep -q \"from './added'\" src/index.ts" }]);
    try {
      const { provider, calls } = recordingSeqProvider([
        // Attempt 1: a barrel that does not exist → conflict (retryable).
        [{ targetPath: 'src/missing.ts', operation: { kind: 'export', from: './added' } }],
        // Attempt 2: the real barrel → applies + verifies.
        [{ targetPath: 'src/index.ts', operation: { kind: 'export', from: './added' } }],
      ]);
      const r = await executeDelegateRun({
        task: "add export of './added'",
        recipe: {
          id: 'add-barrel-export',
          guardrailGlobs: ['src/**'],
          allowedOps: ['export'],
          verificationIds: ['has-added'],
          maxAttempts: 2,
        },
        projectRoot: root,
        provider,
        apply: true,
        planSecret: SECRET,
        retryAdvisor: async () => 'target the real barrel src/index.ts',
      });
      expect(r.status).toBe('applied');
      expect(r.attempts).toBe(2);
      // The 2nd model call must carry the advisor's corrected instruction.
      const secondCallText = calls[1]!.messages.map((m) => m.content).join('\n');
      expect(secondCallText).toContain('Diagnostic hint: target the real barrel src/index.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a throwing advisor never blocks the deterministic loop', async () => {
    const root = setupProject([{ id: 'has-added', command: "grep -q \"from './added'\" src/index.ts" }]);
    try {
      const { provider } = recordingSeqProvider([
        [{ targetPath: 'src/missing.ts', operation: { kind: 'export', from: './added' } }],
        [{ targetPath: 'src/index.ts', operation: { kind: 'export', from: './added' } }],
      ]);
      const r = await executeDelegateRun({
        task: 'add export',
        recipe: { id: 'x', guardrailGlobs: ['src/**'], allowedOps: ['export'], verificationIds: ['has-added'], maxAttempts: 2 },
        projectRoot: root,
        provider,
        apply: true,
        planSecret: SECRET,
        retryAdvisor: async () => {
          throw new Error('advisor exploded');
        },
      });
      expect(r.status).toBe('applied');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('buildRetryAnalysisAdvisor', () => {
  const failure = { status: 'conflicts', message: 'diverged', conflicts: ['src/index.ts: bad anchor'], allowedOps: ['export'] };

  test('returns the grounded corrected instruction from the analysis model', async () => {
    const advisor = buildRetryAnalysisAdvisor({
      retryRecipe: analysisRecipe(),
      provider: fakeAnalysisProvider([{ message: 'use src/index.ts', refs: ['src/index.ts'] }]),
      providerLabel: 'ollama',
      patchRecipeId: 'add-barrel-export',
    });
    expect(await advisor(failure, 1)).toBe('use src/index.ts');
  });

  test('returns null when no local model is available', async () => {
    const advisor = buildRetryAnalysisAdvisor({
      retryRecipe: analysisRecipe(),
      provider: null,
      providerLabel: 'none',
      patchRecipeId: 'add-barrel-export',
    });
    expect(await advisor(failure, 1)).toBeNull();
  });
});

describe('correctedInstruction', () => {
  const facts: IGroundingFacts = { groundedOn: 'delegate-failure', summary: '', entities: ['src/index.ts'], raw: null };
  const report = (rawFindings: { message: string; refs?: string[] }[], modelNote?: string) =>
    buildDelegateAnalysisReport({
      recipeId: 'retry-analysis',
      groundedOn: 'delegate-failure',
      task: 't',
      provider: 'fake',
      facts,
      crossCheck: crossCheckFindings(rawFindings, facts),
      ...(modelNote ? { modelNote } : {}),
      generatedAt: '2026-07-03T00:00:00.000Z',
    });

  test('a grounded finding wins', () => {
    expect(correctedInstruction(report([{ message: 'grounded', refs: ['src/index.ts'] }, { message: 'other' }]))).toBe('grounded');
  });

  test('falls back to the model note when there are no findings', () => {
    expect(correctedInstruction(report([], 'a note'))).toBe('a note');
  });

  test('returns null when there is nothing to say', () => {
    expect(correctedInstruction(report([]))).toBeNull();
  });
});
