/**
 * Knowledge propose: core inference behavior.
 *
 * Builds a throwaway project tree, drops a couple of TS files with
 * exported symbols, and asserts proposeKnowledge produces the expected
 * proposals + skipped-with-reason payload.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  KNOWLEDGE_PROPOSE_SCHEMA,
  KnowledgeProposeSkipReason,
  proposeKnowledge,
  renderKnowledgeProposeMarkdown,
} from '../propose-knowledge.ts';

let projectRoot: string;

beforeEach(() => {
  projectRoot = nodePath.join(
    '/tmp',
    `r58-propose-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(projectRoot, { recursive: true });
  // Minimal package.json so inspectSharkcraft does not abort.
  writeFileSync(
    nodePath.join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'propose-fixture', version: '0.0.0', private: true }),
  );
});

afterEach(() => {
  if (existsSync(projectRoot)) {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

function writeFile(rel: string, content: string): void {
  const abs = nodePath.join(projectRoot, rel);
  mkdirSync(nodePath.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function writeKnowledgeFile(entries: Array<Record<string, unknown>>): void {
  const exports = entries
    .map((entry, i) => `export const entry${i} = ${JSON.stringify(entry, null, 2)};`)
    .join('\n');
  writeFile('sharkcraft/knowledge.ts', `${exports}\n`);
  writeFile(
    'sharkcraft/sharkcraft.config.ts',
    `export default {
  projectName: 'propose-fixture',
  knowledgeFiles: ['./knowledge.ts'],
};
`,
  );
}

describe('proposeKnowledge', () => {
  test('proposes a new entry for a fresh export with no prior knowledge', async () => {
    writeFile(
      'packages/sample/src/foo.ts',
      'export function fooBar(): number { return 42; }\n',
    );
    const report = await proposeKnowledge({
      cwd: projectRoot,
      path: 'packages/sample/src/foo.ts',
    });
    expect(report.schema).toBe(KNOWLEDGE_PROPOSE_SCHEMA);
    expect(report.proposals.length).toBe(1);
    const proposal = report.proposals[0]!;
    expect(proposal.id).toBe('sample.foo-bar');
    expect(proposal.references.some((r) => r.kind === 'symbol' && r.symbol === 'fooBar')).toBe(
      true,
    );
    expect(proposal.references.some((r) => r.kind === 'file' && r.path === 'packages/sample/src/foo.ts')).toBe(
      true,
    );
    expect(proposal.source.kind).toBe('function');
    expect(proposal.scope).toContain('sample');
  });

  test('skips exports that are already covered by an existing entry (file ref)', async () => {
    writeFile(
      'packages/sample/src/foo.ts',
      'export class FooStore {}\nexport function helper(): void {}\n',
    );
    writeKnowledgeFile([
      {
        id: 'engine.foo-store',
        title: 'FooStore docs',
        type: 'technical',
        priority: 'medium',
        scope: ['sample'],
        tags: ['foo'],
        appliesWhen: [],
        content: 'covers everything in packages/sample/src/foo.ts',
        references: [
          { kind: 'file', path: 'packages/sample/src/foo.ts', required: true },
        ],
      },
    ]);
    const report = await proposeKnowledge({
      cwd: projectRoot,
      path: 'packages/sample/src/foo.ts',
    });
    expect(report.proposals.length).toBe(0);
    const skippedSymbols = report.skipped
      .filter((s) => s.reason === KnowledgeProposeSkipReason.AlreadyCovered)
      .map((s) => s.symbol);
    expect(skippedSymbols).toEqual(expect.arrayContaining(['FooStore', 'helper']));
    const fooSkip = report.skipped.find(
      (s) => s.symbol === 'FooStore' && s.reason === KnowledgeProposeSkipReason.AlreadyCovered,
    );
    expect(fooSkip?.coveredByEntryId).toBe('engine.foo-store');
  });

  test('skips exports covered by a symbol reference (not a file ref)', async () => {
    writeFile(
      'packages/sample/src/foo.ts',
      'export class FooStore {}\nexport function helper(): void {}\n',
    );
    writeKnowledgeFile([
      {
        id: 'engine.foo-store-only',
        title: 'FooStore only',
        type: 'technical',
        priority: 'medium',
        scope: ['sample'],
        tags: ['foo'],
        appliesWhen: [],
        content: 'docs the FooStore class only',
        references: [
          {
            kind: 'symbol',
            symbol: 'FooStore',
            path: 'packages/sample/src/foo.ts',
          },
        ],
      },
    ]);
    const report = await proposeKnowledge({
      cwd: projectRoot,
      path: 'packages/sample/src/foo.ts',
    });
    expect(report.proposals.length).toBe(1);
    expect(report.proposals[0]!.references.some((r) => r.symbol === 'helper')).toBe(true);
    expect(
      report.skipped.find(
        (s) =>
          s.symbol === 'FooStore' && s.reason === KnowledgeProposeSkipReason.AlreadyCovered,
      )?.coveredByEntryId,
    ).toBe('engine.foo-store-only');
  });

  test('--symbol filter scopes proposals to a single export', async () => {
    writeFile(
      'packages/sample/src/foo.ts',
      'export function alpha(): void {}\nexport function beta(): void {}\n',
    );
    const report = await proposeKnowledge({
      cwd: projectRoot,
      path: 'packages/sample/src/foo.ts',
      symbol: 'beta',
    });
    expect(report.proposals.length).toBe(1);
    expect(report.proposals[0]!.id).toBe('sample.beta');
    const skippedAlpha = report.skipped.find(
      (s) => s.symbol === 'alpha' && s.reason === KnowledgeProposeSkipReason.NotSelected,
    );
    expect(skippedAlpha).toBeDefined();
  });

  test('skips test files and .d.ts files via the default exclude patterns', async () => {
    writeFile('packages/sample/src/__tests__/foo.test.ts', 'export function inTest(): void {}\n');
    writeFile('packages/sample/src/legacy.d.ts', 'export declare const dts: number;\n');
    const report = await proposeKnowledge({
      cwd: projectRoot,
      path: 'packages/sample/src/__tests__/foo.test.ts',
    });
    expect(report.proposals.length).toBe(0);
    expect(report.skipped[0]?.reason).toBe(KnowledgeProposeSkipReason.Excluded);
  });

  test('markdown renderer surfaces id, source, and the stub body', async () => {
    writeFile(
      'packages/sample/src/foo.ts',
      'export interface IThing { x: number; }\n',
    );
    const report = await proposeKnowledge({
      cwd: projectRoot,
      path: 'packages/sample/src/foo.ts',
    });
    const md = renderKnowledgeProposeMarkdown(report);
    expect(md).toContain('sample.i-thing');
    expect(md).toContain('packages/sample/src/foo.ts');
    expect(md).toContain('Replace this body with the *why*');
  });
});
