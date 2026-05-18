/**
 * feedback3 — `shrk why <file>` tests.
 *
 * The feedback called this "the single most useful onboarding
 * feature imaginable." The verb is read-only, composes existing
 * registries, and answers: "what constraints apply to THIS file?"
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { whyCommand } from '../commands/why.command.ts';
import {
  captureStdout,
  makeArgs,
  makeTestProject,
  type ITestProjectHandle,
} from './_helpers/test-project.ts';

let project: ITestProjectHandle;

beforeEach(() => {
  project = makeTestProject({
    projectName: 'why-test',
    withFiles: {
      'packages/billing/src/billing.ts': '// billing\n',
    },
  });
});

afterEach(() => {
  project.cleanup();
});

describe('feedback3 shrk why', () => {
  test('refuses with usage hint when no target is passed', async () => {
    const rc = await whyCommand.run(makeArgs(project.root, []));
    expect(rc).toBe(2);
  });

  test('--json emits sharkcraft.why/v1 with stable fields', async () => {
    const body = await captureStdout(async () => {
      const rc = await whyCommand.run(
        makeArgs(project.root, ['packages/billing/src/billing.ts'], { json: true }),
      );
      expect(rc).toBe(0);
    });
    const payload = JSON.parse(body);
    expect(payload.schema).toBe('sharkcraft.why/v1');
    expect(payload.target.kind).toBe('file');
    expect(payload.target.relativePath).toBe('packages/billing/src/billing.ts');
    expect(payload.inferredPackage).toBe('packages/billing');
    expect(payload.inferredLayer).toBe('billing');
    expect(Array.isArray(payload.pathConventions)).toBe(true);
    expect(Array.isArray(payload.rules)).toBe(true);
    expect(Array.isArray(payload.boundaries)).toBe(true);
    expect(Array.isArray(payload.knowledge)).toBe(true);
    expect(Array.isArray(payload.suggestedNext)).toBe(true);
  });

  test('non-existent path reports kind=missing and routes to search', async () => {
    const body = await captureStdout(async () => {
      const rc = await whyCommand.run(
        makeArgs(project.root, ['nonexistent/path.ts'], { json: true }),
      );
      expect(rc).toBe(0);
    });
    const payload = JSON.parse(body);
    expect(payload.target.kind).toBe('missing');
    // For missing targets the verb routes the agent to knowledge search.
    expect(payload.suggestedNext.some((s: string) => s.includes('shrk knowledge search'))).toBe(true);
  });

  test('directory target is recognized as kind=directory', async () => {
    const body = await captureStdout(async () => {
      await whyCommand.run(makeArgs(project.root, ['packages/billing'], { json: true }));
    });
    const payload = JSON.parse(body);
    expect(payload.target.kind).toBe('directory');
    expect(payload.inferredPackage).toBe('packages/billing');
  });

  test('apps/ paths infer the right package shape', async () => {
    // Write a file under apps/.
    const body = await captureStdout(async () => {
      await whyCommand.run(
        makeArgs(project.root, ['apps/web/src/main.ts'], { json: true }),
      );
    });
    const payload = JSON.parse(body);
    expect(payload.inferredPackage).toBe('apps/web');
    // No `inferredLayer` for apps/ — that field is engine-specific to packages/.
    expect(payload.inferredLayer).toBeUndefined();
  });
});
