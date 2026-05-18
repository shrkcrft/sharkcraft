import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { createOnboardingPlanTool } from '../tools/onboarding.tool.ts';

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-mcp-onboard-opts-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: '@example/onboarding-mcp-opts',
      version: '0.0.0',
      type: 'module',
      scripts: { test: 'bun test', typecheck: 'tsc --noEmit' },
      devDependencies: { '@types/bun': '*' },
    }),
  );
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true } }),
  );
  mkdirSync(join(root, 'src', 'services'), { recursive: true });
  for (const n of ['user', 'order', 'billing']) {
    writeFileSync(
      join(root, 'src', 'services', `${n}.service.ts`),
      `export class ${n[0]!.toUpperCase()}${n.slice(1)}Service {}\n`,
    );
  }
  writeFileSync(
    join(root, 'AGENTS.md'),
    `# Style\n\n- Run tests before pushing.\n- Use absolute imports.\n`,
  );
  return root;
}

describe('createOnboardingPlanTool options', () => {
  test('default call returns plan + nextCommands list', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const res = await createOnboardingPlanTool.handler(
      {},
      { inspection, cwd: root },
    );
    expect(res.isError).toBeFalsy();
    const data = res.data as {
      plan: { inferredTemplateCandidates: { scaffold?: unknown }[] };
      nextCommand: string;
      nextCommands: string[];
      inferredAssetsSummary: { templatesScaffolded: number };
    };
    expect(data.nextCommand).toBe('shrk onboard --write-drafts');
    expect(data.nextCommands).toContain('shrk onboard --write-drafts --scaffold-templates');
    expect(data.nextCommands).toContain('shrk onboard --write-drafts --import-agents');
    expect(data.nextCommands).toContain('shrk onboard --diff');
    // scaffoldTemplates not set → no scaffolded candidates.
    expect(data.inferredAssetsSummary.templatesScaffolded).toBe(0);
    expect(
      data.plan.inferredTemplateCandidates.some((t) => t.scaffold),
    ).toBe(false);
  });

  test('scaffoldTemplates: true produces scaffolded candidates', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const res = await createOnboardingPlanTool.handler(
      { scaffoldTemplates: true },
      { inspection, cwd: root },
    );
    const data = res.data as {
      plan: { inferredTemplateCandidates: { scaffold?: unknown }[] };
      inferredAssetsSummary: { templatesScaffolded: number };
    };
    expect(data.inferredAssetsSummary.templatesScaffolded).toBeGreaterThan(0);
    expect(
      data.plan.inferredTemplateCandidates.some((t) => t.scaffold),
    ).toBe(true);
  });

  test('importAgents: true returns importedAgentRules', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const res = await createOnboardingPlanTool.handler(
      { importAgents: true },
      { inspection, cwd: root },
    );
    const data = res.data as {
      importedAgentRules?: {
        entries: { id: string }[];
        perSource: { kind: string }[];
      };
    };
    expect(data.importedAgentRules).toBeDefined();
    expect(data.importedAgentRules!.entries.length).toBeGreaterThan(0);
    expect(
      data.importedAgentRules!.perSource.some((s) => s.kind === 'agents-md'),
    ).toBe(true);
  });

  test('includeDiff: true returns a diff object', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const res = await createOnboardingPlanTool.handler(
      { includeDiff: true },
      { inspection, cwd: root },
    );
    const data = res.data as {
      diff?: {
        rules: { counts: { missing: number } };
        verificationCommands: { counts: { missing: number } };
      };
    };
    expect(data.diff).toBeDefined();
    expect(data.diff!.rules.counts.missing).toBeGreaterThan(0);
  });

  test('does not write any draft file', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    await createOnboardingPlanTool.handler(
      {
        scaffoldTemplates: true,
        importAgents: true,
        includeDiff: true,
      },
      { inspection, cwd: root },
    );
    // The MCP tool must never write — assert by absence of sharkcraft/onboarding.
    const onboardDir = join(root, 'sharkcraft', 'onboarding');
    const { existsSync } = await import('node:fs');
    expect(existsSync(onboardDir)).toBe(false);
  });
});
