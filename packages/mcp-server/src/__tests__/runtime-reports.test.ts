import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALL_TOOLS } from '../tools/index.ts';
import { inspectSharkcraft } from '@shrkcrft/inspector';

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'mcp-rr-'));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'q', version: '0.0.0' }));
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    `export default { projectName: 'q', knowledgeFiles: [], ruleFiles: [], pathFiles: [], templateFiles: [], docsFiles: [] };\n`,
  );
  return root;
}

describe('MCP runtime report tools', () => {
  test('get_adoption_report returns a structured json envelope', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const tool = ALL_TOOLS.find((t) => t.name === 'get_adoption_report');
    expect(tool).toBeDefined();
    const r = await tool!.handler({ format: 'json' }, { inspection, cwd: root });
    expect(r.isError ?? false).toBe(false);
    const data = r.data as { format: string; report?: unknown; nextCommand?: string };
    expect(data.format).toBe('json');
    expect(data.report).toBeDefined();
    expect(data.nextCommand).toContain('shrk report adoption');
  });

  // `get_quality_html_report`, `get_safety_html_report`, `get_session_html_report`,
  //        `get_review_html_report` removed (dashboard HTML duplicates). The exports
  //        from runtime-reports.tool.ts still exist but are no longer wired into ALL_TOOLS.

  test('removed HTML-report MCP tools are not in ALL_TOOLS', () => {
    const names = new Set(ALL_TOOLS.map((t) => t.name));
    expect(names.has('get_quality_html_report')).toBe(false);
    expect(names.has('get_safety_html_report')).toBe(false);
    expect(names.has('get_session_html_report')).toBe(false);
    expect(names.has('get_review_html_report')).toBe(false);
  });

  test('the runtime ALL_TOOLS list includes the surviving runtime-report tools', () => {
    // DX#4 — `ALL_TOOLS_FOR_AUDIT` was deleted (parallel static list); the
    // audit view is now derived from ALL_TOOLS at runtime.
    const names = new Set(ALL_TOOLS.map((t) => t.name));
    expect(names.has('get_adoption_report')).toBe(true);
    expect(names.has('list_scaffold_patterns')).toBe(true);
    // removed HTML duplicates must not reappear.
    expect(names.has('get_quality_html_report')).toBe(false);
    expect(names.has('get_safety_html_report')).toBe(false);
    expect(names.has('get_session_html_report')).toBe(false);
    expect(names.has('get_review_html_report')).toBe(false);
  });
});
