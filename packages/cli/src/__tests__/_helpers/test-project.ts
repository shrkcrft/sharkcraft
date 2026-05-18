/**
 * DX#5 — Shared test scaffolding for CLI tests.
 *
 * Before this helper existed, every test file under
 * `packages/cli/src/__tests__/` re-implemented:
 *   - `makeArgs(positional, flags)` — Map shape for ParsedArgs
 *   - `makeRepo()` / `makeTestProject()` — temp dir with a synthetic
 *     `sharkcraft/sharkcraft.config.ts`
 *   - `captureStdout()` — stub process.stdout.write
 *
 * Each file's version had subtle differences (Map vs Record, flag
 * coercion rules, beforeEach lifecycle). The new author always got
 * one of those subtleties slightly wrong and stared at a failing
 * test for 10 minutes.
 *
 * This module is the one canonical version. Tests should import from
 * `./_helpers/test-project.ts` and never re-implement.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { ParsedArgs } from '../../command-registry.ts';

export interface IVerificationCommand {
  readonly id: string;
  readonly label?: string;
  readonly command: string;
  readonly trusted?: boolean;
}

export interface IMakeTestProjectOptions {
  /**
   * Verification commands to write into the synthetic
   * `sharkcraft.config.ts`. Defaults to the two trusted commands
   * most tests want (typecheck + unit-tests).
   */
  readonly verificationCommands?: readonly IVerificationCommand[];
  /** Project name in the config. Defaults to a unique-ish slug. */
  readonly projectName?: string;
  /** Free-form description in the config. */
  readonly description?: string;
  /** Additional files to write before the test runs. Keys are repo-rel paths. */
  readonly withFiles?: Readonly<Record<string, string>>;
  /** When true, write an empty `nx.json` (signals Nx-style workspace). */
  readonly withNxJson?: boolean;
  /** When true, also write a minimal `package.json` at the root. */
  readonly withPackageJson?: boolean;
}

export interface ITestProjectHandle {
  /** Absolute path to the temp project root. */
  readonly root: string;
  /**
   * Delete the temp project. Idempotent; safe to call in `afterEach`
   * even if the test already cleaned up.
   */
  readonly cleanup: () => void;
}

const DEFAULT_VERIFICATION_COMMANDS: readonly IVerificationCommand[] = Object.freeze([
  { id: 'typecheck', label: 'tsc', command: 'true', trusted: true },
  { id: 'unit-tests', label: 'bun test', command: 'true', trusted: true },
]);

/**
 * Create a temp project with a minimal `sharkcraft/sharkcraft.config.ts`
 * and any additional files the test needs. Returns the root path + a
 * cleanup function.
 *
 * Typical use:
 * ```ts
 * import { makeTestProject } from './_helpers/test-project.ts';
 *
 * let project: ITestProjectHandle;
 * beforeEach(() => { project = makeTestProject(); });
 * afterEach(() => { project.cleanup(); });
 * ```
 */
export function makeTestProject(opts: IMakeTestProjectOptions = {}): ITestProjectHandle {
  const slug = `cli-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const root = nodePath.join('/tmp', slug);
  mkdirSync(nodePath.join(root, 'sharkcraft'), { recursive: true });
  const verificationCommands = opts.verificationCommands ?? DEFAULT_VERIFICATION_COMMANDS;
  const configBody = renderConfig({
    projectName: opts.projectName ?? slug,
    description: opts.description ?? 'shared-helper test project',
    verificationCommands,
  });
  writeFileSync(nodePath.join(root, 'sharkcraft/sharkcraft.config.ts'), configBody, 'utf8');
  if (opts.withNxJson) {
    writeFileSync(nodePath.join(root, 'nx.json'), '{}\n', 'utf8');
  }
  if (opts.withPackageJson) {
    writeFileSync(
      nodePath.join(root, 'package.json'),
      JSON.stringify({ name: slug, version: '0.0.0' }, null, 2) + '\n',
      'utf8',
    );
  }
  if (opts.withFiles) {
    for (const [rel, contents] of Object.entries(opts.withFiles)) {
      const abs = nodePath.join(root, rel);
      mkdirSync(nodePath.dirname(abs), { recursive: true });
      writeFileSync(abs, contents, 'utf8');
    }
  }
  return {
    root,
    cleanup() {
      if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    },
  };
}

function renderConfig(input: {
  projectName: string;
  description: string;
  verificationCommands: readonly IVerificationCommand[];
}): string {
  const verifications = input.verificationCommands
    .map(
      (c) =>
        `    { id: ${JSON.stringify(c.id)}, label: ${JSON.stringify(c.label ?? c.id)}, command: ${JSON.stringify(c.command)}, trusted: ${c.trusted ?? true} }`,
    )
    .join(',\n');
  return `export default {
  projectName: ${JSON.stringify(input.projectName)},
  description: ${JSON.stringify(input.description)},
  knowledgeFiles: [],
  ruleFiles: [],
  pathFiles: [],
  templateFiles: [],
  pipelineFiles: [],
  boundaryFiles: [],
  docsFiles: [],
  verificationCommands: [
${verifications}
  ],
};
`;
}

/**
 * Build a `ParsedArgs` value for invoking a command handler in-process.
 * Converts the plain `flags` object into the `Map<string, string | boolean>`
 * shape the registry expects. Numeric flag values are stringified.
 */
export function makeArgs(
  projectRoot: string,
  positional: readonly string[],
  flags: Readonly<Record<string, string | number | boolean>> = {},
): ParsedArgs {
  const flagMap = new Map<string, string | boolean>();
  for (const [k, v] of Object.entries(flags)) {
    flagMap.set(k, typeof v === 'number' ? String(v) : v);
  }
  return {
    positional: [...positional],
    flags: flagMap,
    multiFlags: new Map(),
    globalCwd: projectRoot,
  };
}

/**
 * Capture stdout for the duration of a callback. Returns the captured
 * text. The original `process.stdout.write` is restored even if the
 * callback throws.
 */
export async function captureStdout(fn: () => Promise<void> | void): Promise<string> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: (s: string) => boolean }).write = (s: string) => {
    chunks.push(s);
    return true;
  };
  try {
    await fn();
  } finally {
    (process.stdout as { write: typeof original }).write = original;
  }
  return chunks.join('');
}
