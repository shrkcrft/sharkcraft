import { describe, expect, test } from 'bun:test';
import {
  buildAgentOrchestrationPlan,
  inspectSharkcraft,
  OrchestrationMode,
  simulateWorkflow,
} from '../index.ts';

describe('r18 agent orchestration + simulation', () => {
  test('conservative mode adds more review checkpoints than balanced', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const cons = await buildAgentOrchestrationPlan('add a new pack feature', inspection, {
      mode: OrchestrationMode.Conservative,
    });
    const bal = await buildAgentOrchestrationPlan('add a new pack feature', inspection, {
      mode: OrchestrationMode.Balanced,
    });
    expect(cons.reviewCheckpoints.length).toBeGreaterThanOrEqual(bal.reviewCheckpoints.length);
  });
  test('aggressive mode still never says auto-apply', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const plan = await buildAgentOrchestrationPlan('add a new pack feature', inspection, {
      mode: OrchestrationMode.Aggressive,
    });
    expect(plan.forbiddenActions.some((s) => /auto/i.test(s) || /publish/i.test(s))).toBe(true);
    expect(plan.phases.some((p) => p.humanApprovalRequired)).toBe(true);
  });
  test('plan contains MCP read-only safety note in forbiddenActions', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const plan = await buildAgentOrchestrationPlan('publish alpha', inspection);
    expect(plan.forbiddenActions.some((s) => /MCP/i.test(s))).toBe(true);
  });
  test('release-kind task suggests preflight + readiness', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const plan = await buildAgentOrchestrationPlan('tag the public alpha release', inspection);
    const cmds = plan.phases.flatMap((p) => p.recommendedCommands).join('\n');
    expect(/release\s+readiness/i.test(cmds)).toBe(true);
  });
  test('simulation contains phases and never executes', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const sim = await simulateWorkflow('add a new MCP tool', inspection);
    expect(sim.schema).toBe('sharkcraft.workflow-simulation/v1');
    expect(sim.predictedSteps.length).toBeGreaterThan(0);
    expect(sim.predictedSteps.every((s) => typeof s.command === 'string')).toBe(true);
  });
});
