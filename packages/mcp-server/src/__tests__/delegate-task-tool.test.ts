import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '../tools/index.ts';

const CONFIG = {
  verificationCommands: [{ id: 'barrel-tsc', command: 'tsc --noEmit' }],
  delegation: {
    enabled: true,
    provider: 'auto',
    recipes: [
      {
        id: 'add-barrel-export',
        title: 'Add a re-export line to a barrel index',
        guardrailGlobs: ['src/**/index.ts'],
        allowedOps: ['export', 'ensure-import'],
        verificationIds: ['barrel-tsc'],
        riskCeiling: 'low',
      },
    ],
  },
};

function setupProject(config: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-delegate-task-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.mjs'),
    `export default ${JSON.stringify(config)};\n`,
  );
  return root;
}

async function ctxFor(root: string) {
  const inspection = await inspectSharkcraft({ cwd: root });
  return { cwd: root, inspection };
}

const tool = () => ALL_TOOLS.find((t) => t.name === 'delegate_task')!;

describe('delegate_task MCP tool', () => {
  test('is registered, read-only, mirrors the CLI sibling', () => {
    const t = tool();
    expect(t).toBeDefined();
    expect(t.description.toLowerCase()).toContain('read-only');
    expect(t.cliCommand).toBe('delegate');
  });

  test('returns the recipe fence + a `shrk delegate run` next command', async () => {
    const root = setupProject(CONFIG);
    try {
      const ctx = await ctxFor(root);
      const res = (await tool().handler({ task: "re-export './health'", recipe: 'add-barrel-export' }, ctx)) as {
        data: { recipeId: string; next: string; guardrailGlobs: string[]; allowedOps: string[]; verificationIds: string[]; brief: string };
      };
      expect(res.data.recipeId).toBe('add-barrel-export');
      expect(res.data.next).toContain('shrk delegate run');
      expect(res.data.next).toContain('--recipe add-barrel-export');
      expect(res.data.guardrailGlobs).toEqual(['src/**/index.ts']);
      expect(res.data.allowedOps).toEqual(['export', 'ensure-import']);
      expect(res.data.verificationIds).toEqual(['barrel-tsc']);
      expect(typeof res.data.brief).toBe('string');
      expect(res.data.brief.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('errors on an unknown recipe (lists available)', async () => {
    const root = setupProject(CONFIG);
    try {
      const ctx = await ctxFor(root);
      const res = (await tool().handler({ task: 't', recipe: 'nope' }, ctx)) as { isError?: boolean; error?: { code: string } };
      expect(res.isError).toBe(true);
      expect(res.error?.code).toBe('not-found');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('errors when delegation is not configured', async () => {
    const root = setupProject({ projectName: 'no-delegation' });
    try {
      const ctx = await ctxFor(root);
      const res = (await tool().handler({ task: 't', recipe: 'x' }, ctx)) as { isError?: boolean; error?: { code: string } };
      expect(res.isError).toBe(true);
      expect(res.error?.code).toBe('not-enabled');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('never writes — the tool only returns a brief + next hint', async () => {
    const root = setupProject(CONFIG);
    try {
      const ctx = await ctxFor(root);
      const res = (await tool().handler({ task: 't', recipe: 'add-barrel-export' }, ctx)) as { data?: { note: string } };
      expect(res.data?.note.toLowerCase()).toContain('only write path');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
