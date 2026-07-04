/**
 * a26 item 1.2 — `trace literal` refinements (CLI surface).
 *
 * Two gaps closed against the doc's declare → register → consume →
 * render/handle spec:
 *  - the exact-literal tracer still works from `trace literal "<x>"`;
 *  - a bare `trace <query>` that fuzzy-resolves to NO matches now prints a
 *    one-line stderr hint pointing at `trace literal` (the doc's advertised
 *    surface) instead of dead-ending on "no matches found".
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { traceCommand } from '../commands/trace.command.ts';
import {
  captureStdout,
  makeArgs,
  makeTestProject,
  type ITestProjectHandle,
} from './_helpers/test-project.ts';

/** Capture stderr for the duration of a callback (mirror of captureStdout). */
async function captureStderr(fn: () => Promise<void> | void): Promise<string> {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: (s: string) => boolean }).write = (s: string) => {
    chunks.push(s);
    return true;
  };
  try {
    await fn();
  } finally {
    (process.stderr as { write: typeof original }).write = original;
  }
  return chunks.join('');
}

let project: ITestProjectHandle;

beforeEach(() => {
  project = makeTestProject({
    projectName: 'trace-literal-cli',
    withFiles: {
      'src/events.ts': "export const USER_CREATED = 'provided';\n",
    },
  });
});

afterEach(() => {
  project.cleanup();
});

describe('a26 trace literal CLI', () => {
  test('bare `trace <query>` with no fuzzy match prints the literal-tracer hint on stderr', async () => {
    let rc = 0;
    const err = await captureStderr(async () => {
      await captureStdout(async () => {
        rc = await traceCommand.run(makeArgs(project.root, ['zzz-no-such-thing']));
      });
    });
    // Exit-code semantics of the fuzzy path are unchanged (no match → 1).
    expect(rc).toBe(1);
    expect(err).toContain('shrk trace literal "zzz-no-such-thing"');
    expect(err.toLowerCase()).toContain('hint:');
  });

  test('`trace literal "<x>"` still traces the exact literal across files', async () => {
    let rc = 0;
    const out = await captureStdout(async () => {
      rc = await traceCommand.run(makeArgs(project.root, ['literal', 'provided']));
    });
    expect(rc).toBe(0);
    expect(out).toContain('Trace literal: "provided"');
    // The declared const in src/events.ts is found + classified.
    expect(out).toContain('src/events.ts');
  });
});
