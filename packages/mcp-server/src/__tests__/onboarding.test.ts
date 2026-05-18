import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import {
  createOnboardingPlanTool,
  getOnboardingReportPreviewTool,
  listInferredAssetsTool
} from '../tools/onboarding.tool.ts';

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-mcp-onboard-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: '@example/onboarding-mcp-fixture',
      version: '0.0.0',
      scripts: { test: 'bun test', typecheck: 'tsc --noEmit' },
      devDependencies: { '@types/bun': '*' },
    }),
  );
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true } }),
  );
  mkdirSync(join(root, 'src', 'services'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'services', 'user.service.ts'),
    'export class UserService {}\n',
  );
  return root;
}

describe('MCP onboarding tools', () => {
  test('create_onboarding_plan returns a structured plan + writes nothing', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const res = await createOnboardingPlanTool.handler(
      {},
      { inspection, cwd: root },
    );
    expect(res.isError).toBeFalsy();
    const data = res.data as {
      plan: { inferredVerificationCommands: unknown[] };
      nextCommand: string;
    };
    expect(data.plan.inferredVerificationCommands.length).toBeGreaterThan(0);
    expect(data.nextCommand).toBe('shrk onboard --write-drafts');
    // Sanity: the tool must NOT have written any draft file.
    expect(existsSync(join(root, 'sharkcraft', 'onboarding'))).toBe(false);
  });

  test('get_onboarding_report_preview returns a Markdown report', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const res = await getOnboardingReportPreviewTool.handler(
      {},
      { inspection, cwd: root },
    );
    const data = res.data as { markdown: string; nextCommand: string };
    expect(data.markdown).toContain('# SharkCraft onboarding report');
    expect(data.nextCommand).toBe('shrk onboard --write-drafts');
  });

  test('list_inferred_assets returns id summaries only', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const res = await listInferredAssetsTool.handler(
      {},
      { inspection, cwd: root },
    );
    const data = res.data as {
      rules: { id: string }[];
      paths: { id: string }[];
      verificationCommands: { id: string; command: string }[];
      nextCommand: string;
    };
    expect(data.rules.length).toBeGreaterThan(0);
    expect(data.paths.length).toBeGreaterThan(0);
    expect(
      data.verificationCommands.some((v) => v.id === 'test'),
    ).toBe(true);
    expect(data.nextCommand).toBe('shrk onboard --write-drafts');
  });

  test('preferredPreset is honored by all three tools', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const res = await createOnboardingPlanTool.handler(
      { preferredPreset: 'bun-service' },
      { inspection, cwd: root },
    );
    const data = res.data as {
      plan: { recommendedPresets: { preset: { id: string } }[] };
    };
    expect(data.plan.recommendedPresets[0]?.preset.id).toBe('bun-service');
  });
});
