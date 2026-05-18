import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALL_TOOLS } from '../tools/index.ts';
import { inspectSharkcraft } from '@shrkcrft/inspector';

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-mcp-adopt-'));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'x', version: '0.0.0', scripts: { build: 'tsc' } }),
  );
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    `export default { projectName: 'x', knowledgeFiles: [], ruleFiles: [], pathFiles: [], templateFiles: [], docsFiles: [] };\n`,
  );
  mkdirSync(join(root, 'src', 'services'), { recursive: true });
  writeFileSync(join(root, 'src', 'services', 'user.service.ts'), 'export class UserService {}\n');
  return root;
}

describe('MCP onboarding adoption tools', () => {
  test('create_onboarding_adoption_plan returns categories and never writes files', async () => {
    const root = makeFixture();
    const before = readdirSync(root).sort();
    const inspection = await inspectSharkcraft({ cwd: root });
    const tool = ALL_TOOLS.find((t) => t.name === 'create_onboarding_adoption_plan');
    expect(tool).toBeDefined();
    const result = await tool!.handler({}, { inspection, cwd: root });
    expect(result.isError ?? false).toBe(false);
    const data = result.data as {
      summary: Record<string, number>;
      items: { kind: string; id: string; category: string }[];
      nextCommand: string;
      note: string;
    };
    expect(data.nextCommand).toContain('shrk onboard adopt --write-patch');
    expect(data.note.toLowerCase()).toContain('mcp cannot write');
    // No new files written.
    const after = readdirSync(root).sort();
    expect(after).toEqual(before);
    // sharkcraft/onboarding/adoption/ must not exist.
    expect(existsSync(join(root, 'sharkcraft', 'onboarding', 'adoption'))).toBe(false);
  });

  test('get_onboarding_adoption_review returns by-category groups', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const tool = ALL_TOOLS.find((t) => t.name === 'get_onboarding_adoption_review');
    expect(tool).toBeDefined();
    const r = await tool!.handler({}, { inspection, cwd: root });
    expect(r.isError ?? false).toBe(false);
    const data = r.data as { byCategory: Record<string, unknown[]>; nextCommand: string };
    expect(Object.keys(data.byCategory).length).toBeGreaterThan(0);
    expect(data.nextCommand).toContain('shrk onboard adopt --write-patch');
  });

  test('get_command_catalog is read-only and returns command entries', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const tool = ALL_TOOLS.find((t) => t.name === 'get_command_catalog');
    expect(tool).toBeDefined();
    const r = await tool!.handler({}, { inspection, cwd: root });
    expect(r.isError ?? false).toBe(false);
    const data = r.data as { entries: { command: string }[] };
    expect(data.entries.length).toBeGreaterThan(0);
  });
});
