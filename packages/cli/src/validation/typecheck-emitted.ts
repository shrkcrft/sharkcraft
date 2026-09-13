import { resolve } from 'node:path';
import { typecheckFiles } from '@shrkcrft/inspector';

/** A file the generator would emit, with its rendered (in-memory) contents. */
export interface IEmittedFile {
  /** Absolute path the file would land at. */
  absPath: string;
  /** Rendered body (never written to disk by the typecheck). */
  contents: string;
}

/** A single typecheck error located in an emitted file. */
export interface IEmittedTypecheckError {
  file: string;
  line: number;
  column: number;
  message: string;
}

export interface IEmittedTypecheckResult {
  /** False when there were no TS/TSX files to check (e.g. a docs-only template). */
  ran: boolean;
  errors: readonly IEmittedTypecheckError[];
  /** Human note (why it didn't run, or which tsconfig it used). */
  note?: string;
}

/**
 * Typecheck a set of EMITTED (not-yet-written) files against the project's
 * detected tsconfig, without touching disk — a scaffold that references a real
 * project symbol resolves, and a template bug (bad syntax, a dangling import, a
 * type mismatch) surfaces BEFORE apply instead of at the human's next build.
 *
 * A thin wrapper over the ONE in-process TypeScript check,
 * `typecheckFiles` (`@shrkcrft/inspector`): the emitted bodies are passed as
 * an overlay and only diagnostics IN the emitted files are reported —
 * pre-existing errors elsewhere in the project are ignored (this is a
 * generation gate, not a whole-repo typecheck).
 */
export function typecheckEmittedFiles(
  projectRoot: string,
  files: readonly IEmittedFile[],
): IEmittedTypecheckResult {
  const tsFiles = files.filter((f) => /\.tsx?$/.test(f.absPath));
  if (tsFiles.length === 0) {
    return { ran: false, errors: [], note: 'no TS/TSX files in the emit set' };
  }
  const result = typecheckFiles(projectRoot, {
    rootNames: tsFiles.map((f) => resolve(f.absPath)),
    overlay: new Map(tsFiles.map((f) => [resolve(f.absPath), f.contents] as const)),
  });
  return {
    ran: result.ran,
    errors: result.errors.map(({ file, line, column, message }) => ({ file, line, column, message })),
    ...(result.note ? { note: result.note } : {}),
  };
}
