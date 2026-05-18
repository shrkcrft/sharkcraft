/**
 * Phase 1 surface tests.
 *
 * Covers:
 *  - shrk init --zero-config picks a preset from detected profiles and
 *    defaults to dry-run.
 *  - shrk ci scaffold github-actions --quickstart emits the sensible-default
 *    bundle and respects asset presence (no template drift gate when
 *    sharkcraft/templates.ts is absent).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { initCommand } from '../commands/init.command.ts';
import { ciCommand } from '../commands/ci.command.ts';

let tmpRoot = '';

beforeAll(() => {
  tmpRoot = mkdtempSync(nodePath.join(tmpdir(), 'shrk-r45-'));
});

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

function makeProject(name: string, files: Record<string, string>): string {
  const dir = nodePath.join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = nodePath.join(dir, rel);
    mkdirSync(nodePath.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

async function captureStdout(fn: () => Promise<number> | number): Promise<{
  exit: number;
  out: string;
}> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout.write as unknown) = (c: any): boolean => {
    chunks.push(typeof c === 'string' ? c : c.toString('utf8'));
    return true;
  };
  try {
    const exit = await fn();
    return { exit, out: chunks.join('') };
  } finally {
    (process.stdout.write as unknown) = orig;
  }
}

describe('adoption floor', () => {
  test('shrk init --zero-config picks next-app for a Next.js fixture and defaults to dry-run', async () => {
    const dir = makeProject('next-fixture', {
      'package.json': JSON.stringify({
        name: 'next-fixture',
        version: '0.1.0',
        dependencies: { next: '14.0.0', react: '18.0.0' },
        devDependencies: { typescript: '5.0.0' },
      }),
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });

    const result = await captureStdout(() =>
      initCommand.run({
        positional: [],
        flags: new Map<string, string | boolean>([
          ['zero-config', true],
          ['cwd', dir],
        ]),
        multiFlags: new Map(),
      }),
    );

    expect(result.exit).toBe(0);
    expect(result.out).toContain('Picked preset: next-app');
    expect(result.out).toContain('dry-run');
    // Confirm we did not actually write anything.
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('node:fs');
      fs.statSync(nodePath.join(dir, 'sharkcraft', 'sharkcraft.config.ts'));
    }).toThrow();
  });

  test('shrk init --preset auto + --write actually writes the inferred preset', async () => {
    const dir = makeProject('turbo-fixture', {
      'package.json': JSON.stringify({
        name: 'turbo-fixture',
        version: '0.1.0',
        workspaces: ['apps/*', 'packages/*'],
        devDependencies: { turbo: '2.0.0', typescript: '5.0.0' },
      }),
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    });
    mkdirSync(nodePath.join(dir, 'apps'), { recursive: true });
    mkdirSync(nodePath.join(dir, 'packages'), { recursive: true });

    const result = await captureStdout(() =>
      initCommand.run({
        positional: [],
        flags: new Map<string, string | boolean>([
          ['preset', 'auto'],
          ['write', true],
          ['cwd', dir],
        ]),
        multiFlags: new Map(),
      }),
    );

    expect(result.exit).toBe(0);
    expect(result.out).toContain('Picked preset: turborepo');
    expect(result.out).toContain('Created files');
  });

  test('shrk ci scaffold github-actions --quickstart emits doctor + changed-only boundaries', async () => {
    const dir = makeProject('empty-fixture', {
      'package.json': JSON.stringify({ name: 'empty', version: '0.1.0' }),
    });

    const result = await captureStdout(() =>
      ciCommand.run({
        positional: ['scaffold', 'github-actions'],
        flags: new Map<string, string | boolean>([
          ['quickstart', true],
          ['cwd', dir],
        ]),
        multiFlags: new Map(),
      }),
    );

    expect(result.exit).toBe(0);
    expect(result.out).toContain('SharkCraft doctor');
    expect(result.out).toContain('check boundaries --changed-only');
    // No knowledge/templates/packs in this fixture — those gates must NOT appear.
    expect(result.out).not.toContain('Knowledge stale-check');
    expect(result.out).not.toContain('Template drift');
    expect(result.out).not.toContain('Pack signature status');
  });

  test('shrk ci scaffold --quickstart conditionally includes knowledge gate when sharkcraft/knowledge.ts exists', async () => {
    const dir = makeProject('with-knowledge-fixture', {
      'package.json': JSON.stringify({ name: 'wk', version: '0.1.0' }),
      'sharkcraft/sharkcraft.config.ts': 'export {};',
      'sharkcraft/knowledge.ts': 'export const KNOWLEDGE = [];',
    });

    const result = await captureStdout(() =>
      ciCommand.run({
        positional: ['scaffold', 'github-actions'],
        flags: new Map<string, string | boolean>([
          ['quickstart', true],
          ['cwd', dir],
        ]),
        multiFlags: new Map(),
      }),
    );

    expect(result.exit).toBe(0);
    expect(result.out).toContain('Knowledge stale-check');
    expect(result.out).toContain('Self-config doctor');
    expect(result.out).not.toContain('Template drift');
  });
});
