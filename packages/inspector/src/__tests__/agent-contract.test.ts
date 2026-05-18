import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import {
  AGENT_CONTRACT_SCHEMA,
  RoleId,
  TaskRiskLevel,
  buildAgentContract,
  inspectSharkcraft,
} from '../index.ts';

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-r23-contract-'));
  try {
    writeFileSync(
      nodePath.join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '0.0.0' }),
    );
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('agent contract', () => {
  it('low-risk docs task does not require human approval', async () => {
    await withRoot(async (root) => {
      const inspection = await inspectSharkcraft({ cwd: root });
      const c = await buildAgentContract('update documentation typos', inspection, {
        role: 'developer',
      });
      expect(c.schema).toBe(AGENT_CONTRACT_SCHEMA);
      expect(c.role).toBe(RoleId.Developer);
      expect(c.taskRisk.riskLevel).toBe(TaskRiskLevel.Low);
      expect(c.humanApprovalGates).toEqual([]);
    });
  });

  it('high-risk public API task adds public-api review + plan reviews', async () => {
    await withRoot(async (root) => {
      const inspection = await inspectSharkcraft({ cwd: root });
      const c = await buildAgentContract(
        'change plugin-api public API to add a new event registry hook (architecture)',
        inspection,
        {
          role: 'reviewer',
          files: ['plugin-api/src/index.ts'],
        },
      );
      const reviewsJoined = c.requiredReviews.join(' | ');
      expect(reviewsJoined.toLowerCase()).toContain('api review');
      expect(c.publicApiRisks.length).toBeGreaterThan(0);
    });
  });

  it('release task forbids publish/tag', async () => {
    await withRoot(async (root) => {
      const inspection = await inspectSharkcraft({ cwd: root });
      const c = await buildAgentContract('release v1.0.0 and publish to npm', inspection, {
        role: 'release-manager',
      });
      const forbidden = c.forbiddenCommands.join(' | ');
      expect(forbidden).toContain('npm publish');
      expect(forbidden).toContain('git push --tags');
    });
  });

  it('ai-agent role forbids MCP writes and auto-apply', async () => {
    await withRoot(async (root) => {
      const inspection = await inspectSharkcraft({ cwd: root });
      const c = await buildAgentContract('add a new pipeline', inspection, {
        role: 'ai-agent',
      });
      const forbidden = c.forbiddenCommands.join(' | ');
      expect(forbidden).toContain('MCP tool that writes');
      expect(forbidden.toLowerCase()).toContain('auto-apply');
      expect(c.requiredReviews.join(' | ').toLowerCase()).toContain('human in the loop');
    });
  });

  it('reviewer role surfaces review commands', async () => {
    await withRoot(async (root) => {
      const inspection = await inspectSharkcraft({ cwd: root });
      const c = await buildAgentContract('review impact of bug fix in auth module', inspection, {
        role: 'reviewer',
      });
      const cmds = c.allowedCommands.join(' | ');
      expect(cmds).toContain('shrk review packet');
    });
  });
});
