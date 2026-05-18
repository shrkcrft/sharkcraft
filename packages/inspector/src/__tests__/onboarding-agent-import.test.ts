import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildOnboardingPlan,
  importAgentRulesForOnboarding,
  inspectSharkcraft,
  writeOnboardingDrafts,
} from '../index.ts';

function makeBaseFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-agent-import-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: '@example/agent-import', type: 'module' }),
  );
  return root;
}

describe('importAgentRulesForOnboarding', () => {
  test('imports AGENTS.md when present', () => {
    const root = makeBaseFixture();
    writeFileSync(
      join(root, 'AGENTS.md'),
      `# Coding standards\n\n- Always run tests before pushing.\n- Use absolute imports across packages.\n`,
    );
    const bundle = importAgentRulesForOnboarding({ projectRoot: root });
    expect(bundle.entries.length).toBeGreaterThan(0);
    expect(bundle.perSource.some((s) => s.kind === 'agents-md')).toBe(true);
    expect(bundle.entries.every((e) => e.tags.includes('imported'))).toBe(true);
  });

  test('imports CLAUDE.md when present', () => {
    const root = makeBaseFixture();
    writeFileSync(
      join(root, 'CLAUDE.md'),
      `# Project conventions\n\n- Prefer Result<T, E> over throwing for public APIs.\n`,
    );
    const bundle = importAgentRulesForOnboarding({ projectRoot: root });
    expect(bundle.entries.length).toBeGreaterThan(0);
    expect(bundle.perSource.some((s) => s.kind === 'claude-md')).toBe(true);
  });

  test('imports .cursor/rules when present', () => {
    const root = makeBaseFixture();
    mkdirSync(join(root, '.cursor', 'rules'), { recursive: true });
    writeFileSync(
      join(root, '.cursor', 'rules', 'general.mdc'),
      `---\ntitle: General\n---\nAlways write tests for new features.\n`,
    );
    const bundle = importAgentRulesForOnboarding({ projectRoot: root });
    expect(bundle.perSource.some((s) => s.kind === 'cursor-rules')).toBe(true);
  });

  test('produces an empty bundle when no instruction files exist', () => {
    const root = makeBaseFixture();
    const bundle = importAgentRulesForOnboarding({ projectRoot: root });
    expect(bundle.entries.length).toBe(0);
    expect(bundle.perSource.length).toBe(0);
  });
});

describe('writeOnboardingDrafts with importedAgentRules', () => {
  test('writes imported-agent-rules.draft.ts only when bundle has entries', async () => {
    const root = makeBaseFixture();
    writeFileSync(
      join(root, 'AGENTS.md'),
      `# Style\n\n- Always run \`bun test\` before pushing.\n`,
    );
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection);
    const bundle = importAgentRulesForOnboarding({ projectRoot: root });
    const result = writeOnboardingDrafts(plan, {
      projectRoot: root,
      importedAgentRules: bundle,
    });
    const draft = result.files.find((f) =>
      f.path.endsWith('imported-agent-rules.draft.ts'),
    );
    expect(draft).toBeDefined();
    expect(existsSync(draft!.path)).toBe(true);
    const content = readFileSync(draft!.path, 'utf8');
    expect(content).toContain('export default [');
    expect(content).toContain('imported');
  });
});
