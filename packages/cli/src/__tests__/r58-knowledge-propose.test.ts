/**
 * `shrk knowledge propose` CLI + MCP surface tests.
 *
 *   - dry-run preview never writes
 *   - --write materialises one .ts per proposal + a _manifest.json
 *   - --json emits the IKnowledgeProposeReport shape
 *   - MCP `preview_knowledge_propose` tool returns the same payload as
 *     CLI --json and never writes
 *   - --symbol filter restricts proposals to one binding
 *   - excluded files (tests, .d.ts) return no proposals
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as nodePath from 'node:path';
import { KNOWLEDGE_PROPOSE_SCHEMA } from '@shrkcrft/inspector';
import { knowledgeProposeCommand } from '../commands/knowledge-propose.command.ts';
import { ALL_TOOLS } from '@shrkcrft/mcp-server';
import type { ParsedArgs } from '../command-registry.ts';

const previewKnowledgeProposeTool = ALL_TOOLS.find(
  (t) => t.name === 'preview_knowledge_propose',
)!;

const TMP_BASE = nodePath.join('/tmp', 'r58-propose-tests');
let projectRoot: string;
let captured: string;
let originalWrite: typeof process.stdout.write;

function captureStdout(): void {
  captured = '';
  originalWrite = process.stdout.write.bind(process.stdout);
  const override = (chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  };
  process.stdout.write = override as typeof process.stdout.write;
}

function restoreStdout(): void {
  process.stdout.write = originalWrite;
}

function makeArgs(
  positional: string[],
  flags: Record<string, string | boolean> = {},
): ParsedArgs {
  const flagMap = new Map<string, string | boolean>();
  for (const [k, v] of Object.entries(flags)) flagMap.set(k, v);
  return {
    positional,
    flags: flagMap,
    multiFlags: new Map(),
    globalCwd: projectRoot,
  };
}

function makeProject(): string {
  const dir = nodePath.join(
    TMP_BASE,
    `proj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    nodePath.join(dir, 'package.json'),
    JSON.stringify({ name: 'r58-propose-fixture', version: '0.0.0', private: true }),
  );
  return dir;
}

function writeFile(rel: string, content: string): void {
  const abs = nodePath.join(projectRoot, rel);
  mkdirSync(nodePath.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

beforeEach(() => {
  projectRoot = makeProject();
});

afterEach(() => {
  restoreStdout();
  if (projectRoot && existsSync(projectRoot)) {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

describe('shrk knowledge propose', () => {
  test('preview prints markdown and writes nothing', async () => {
    writeFile(
      'packages/sample/src/foo.ts',
      'export function alpha(): number { return 1; }\n',
    );
    captureStdout();
    const rc = await knowledgeProposeCommand.run(
      makeArgs([], { path: 'packages/sample/src/foo.ts' }),
    );
    restoreStdout();
    expect(rc).toBe(0);
    expect(captured).toContain('sample.alpha');
    expect(captured).toContain('preview only');
    expect(existsSync(nodePath.join(projectRoot, '.sharkcraft', 'authoring', 'proposed'))).toBe(
      false,
    );
  });

  test('--write lands per-proposal .ts files and _manifest.json', async () => {
    writeFile(
      'packages/sample/src/foo.ts',
      `export class FooStore {}\nexport interface IBar { x: number }\n`,
    );
    captureStdout();
    const rc = await knowledgeProposeCommand.run(
      makeArgs([], { path: 'packages/sample/src/foo.ts', write: true }),
    );
    restoreStdout();
    expect(rc).toBe(0);
    const outDir = nodePath.join(projectRoot, '.sharkcraft', 'authoring', 'proposed');
    const files = readdirSync(outDir);
    expect(files.length).toBe(3); // 2 proposals + manifest
    expect(files.some((f) => f.startsWith('sample.foo-store'))).toBe(true);
    expect(files.some((f) => f.startsWith('sample.i-bar'))).toBe(true);
    expect(files).toContain('_manifest.json');
    const manifest = JSON.parse(
      readFileSync(nodePath.join(outDir, '_manifest.json'), 'utf8'),
    );
    expect(manifest.schema).toBe(KNOWLEDGE_PROPOSE_SCHEMA);
    expect(manifest.proposals.length).toBe(2);
  });

  test('--json emits a stable IKnowledgeProposeReport shape', async () => {
    writeFile(
      'packages/sample/src/foo.ts',
      'export function alpha(): number { return 1; }\n',
    );
    captureStdout();
    await knowledgeProposeCommand.run(
      makeArgs([], { path: 'packages/sample/src/foo.ts', json: true }),
    );
    restoreStdout();
    const payload = JSON.parse(captured);
    expect(payload.schema).toBe(KNOWLEDGE_PROPOSE_SCHEMA);
    expect(Array.isArray(payload.proposals)).toBe(true);
    expect(payload.proposals[0].id).toBe('sample.alpha');
    expect(payload.proposals[0].references.length).toBeGreaterThan(0);
  });

  test('--json --write augments payload with writtenFiles', async () => {
    writeFile(
      'packages/sample/src/foo.ts',
      'export function alpha(): number { return 1; }\n',
    );
    captureStdout();
    await knowledgeProposeCommand.run(
      makeArgs([], { path: 'packages/sample/src/foo.ts', json: true, write: true }),
    );
    restoreStdout();
    const payload = JSON.parse(captured);
    expect(Array.isArray(payload.writtenFiles)).toBe(true);
    expect(payload.writtenFiles.some((p: string) => p.endsWith('_manifest.json'))).toBe(true);
  });

  test('--symbol restricts proposals to a single binding', async () => {
    writeFile(
      'packages/sample/src/foo.ts',
      'export function alpha(): void {}\nexport function beta(): void {}\n',
    );
    captureStdout();
    await knowledgeProposeCommand.run(
      makeArgs([], { path: 'packages/sample/src/foo.ts', symbol: 'beta', json: true }),
    );
    restoreStdout();
    const payload = JSON.parse(captured);
    expect(payload.proposals.length).toBe(1);
    expect(payload.proposals[0].id).toBe('sample.beta');
  });

  test('MCP preview_knowledge_propose returns same payload as CLI --json and writes nothing', async () => {
    writeFile(
      'packages/sample/src/foo.ts',
      'export function alpha(): number { return 1; }\n',
    );
    captureStdout();
    await knowledgeProposeCommand.run(
      makeArgs([], { path: 'packages/sample/src/foo.ts', json: true }),
    );
    restoreStdout();
    const cliPayload = JSON.parse(captured);

    // MCP tool context only needs `cwd` for proposeKnowledge.
    const ctx = {
      cwd: projectRoot,
      inspection: {} as never,
    };
    const res = await previewKnowledgeProposeTool.handler(
      { path: 'packages/sample/src/foo.ts' },
      ctx,
    );
    expect(res.data).toBeDefined();
    const mcpPayload = res.data as typeof cliPayload;
    expect(mcpPayload.schema).toBe(KNOWLEDGE_PROPOSE_SCHEMA);
    expect(mcpPayload.proposals.length).toBe(cliPayload.proposals.length);
    expect(mcpPayload.proposals[0].id).toBe(cliPayload.proposals[0].id);
    // MCP must never write — confirm no draft directory exists from this call.
    rmSync(nodePath.join(projectRoot, '.sharkcraft'), { recursive: true, force: true });
    await previewKnowledgeProposeTool.handler({ path: 'packages/sample/src/foo.ts' }, ctx);
    expect(existsSync(nodePath.join(projectRoot, '.sharkcraft', 'authoring', 'proposed'))).toBe(
      false,
    );
  });

  test('test files and .d.ts excluded by default', async () => {
    writeFile(
      'packages/sample/src/__tests__/foo.test.ts',
      'export function inTest(): void {}\n',
    );
    writeFile(
      'packages/sample/src/legacy.d.ts',
      'export declare const dts: number;\n',
    );
    captureStdout();
    await knowledgeProposeCommand.run(
      makeArgs([], { path: 'packages/sample/src/__tests__/foo.test.ts', json: true }),
    );
    restoreStdout();
    const payload = JSON.parse(captured);
    expect(payload.proposals.length).toBe(0);
  });
});
