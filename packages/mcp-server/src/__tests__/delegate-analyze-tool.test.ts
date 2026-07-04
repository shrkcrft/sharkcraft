import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '../tools/index.ts';

const CONFIG = {
  verificationCommands: [{ id: 'barrel-tsc', command: 'tsc --noEmit' }],
  delegation: {
    enabled: true,
    recipes: [
      { id: 'arch-risk-review', title: 'Architecture / risk review', mode: 'analysis', groundedOn: 'task-risk' },
      { id: 'retry-analysis', mode: 'analysis', groundedOn: 'delegate-failure' },
      { id: 'plan-critique', mode: 'analysis', groundedOn: 'plan-simulation' },
      { id: 'add-barrel-export', guardrailGlobs: ['src/**/index.ts'], allowedOps: ['export'], verificationIds: ['barrel-tsc'] },
    ],
  },
};

function setupProject(config: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-delegate-analyze-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'index.ts'), 'export const a = 1;\n');
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(join(root, 'sharkcraft', 'sharkcraft.config.mjs'), `export default ${JSON.stringify(config)};\n`);
  return root;
}

async function ctxFor(root: string) {
  const inspection = await inspectSharkcraft({ cwd: root });
  return { cwd: root, inspection };
}

const tool = () => ALL_TOOLS.find((t) => t.name === 'delegate_analyze')!;

describe('delegate_analyze MCP tool', () => {
  test('is registered, mirrors the CLI sibling, and never runs a model', () => {
    const t = tool();
    expect(t).toBeDefined();
    expect(t.cliCommand).toBe('delegate');
    expect(t.description.toLowerCase()).toContain('never runs a model');
  });

  test('returns the deterministic grounding + a `shrk delegate analyze` next command', async () => {
    const root = setupProject(CONFIG);
    try {
      const ctx = await ctxFor(root);
      const res = (await tool().handler({ task: 'refactor the index', recipe: 'arch-risk-review' }, ctx)) as {
        data: { recipeId: string; mode: string; groundedOn: string; grounding: string; next: string; note: string };
      };
      expect(res.data.recipeId).toBe('arch-risk-review');
      expect(res.data.mode).toBe('analysis');
      expect(res.data.groundedOn).toBe('task-risk');
      expect(res.data.next).toContain('shrk delegate analyze');
      expect(res.data.next).toContain('--recipe arch-risk-review');
      expect(typeof res.data.grounding).toBe('string');
      expect(res.data.grounding.length).toBeGreaterThan(0);
      expect(res.data.note.toLowerCase()).toContain('never runs a model');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects a patch recipe (points at delegate_task / delegate run)', async () => {
    const root = setupProject(CONFIG);
    try {
      const ctx = await ctxFor(root);
      const res = (await tool().handler({ task: 't', recipe: 'add-barrel-export' }, ctx)) as { isError?: boolean; error?: { code: string } };
      expect(res.isError).toBe(true);
      expect(res.error?.code).toBe('not-analysis');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects a delegate-failure recipe (only runs in the retry loop)', async () => {
    const root = setupProject(CONFIG);
    try {
      const ctx = await ctxFor(root);
      const res = (await tool().handler({ task: 't', recipe: 'retry-analysis' }, ctx)) as { isError?: boolean; error?: { code: string } };
      expect(res.isError).toBe(true);
      expect(res.error?.code).toBe('needs-failure-context');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a plan-simulation recipe without a plan path asks for one', async () => {
    const root = setupProject(CONFIG);
    try {
      const ctx = await ctxFor(root);
      const res = (await tool().handler({ task: 't', recipe: 'plan-critique' }, ctx)) as { isError?: boolean; error?: { code: string } };
      expect(res.isError).toBe(true);
      expect(res.error?.code).toBe('needs-plan');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('errors on an unknown recipe and when delegation is not configured', async () => {
    const root = setupProject(CONFIG);
    const bare = setupProject({ projectName: 'no-delegation' });
    try {
      const ctx = await ctxFor(root);
      const unknown = (await tool().handler({ task: 't', recipe: 'nope' }, ctx)) as { isError?: boolean; error?: { code: string } };
      expect(unknown.error?.code).toBe('not-found');
      const bareCtx = await ctxFor(bare);
      const notEnabled = (await tool().handler({ task: 't', recipe: 'x' }, bareCtx)) as { isError?: boolean; error?: { code: string } };
      expect(notEnabled.error?.code).toBe('not-enabled');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test('the tool module never imports @shrkcrft/ai (MCP never runs a model)', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'tools', 'delegate-analyze.tool.ts'), 'utf8');
    expect(src.includes('@shrkcrft/ai')).toBe(false);
  });
});
