/**
 * Workspace-shape coverage for `shrk init` presets.
 *
 *   - `--preset nx-monorepo --write` against a fake Nx workspace emits
 *     paths that reference `libs/` and `apps/` (NOT `src/services/`), and
 *     the advisory does NOT fire because both directories exist.
 *   - `--preset python-service --write` against a Python-shaped repo
 *     emits `src/` and `tests/` paths and skips the advisory.
 *   - `--preset nx-monorepo --write` against a single-package repo (no
 *     libs/ or apps/) still emits the same Nx paths but the advisory
 *     fires listing them as absent.
 *   - every built-in preset emits a paths.ts whose entries point at
 *     directories under structured `metadata.path` fields (so the
 *     annotator can see them).
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as nodePath from 'node:path';
import { BUILTIN_PRESETS, synthesizePresetFiles } from '@shrkcrft/presets';
import { initCommand } from '../commands/init.command.ts';
import type { ParsedArgs } from '../command-registry.ts';

const TMP_BASE = nodePath.join('/tmp', 'init-framework-paths');
let projectRoot: string;

function makeArgs(flags: Record<string, string | boolean> = {}): ParsedArgs {
  const m = new Map<string, string | boolean>();
  for (const [k, v] of Object.entries(flags)) m.set(k, v);
  return {
    positional: [],
    flags: m,
    multiFlags: new Map(),
    globalCwd: projectRoot,
  };
}

async function silenceStdout<T>(fn: () => Promise<T> | T): Promise<T> {
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((_chunk: string | Uint8Array): boolean => true) as typeof process.stdout.write;
  try {
    return await fn();
  } finally {
    process.stdout.write = orig;
  }
}

beforeEach(() => {
  projectRoot = nodePath.join(
    TMP_BASE,
    `proj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    nodePath.join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'init-framework-fixture', version: '0.0.0', private: true }),
  );
});

afterEach(() => {
  if (projectRoot && existsSync(projectRoot)) {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

describe('shrk init --preset <framework> emits framework-correct paths', () => {
  test('nx-monorepo against an Nx-shaped workspace: paths exist, no advisory', async () => {
    // Fake an Nx workspace shape on disk.
    mkdirSync(nodePath.join(projectRoot, 'libs'), { recursive: true });
    mkdirSync(nodePath.join(projectRoot, 'apps'), { recursive: true });
    writeFileSync(
      nodePath.join(projectRoot, 'nx.json'),
      JSON.stringify({ extends: 'nx/presets/npm.json' }),
    );

    const rc = await silenceStdout(() =>
      initCommand.run(makeArgs({ preset: 'nx-monorepo', write: true })),
    );
    expect(rc).toBe(0);

    const pathsFile = nodePath.join(projectRoot, 'sharkcraft', 'paths.ts');
    expect(existsSync(pathsFile)).toBe(true);
    const content = readFileSync(pathsFile, 'utf8');

    // Nx-correct path references.
    expect(content).toContain("metadata: { path: 'libs' }");
    expect(content).toContain("metadata: { path: 'apps' }");
    // The pre-fix generic defaults must NOT be there.
    expect(content).not.toMatch(/metadata:\s*{\s*path:\s*['"]src\/services['"]\s*}/);
    expect(content).not.toMatch(/metadata:\s*{\s*path:\s*['"]src\/utils['"]\s*}/);
    expect(content).not.toMatch(/metadata:\s*{\s*path:\s*['"]tests['"]\s*}/);
    // Both dirs exist, so the advisory must NOT have been prepended.
    expect(content).not.toContain('Workspace-shape advisory');
  });

  test('python-service against a Python-shaped repo: src/ + tests/ exist, no advisory', async () => {
    mkdirSync(nodePath.join(projectRoot, 'src'), { recursive: true });
    mkdirSync(nodePath.join(projectRoot, 'tests'), { recursive: true });

    const rc = await silenceStdout(() =>
      initCommand.run(makeArgs({ preset: 'python-service', write: true })),
    );
    expect(rc).toBe(0);

    const pathsFile = nodePath.join(projectRoot, 'sharkcraft', 'paths.ts');
    expect(existsSync(pathsFile)).toBe(true);
    const content = readFileSync(pathsFile, 'utf8');
    expect(content).toContain("metadata: { path: 'src' }");
    expect(content).toContain("metadata: { path: 'tests' }");
    expect(content).not.toContain('Workspace-shape advisory');
  });

  test('nx-monorepo against a non-Nx repo: same paths emitted, advisory DOES fire', async () => {
    // No libs/ or apps/ on disk.
    const rc = await silenceStdout(() =>
      initCommand.run(makeArgs({ preset: 'nx-monorepo', write: true })),
    );
    expect(rc).toBe(0);

    const pathsFile = nodePath.join(projectRoot, 'sharkcraft', 'paths.ts');
    expect(existsSync(pathsFile)).toBe(true);
    const content = readFileSync(pathsFile, 'utf8');
    expect(content).toContain("metadata: { path: 'libs' }");
    expect(content).toContain("metadata: { path: 'apps' }");
    expect(content).toContain('Workspace-shape advisory');
    expect(content).toContain('libs');
    expect(content).toContain('apps');
  });
});

describe('every preset that emits paths.ts uses structured metadata.path', () => {
  test('all path entries are scannable by the advisory annotator', () => {
    for (const preset of BUILTIN_PRESETS) {
      const files = synthesizePresetFiles(preset);
      const pathsFile = files.find((f) => f.path === 'paths.ts');
      if (!pathsFile) continue;
      // For every `defineKnowledgeEntry({` block with `type: KnowledgeType.Path`,
      // the entry must include a structured `metadata: { path: '<x>' }` field.
      // The annotator's regex matches `path: '<x>'` anywhere, so any such
      // metadata field counts.
      const entryCount = (pathsFile.content.match(/type:\s*KnowledgeType\.Path/g) ?? []).length;
      const structuredPaths = (
        pathsFile.content.match(/\bpath\s*:\s*['"][^'"]+['"]/g) ?? []
      ).length;
      expect(
        structuredPaths,
        `preset ${preset.id}: emitted ${entryCount} Path entries but only ${structuredPaths} structured path references`,
      ).toBeGreaterThanOrEqual(entryCount);
    }
  });
});
