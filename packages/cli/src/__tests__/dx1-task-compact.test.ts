/**
 * DX#1 — `shrk task --json --compact` emits the minimal shape.
 *
 * The compact shape carries ONLY the load-bearing fields for agent /
 * skill consumption (rules / templates / verification IDs /
 * recommended commands). The full shape stays the default.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { taskCommand } from '../commands/task.command.ts';
import {
  captureStdout,
  makeArgs,
  makeTestProject,
  type ITestProjectHandle,
} from './_helpers/test-project.ts';

let project: ITestProjectHandle;

beforeEach(() => {
  project = makeTestProject({ projectName: 'dx1-task-compact' });
});

afterEach(() => {
  project.cleanup();
});

describe('DX#1 shrk task --compact', () => {
  test('--json --compact emits the v1-compact schema', async () => {
    const body = await captureStdout(async () => {
      await taskCommand.run(makeArgs(project.root, ['add a billing endpoint'], { json: true, compact: true }));
    });
    const payload = JSON.parse(body);
    expect(payload.schema).toBe('sharkcraft.task-packet/v1-compact');
    expect(payload.task).toBe('add a billing endpoint');
  });

  test('compact shape contains ONLY the load-bearing fields', async () => {
    const body = await captureStdout(async () => {
      await taskCommand.run(makeArgs(project.root, ['x'], { json: true, compact: true }));
    });
    const payload = JSON.parse(body);
    const keys = Object.keys(payload).sort();
    expect(keys).toEqual([
      'recommendedCliCommands',
      'recommendedMcpTools',
      'relevantRules',
      'relevantTemplates',
      'schema',
      'task',
      'verificationCommands',
    ]);
  });

  test('--json without --compact emits the full packet (back-compat)', async () => {
    const body = await captureStdout(async () => {
      await taskCommand.run(makeArgs(project.root, ['x'], { json: true }));
    });
    const payload = JSON.parse(body);
    // Full packet has many more top-level keys (no v1-compact schema marker).
    expect(payload.schema).toBeUndefined();
    expect(payload.detectedProfiles).toBeDefined();
    expect(payload.context).toBeDefined();
  });

  test('compact payload is materially smaller than the full payload', async () => {
    const compactBody = await captureStdout(async () => {
      await taskCommand.run(makeArgs(project.root, ['demo'], { json: true, compact: true }));
    });
    const fullBody = await captureStdout(async () => {
      await taskCommand.run(makeArgs(project.root, ['demo'], { json: true }));
    });
    // 50% smaller at the very least — empirically ~80% on the engine repo.
    expect(compactBody.length).toBeLessThan(fullBody.length * 0.5);
  });
});
