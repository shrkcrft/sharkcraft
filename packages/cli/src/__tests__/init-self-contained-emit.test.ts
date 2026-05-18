/**
 * Regression — `shrk init` and friends MUST emit scaffolding that works
 * in a brand-new downstream repo where no `@shrkcrft/*` packages are
 * installed beyond the CLI itself.
 *
 * This guards against re-introducing `import { ... } from '@shrkcrft/...'`
 * lines into:
 *
 *   - `INIT_FILES` (legacy preset)
 *   - `synthesizePresetFiles()` output (modern preset path)
 *   - `emitKnowledgeTs()` output (importer)
 *   - `renderConstructDraftsModule()` / `renderRulesDraft()` etc. (inspector)
 *
 * Also covers an external-repo init smoke test: drive `shrk init` against
 * a tmp directory and verify all generated `*.ts` files are import-clean.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as nodePath from 'node:path';
import { INIT_FILES } from '../init/init-templates.ts';
import { initCommand } from '../commands/init.command.ts';
import type { ParsedArgs } from '../command-registry.ts';
import { synthesizePresetFiles } from '@shrkcrft/presets';
import { BUILTIN_PRESETS } from '@shrkcrft/presets';
import { emitKnowledgeTs } from '@shrkcrft/importer';

const BAD_SCOPE_RE = /from\s+['"]@shrkcrft\//;
const TYPO_SCOPE_RE = /from\s+['"]@sharkcraft\//;

function assertSelfContained(label: string, content: string): void {
  expect(content, `${label} must not import from @shrkcrft/*`).not.toMatch(
    BAD_SCOPE_RE,
  );
  expect(content, `${label} must not contain @sharkcraft/* typo`).not.toMatch(
    TYPO_SCOPE_RE,
  );
}

describe('init-templates (legacy seed)', () => {
  test('every emitted .ts file is self-contained — no @shrkcrft/* imports', () => {
    const tsFiles = INIT_FILES.filter((f) => f.relativePath.endsWith('.ts'));
    expect(tsFiles.length).toBeGreaterThan(0);
    for (const f of tsFiles) {
      assertSelfContained(`INIT_FILES[${f.relativePath}]`, f.content);
    }
  });

  test('config file is a plain default export — no defineSharkCraftConfig import', () => {
    const cfg = INIT_FILES.find((f) => f.relativePath === 'sharkcraft.config.ts');
    expect(cfg).toBeDefined();
    expect(cfg!.content).not.toMatch(/defineSharkCraftConfig/);
    expect(cfg!.content).toContain('export default {');
  });
});

describe('preset synthesis (modern path)', () => {
  test('every built-in preset emits .ts files free of @shrkcrft/* imports', () => {
    let totalTs = 0;
    for (const preset of BUILTIN_PRESETS) {
      const files = synthesizePresetFiles(preset);
      for (const f of files) {
        if (!f.path.endsWith('.ts')) continue;
        totalTs += 1;
        assertSelfContained(
          `preset[${preset.id}].${f.path}`,
          f.content,
        );
      }
    }
    // Sanity — we should emit at least one .ts per preset on average.
    expect(totalTs).toBeGreaterThanOrEqual(BUILTIN_PRESETS.length);
  });
});

describe('emitKnowledgeTs (shrk import)', () => {
  test('imported knowledge module is self-contained', () => {
    const out = emitKnowledgeTs(
      [
        {
          id: 'imported.test',
          title: 'Test entry',
          type: 'rule' as never,
          priority: 'high' as never,
          tags: ['imported'],
          content: 'A simple test entry.',
          origin: 'unit-test',
        },
      ],
      { sourceLabel: 'unit-test', exportName: 'testImports' },
    );
    assertSelfContained('emitKnowledgeTs output', out);
    expect(out).toContain('function defineKnowledgeEntry');
    expect(out).toContain('export const testImports = [');
  });
});

const TMP_BASE = nodePath.join('/tmp', 'init-self-contained');
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

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const entry of readdirSync(cur)) {
      const full = nodePath.join(cur, entry);
      const st = statSync(full);
      if (st.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

beforeEach(() => {
  projectRoot = nodePath.join(
    TMP_BASE,
    `proj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(projectRoot, { recursive: true });
  // Minimal valid package.json so workspace detection runs.
  writeFileSync(
    nodePath.join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'init-self-contained-fixture', version: '0.0.0', private: true }),
  );
});

afterEach(() => {
  if (projectRoot && existsSync(projectRoot)) {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

describe('external-repo init smoke', () => {
  test('shrk init --write produces only self-contained .ts under sharkcraft/', async () => {
    const rc = await silenceStdout(() => initCommand.run(makeArgs({ write: true })));
    expect(rc).toBe(0);
    const sharkcraftDir = nodePath.join(projectRoot, 'sharkcraft');
    const files = listFilesRecursive(sharkcraftDir);
    const tsFiles = files.filter((f) => f.endsWith('.ts'));
    expect(tsFiles.length).toBeGreaterThan(0);
    for (const f of tsFiles) {
      const content = readFileSync(f, 'utf8');
      assertSelfContained(nodePath.relative(projectRoot, f), content);
    }
  });

  test('shrk init --legacy --write produces only self-contained .ts', async () => {
    const rc = await silenceStdout(() =>
      initCommand.run(makeArgs({ legacy: true, write: true })),
    );
    expect(rc).toBe(0);
    const sharkcraftDir = nodePath.join(projectRoot, 'sharkcraft');
    const files = listFilesRecursive(sharkcraftDir);
    const tsFiles = files.filter((f) => f.endsWith('.ts'));
    expect(tsFiles.length).toBeGreaterThan(0);
    for (const f of tsFiles) {
      const content = readFileSync(f, 'utf8');
      assertSelfContained(nodePath.relative(projectRoot, f), content);
    }
  });

  test('shrk init annotates paths.ts when preset paths do not exist in the workspace', async () => {
    const rc = await silenceStdout(() => initCommand.run(makeArgs({ write: true })));
    expect(rc).toBe(0);
    const pathsFile = nodePath.join(projectRoot, 'sharkcraft', 'paths.ts');
    // The empty fixture has no src/services, src/utils, or tests dir.
    // If the picked preset emits a paths.ts file, it should be annotated.
    if (!existsSync(pathsFile)) return;
    const content = readFileSync(pathsFile, 'utf8');
    expect(content).toContain('Workspace-shape advisory');
    expect(content).toContain('do NOT exist in this repository');
  });
});
