/**
 * `shrk grounding` command surface tests.
 *
 * The schema + structural fields must be stable. Output is read by
 * external SDD plugins / skills, so any drift here is a wire break.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { GROUNDING_SCHEMA } from '@shrkcrft/inspector';
import { groundingCommand } from '../commands/grounding.command.ts';
import {
  captureStdout,
  makeArgs,
  makeTestProject,
  type ITestProjectHandle,
} from './_helpers/test-project.ts';

let project: ITestProjectHandle;

beforeEach(() => {
  project = makeTestProject({
    projectName: 'r58-grounding',
    description: 'r58 grounding smoke',
    verificationCommands: [
      { id: 'typecheck', label: 'tsc', command: 'true', trusted: true },
      { id: 'unit-tests', label: 'bun test', command: 'true', trusted: true },
      { id: 'untrusted-deploy', label: 'deploy', command: 'true', trusted: false },
    ],
  });
});

afterEach(() => {
  project.cleanup();
});

describe('shrk grounding', () => {
  test('refuses with usage when task is missing', async () => {
    const rc = await groundingCommand.run(makeArgs(project.root, [], {}));
    expect(rc).toBe(2);
  });

  test('--json emits sharkcraft.grounding/v1 with stable top-level fields', async () => {
    const body = await captureStdout(async () => {
      const rc = await groundingCommand.run(makeArgs(project.root, ['demo billing task'], { json: true }));
      expect(rc).toBe(0);
    });
    const payload = JSON.parse(body);
    expect(payload.schema).toBe(GROUNDING_SCHEMA);
    expect(payload.task).toBe('demo billing task');
    expect(typeof payload.generatedAt).toBe('string');
    expect(Array.isArray(payload.rules)).toBe(true);
    expect(Array.isArray(payload.knowledge)).toBe(true);
    expect(Array.isArray(payload.paths)).toBe(true);
    expect(Array.isArray(payload.templates)).toBe(true);
    expect(Array.isArray(payload.verificationCommandIds)).toBe(true);
    expect(Array.isArray(payload.recommendedMcpTools)).toBe(true);
    expect(Array.isArray(payload.recommendedCliCommands)).toBe(true);
    expect(typeof payload.tokenEstimate).toBe('number');
  });

  test('verificationCommandIds includes only trusted commands', async () => {
    const body = await captureStdout(async () => {
      await groundingCommand.run(makeArgs(project.root, ['x'], { json: true }));
    });
    const payload = JSON.parse(body);
    expect(payload.verificationCommandIds).toContain('typecheck');
    expect(payload.verificationCommandIds).toContain('unit-tests');
    expect(payload.verificationCommandIds).not.toContain('untrusted-deploy');
  });
});
