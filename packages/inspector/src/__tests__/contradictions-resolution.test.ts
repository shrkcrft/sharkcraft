import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContradictionReport } from '../contradictions.ts';
import { inspectSharkcraft } from '../sharkcraft-inspector.ts';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-contradictions-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', scripts: { build: 'tsc' } }, null, 2),
  );
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'exists.ts'), 'export const x = 1;\n');
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'sibling.md'), '# Sibling\n');
  writeFileSync(
    join(root, 'docs', 'guide.md'),
    [
      '# Guide',
      '',
      'See `src/exists.ts:10` for the existing file.',
      'See `src/missing.ts:5` for a missing file.',
      'A sibling link: `./sibling.md`.',
      '',
      '```bash',
      'bun run ../scripts/x.ts',
      'bun run nonexistent',
      'shrk doctor',
      'shrk notacommand',
      '```',
    ].join('\n'),
  );
  return root;
}

describe('contradictions path + command resolution', () => {
  test('strips location suffixes, resolves siblings, skips path-shaped scripts, honors the catalogue', async () => {
    const root = fixture();
    try {
      const inspection = await inspectSharkcraft({ cwd: root });
      const report = buildContradictionReport({
        inspection,
        cliCommandNames: new Set(['doctor']),
      });
      const refs = report.findings.map((f) => f.reference);

      // A `file.ts:NN` reference whose file exists is NOT flagged; a missing one
      // is flagged with the suffix stripped.
      expect(refs).not.toContain('src/exists.ts');
      expect(refs).toContain('src/missing.ts');
      // No finding reference keeps a `:line` suffix.
      expect(report.findings.filter((f) => f.kind === 'missing-path' && f.reference.includes(':'))).toEqual([]);
      // A doc-relative sibling link resolves → no finding.
      expect(refs).not.toContain('sibling.md');

      // `bun run <path>` is not treated as a missing package-script…
      expect(refs.some((r) => r.includes('../scripts/x.ts'))).toBe(false);
      // …but a bare unknown script still is.
      expect(refs).toContain('bun run nonexistent');

      // `shrk doctor` is in the injected catalogue (no finding); `shrk notacommand` is not.
      expect(refs).not.toContain('shrk doctor');
      expect(refs).toContain('shrk notacommand');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('without an injected catalogue, missing-command findings are suppressed (safe mode)', async () => {
    const root = fixture();
    try {
      const inspection = await inspectSharkcraft({ cwd: root });
      const report = buildContradictionReport({ inspection });
      expect(report.findings.some((f) => f.kind === 'missing-command' && f.reference.startsWith('shrk'))).toBe(
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
