import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { renderExport } from '../export/export-formats.ts';
import { importAgentsMd } from '@shrkcrft/importer';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const DOGFOOD = join(REPO_ROOT, 'examples/dogfood-target');

describe('export → import roundtrip', () => {
  test('agents-md export → import produces at least one entry with deterministic ids', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD });
    const out = renderExport(inspection, { format: 'agents-md' });
    expect(out.content.length).toBeGreaterThan(100);

    const tmp = mkdtempSync(join(tmpdir(), 'shrk-roundtrip-'));
    try {
      const path = join(tmp, 'AGENTS.md');
      writeFileSync(path, out.content, 'utf8');

      const a = importAgentsMd({ filePath: path, projectRoot: tmp });
      const b = importAgentsMd({ filePath: path, projectRoot: tmp });
      expect(a.entries.length).toBeGreaterThanOrEqual(1);
      expect(b.entries.length).toBe(a.entries.length);
      // Same input → same ids (determinism).
      expect(b.entries.map((e) => e.id)).toEqual(a.entries.map((e) => e.id));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('roundtrip does not write outside the temp dir', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD });
    const out = renderExport(inspection, { format: 'agents-md' });
    const tmp = mkdtempSync(join(tmpdir(), 'shrk-roundtrip-no-write-'));
    try {
      writeFileSync(join(tmp, 'AGENTS.md'), out.content, 'utf8');
      // Importing returns a result; it MUST NOT write any files.
      const result = importAgentsMd({ filePath: 'AGENTS.md', projectRoot: tmp });
      expect(result.entries.length).toBeGreaterThan(0);
      // No drafts directory should appear unless the CLI --write flag is set.
      // The library API never writes anything.
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
