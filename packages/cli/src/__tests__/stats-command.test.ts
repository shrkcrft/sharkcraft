import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { parseArgs } from '../command-registry.ts';
import { statsCommand } from '../commands/stats.command.ts';

function captureStdout(): { restore: () => string } {
  const original = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  (process.stdout as { write: (chunk: string | Uint8Array) => boolean }).write = (chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
  return {
    restore: () => {
      (process.stdout as { write: typeof original }).write = original;
      return chunks.join('');
    },
  };
}

describe('stats command', () => {
  test('emits JSON envelope when --json is passed', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-stats-cli-'));
    try {
      writeFileSync(
        nodePath.join(root, 'package.json'),
        JSON.stringify({ name: 'fixture', version: '0.0.0' }),
      );
      mkdirSync(nodePath.join(root, 'src'), { recursive: true });
      writeFileSync(nodePath.join(root, 'src/x.ts'), 'export const X = 1;\n');

      const args = parseArgs(['--json'], { globalCwd: root });
      const capture = captureStdout();
      const code = await statsCommand.run(args);
      const out = capture.restore();
      expect(code).toBe(0);
      const parsed = JSON.parse(out);
      expect(parsed.schema).toBe('sharkcraft.repository-stats/v1');
      expect(parsed.totals.files).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('renders a human table by default', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-stats-cli-'));
    try {
      writeFileSync(
        nodePath.join(root, 'package.json'),
        JSON.stringify({ name: 'fixture', version: '0.0.0' }),
      );
      writeFileSync(nodePath.join(root, 'a.ts'), 'export const A = 1;\n');

      const args = parseArgs([], { globalCwd: root });
      const capture = captureStdout();
      const code = await statsCommand.run(args);
      const out = capture.restore();
      expect(code).toBe(0);
      expect(out).toContain('Repository statistics');
      expect(out).toContain('typescript');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
