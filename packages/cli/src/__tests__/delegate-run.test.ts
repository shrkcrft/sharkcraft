import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok, type AppError, type Result } from '@shrkcrft/core';
import type { IAiProvider, IAiRequest, IAiResponse } from '@shrkcrft/ai';
import type { IDelegateRecipe } from '@shrkcrft/config';
import { executeDelegateRun } from '../commands/delegate.command.ts';

const SECRET = 'delegate-test-secret';
const BARREL = "export * from './a';\n";

/** A provider that returns a canned edit — no model, deterministic for tests. */
function fakeProvider(ops: unknown[]): IAiProvider {
  return {
    id: 'fake',
    name: 'fake',
    configure() {},
    isReady() {
      return true;
    },
    async send(_request: IAiRequest): Promise<Result<IAiResponse, AppError>> {
      return ok({ content: JSON.stringify({ ops }), model: 'fake-model' });
    },
  };
}

/** A provider that returns a different canned edit per call (last repeats). */
function fakeProviderSeq(outputs: unknown[][]): IAiProvider {
  let i = 0;
  return {
    id: 'fake-seq',
    name: 'fake-seq',
    configure() {},
    isReady() {
      return true;
    },
    async send(): Promise<Result<IAiResponse, AppError>> {
      const ops = outputs[Math.min(i, outputs.length - 1)];
      i += 1;
      return ok({ content: JSON.stringify({ ops }), model: 'fake-model' });
    },
  };
}

function setupProject(verificationCommands: Array<{ id: string; command: string }>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-delegate-e2e-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'delegate-demo' }));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'index.ts'), BARREL);
  // The config loader resolves `sharkcraft.config.*` inside a `sharkcraft/` dir.
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.mjs'),
    `export default ${JSON.stringify({ verificationCommands }, null, 2)};\n`,
  );
  return root;
}

const RECIPE = (verificationIds: string[]): IDelegateRecipe => ({
  id: 'add-barrel-export',
  title: 'Add a barrel export',
  guardrailGlobs: ['src/**'],
  allowedOps: ['export'],
  verificationIds,
});

describe('executeDelegateRun (e2e, fake provider)', () => {
  test('no provider → deterministic no-op, not an error', async () => {
    const root = setupProject([]);
    try {
      const r = await executeDelegateRun({
        task: 'add export of ./added',
        recipe: RECIPE([]),
        projectRoot: root,
        provider: null,
        apply: true,
        planSecret: SECRET,
      });
      expect(r.status).toBe('no-provider');
      expect(readFileSync(join(root, 'src', 'index.ts'), 'utf8')).toBe(BARREL);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('happy path: export op → sign → apply → verification passes', async () => {
    const root = setupProject([
      { id: 'barrel-has-export', command: "grep -q \"from './added'\" src/index.ts" },
    ]);
    try {
      const r = await executeDelegateRun({
        task: "add export of './added' to the barrel",
        recipe: RECIPE(['barrel-has-export']),
        projectRoot: root,
        provider: fakeProvider([{ targetPath: 'src/index.ts', operation: { kind: 'export', from: './added' } }]),
        apply: true,
        planSecret: SECRET,
      });
      expect(r.status).toBe('applied');
      expect(r.verification?.passed).toBe(true);
      expect(readFileSync(join(root, 'src', 'index.ts'), 'utf8')).toContain("export * from './added';");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('applied result carries a compact diff of exactly what changed', async () => {
    const root = setupProject([
      { id: 'barrel-has-export', command: "grep -q \"from './added'\" src/index.ts" },
    ]);
    try {
      const r = await executeDelegateRun({
        task: "add export of './added'",
        recipe: RECIPE(['barrel-has-export']),
        projectRoot: root,
        provider: fakeProvider([{ targetPath: 'src/index.ts', operation: { kind: 'export', from: './added' } }]),
        apply: true,
        planSecret: SECRET,
      });
      expect(r.status).toBe('applied');
      expect(r.diff).toBeDefined();
      // The unified diff shows the added export line (an added `+` line).
      expect(r.diff).toContain("export * from './added';");
      expect(r.diff).toContain('src/index.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('verification FAILS → edit is auto-reverted', async () => {
    const root = setupProject([{ id: 'always-fails', command: 'false' }]);
    try {
      const r = await executeDelegateRun({
        task: "add export of './added'",
        recipe: RECIPE(['always-fails']),
        projectRoot: root,
        provider: fakeProvider([{ targetPath: 'src/index.ts', operation: { kind: 'export', from: './added' } }]),
        apply: true,
        planSecret: SECRET,
      });
      expect(r.status).toBe('verify-failed');
      expect(r.reverted).toBe(true);
      // The broken edit must NOT be left on disk.
      expect(readFileSync(join(root, 'src', 'index.ts'), 'utf8')).toBe(BARREL);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('target outside the guardrail globs is refused before any write', async () => {
    const root = setupProject([]);
    try {
      const r = await executeDelegateRun({
        task: 'sneak an edit outside src',
        recipe: RECIPE([]),
        projectRoot: root,
        provider: fakeProvider([{ targetPath: 'sharkcraft.config.mjs', operation: { kind: 'export', from: './evil' } }]),
        apply: true,
        planSecret: SECRET,
      });
      expect(r.status).toBe('guardrail-refused');
      expect(r.refused).toEqual(['sharkcraft.config.mjs']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects a `..` traversal that escapes the guardrail dir but stays in-root', async () => {
    const root = setupProject([{ id: 'barrel-has-export', command: 'true' }]);
    try {
      const before = readFileSync(join(root, 'package.json'), 'utf8');
      const r = await executeDelegateRun({
        task: 'escape via traversal',
        // guardrail is src/** but the worker tries to climb out to package.json.
        recipe: RECIPE(['barrel-has-export']),
        projectRoot: root,
        provider: fakeProvider([{ targetPath: 'src/../package.json', operation: { kind: 'export', from: './evil' } }]),
        apply: true,
        planSecret: SECRET,
      });
      expect(r.status).toBe('guardrail-refused');
      // The fence must hold: package.json is untouched even though `src/**`'s
      // `**` would have matched the raw `src/../package.json` string.
      expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a disallowed op kind is dropped, and an all-dropped edit is refused', async () => {
    const root = setupProject([{ id: 'barrel-has-export', command: 'true' }]);
    try {
      const r = await executeDelegateRun({
        task: 'try a replace (not allowed)',
        recipe: RECIPE(['barrel-has-export']),
        projectRoot: root,
        provider: fakeProvider([{ targetPath: 'src/index.ts', operation: { kind: 'replace', find: 'a', replaceWith: 'b' } }]),
        apply: true,
        planSecret: SECRET,
      });
      // The only op was a disallowed kind → packaging refuses, nothing written.
      expect(r.status).toBe('package-error');
      expect(readFileSync(join(root, 'src', 'index.ts'), 'utf8')).toBe(BARREL);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses to apply when the recipe has no verificationIds (no gate)', async () => {
    const root = setupProject([]);
    try {
      const r = await executeDelegateRun({
        task: "add export of './added'",
        recipe: RECIPE([]),
        projectRoot: root,
        provider: fakeProvider([{ targetPath: 'src/index.ts', operation: { kind: 'export', from: './added' } }]),
        apply: true,
        planSecret: SECRET,
      });
      expect(r.status).toBe('no-verification');
      // The unverified edit must NOT have landed.
      expect(readFileSync(join(root, 'src', 'index.ts'), 'utf8')).toBe(BARREL);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('closed loop: retries with feedback after a conflict, then succeeds', async () => {
    const root = setupProject([
      { id: 'barrel-has-export', command: "grep -q \"from './added'\" src/index.ts" },
    ]);
    try {
      const r = await executeDelegateRun({
        task: "add export of './added'",
        recipe: RECIPE(['barrel-has-export']),
        projectRoot: root,
        provider: fakeProviderSeq([
          // Attempt 1: a barrel that does not exist → conflict (retryable).
          [{ targetPath: 'src/missing.ts', operation: { kind: 'export', from: './added' } }],
          // Attempt 2: the real barrel → applies + verifies.
          [{ targetPath: 'src/index.ts', operation: { kind: 'export', from: './added' } }],
        ]),
        apply: true,
        planSecret: SECRET,
      });
      expect(r.status).toBe('applied');
      expect(r.attempts).toBe(2);
      expect(readFileSync(join(root, 'src', 'index.ts'), 'utf8')).toContain("export * from './added';");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('escalates after maxAttempts when every attempt fails', async () => {
    const root = setupProject([{ id: 'barrel-has-export', command: 'true' }]);
    try {
      const r = await executeDelegateRun({
        task: 'add export',
        recipe: { ...RECIPE(['barrel-has-export']), maxAttempts: 2 },
        projectRoot: root,
        provider: fakeProviderSeq([
          [{ targetPath: 'src/missing.ts', operation: { kind: 'export', from: './x' } }],
        ]),
        apply: true,
        planSecret: SECRET,
      });
      expect(r.status).toBe('conflicts');
      expect(r.attempts).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('without --apply, a signed plan is written but not applied', async () => {
    const root = setupProject([]);
    try {
      const r = await executeDelegateRun({
        task: "add export of './added'",
        recipe: RECIPE([]),
        projectRoot: root,
        provider: fakeProvider([{ targetPath: 'src/index.ts', operation: { kind: 'export', from: './added' } }]),
        apply: false,
        planSecret: SECRET,
      });
      expect(r.status).toBe('generated');
      expect(r.planPath).toBeDefined();
      // Source untouched — only the plan file was written.
      expect(readFileSync(join(root, 'src', 'index.ts'), 'utf8')).toBe(BARREL);
      // But a PREVIEW diff shows what the worker would write (review before apply).
      expect(r.diff).toBeDefined();
      expect(r.diff).toContain("export * from './added';");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
