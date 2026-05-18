/**
 * Engine invariants that must not regress.
 *
 *  1. MCP never gains a write tool.
 *  2. The new bounded-loader + import-context primitives are exported
 *     from `@shrkcrft/core` so future loaders can use them.
 *  3. The inspector exports the new diagnostic / cache surfaces.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';

const ROOT = nodePath.resolve(__dirname, '../../../..');

function walkTs(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue;
    if (name.endsWith('.d.ts') || name.endsWith('.d.ts.map')) continue;
    const fp = nodePath.join(dir, name);
    const st = statSync(fp);
    if (st.isDirectory()) walkTs(fp, out);
    else if (name.endsWith('.ts') || name.endsWith('.tool.ts')) out.push(fp);
  }
}

describe('engine invariants', () => {
  test('no MCP tool writes to disk or runs side effects', () => {
    const toolsDir = nodePath.join(ROOT, 'packages/mcp-server/src/tools');
    const files: string[] = [];
    walkTs(toolsDir, files);
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const fp of files) {
      const body = readFileSync(fp, 'utf8');
      // The MCP surface must never call writing primitives. The
      // import-statement check catches the obvious cases; we also
      // forbid direct `fs.writeFileSync` invocations from the bun
      // global `Bun.write`.
      const hasFileWrite = /\b(writeFileSync|writeFile|appendFileSync|appendFile|mkdirSync|rmSync|unlinkSync|renameSync|cpSync|copyFileSync|Bun\.write)\s*\(/.test(
        body,
      );
      const hasExecWrite = /\b(spawnSync|spawn|execSync|exec)\s*\(/.test(body);
      if (hasFileWrite || hasExecWrite) {
        offenders.push(`${fp}: write/exec call present`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('@shrkcrft/core exports the safeImport + import-context surface', () => {
    const indexPath = nodePath.join(ROOT, 'packages/core/src/index.ts');
    const body = readFileSync(indexPath, 'utf8');
    expect(body).toContain('safe-import.ts');
    expect(body).toContain('import-context.ts');
  });

  test('@shrkcrft/inspector exports the cache + diagnostics surface', () => {
    const indexPath = nodePath.join(ROOT, 'packages/inspector/src/index.ts');
    const body = readFileSync(indexPath, 'utf8');
    expect(body).toContain('inspector-cache.ts');
    expect(body).toContain('loader-diagnostics.ts');
  });

  test('loaders use safeImport (not raw await import)', () => {
    const filesToCheck = [
      'packages/knowledge/src/load/typescript-knowledge-loader.ts',
      'packages/templates/src/template-loader.ts',
      'packages/pipelines/src/load/pipeline-loader.ts',
      'packages/presets/src/registry/load-presets.ts',
      'packages/boundaries/src/registry/load-boundary-rules.ts',
    ];
    for (const rel of filesToCheck) {
      const body = readFileSync(nodePath.join(ROOT, rel), 'utf8');
      expect(body).toContain('safeImport');
      // Loaders must not call dynamic import() directly anymore.
      expect(/\bawait\s+import\s*\(/.test(body)).toBe(false);
    }
  });
});
