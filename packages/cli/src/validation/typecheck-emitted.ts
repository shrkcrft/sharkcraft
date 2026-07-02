import * as ts from 'typescript';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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

const TSCONFIG_NAMES = ['tsconfig.json', 'tsconfig.base.json'];

function findTsconfig(projectRoot: string): string | null {
  for (const name of TSCONFIG_NAMES) {
    const p = resolve(projectRoot, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Typecheck a set of EMITTED (not-yet-written) files against the project's
 * detected tsconfig, without touching disk. Builds a `ts.Program` whose root
 * names are the emitted files, over a compiler host that overlays the rendered
 * bodies for those paths and reads everything else (imports, lib) from disk — so
 * a scaffold that references a real project symbol resolves, and a template bug
 * (bad syntax, a dangling import, a type mismatch) surfaces BEFORE apply instead
 * of at the human's next build.
 *
 * Only diagnostics located IN the emitted files are reported; pre-existing
 * errors elsewhere in the project are ignored (this is a generation gate, not a
 * whole-repo typecheck).
 */
export function typecheckEmittedFiles(
  projectRoot: string,
  files: readonly IEmittedFile[],
): IEmittedTypecheckResult {
  const tsFiles = files.filter((f) => /\.tsx?$/.test(f.absPath));
  if (tsFiles.length === 0) {
    return { ran: false, errors: [], note: 'no TS/TSX files in the emit set' };
  }

  let options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    esModuleInterop: true,
  };
  const tsconfigPath = findTsconfig(projectRoot);
  if (tsconfigPath) {
    const read = ts.readConfigFile(tsconfigPath, (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return undefined;
      }
    });
    if (!read.error) {
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(tsconfigPath));
      options = parsed.options;
    }
  }
  // Force a non-emitting, lib-skipping check regardless of the project's config.
  options.noEmit = true;
  options.skipLibCheck = true;
  options.incremental = false;
  delete options.composite;
  delete options.outDir;
  delete options.declaration;

  const overlay = new Map(tsFiles.map((f) => [resolve(f.absPath), f.contents] as const));
  const host = ts.createCompilerHost(options, true);
  const origGetSourceFile = host.getSourceFile.bind(host);
  const origReadFile = host.readFile.bind(host);
  const origFileExists = host.fileExists.bind(host);
  host.readFile = (fileName) => {
    const k = resolve(fileName);
    return overlay.has(k) ? overlay.get(k) : origReadFile(fileName);
  };
  host.fileExists = (fileName) => overlay.has(resolve(fileName)) || origFileExists(fileName);
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreate) => {
    const k = resolve(fileName);
    const body = overlay.get(k);
    if (body !== undefined) {
      return ts.createSourceFile(fileName, body, languageVersionOrOptions, true);
    }
    return origGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreate);
  };

  const rootNames = tsFiles.map((f) => resolve(f.absPath));
  const program = ts.createProgram({ rootNames, options, host });
  const errors: IEmittedTypecheckError[] = [];
  for (const rn of rootNames) {
    const sf = program.getSourceFile(rn);
    if (!sf) continue;
    const diags = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)];
    for (const d of diags) {
      if (d.category !== ts.DiagnosticCategory.Error) continue;
      let line = 0;
      let column = 0;
      if (d.file && typeof d.start === 'number') {
        const lc = d.file.getLineAndCharacterOfPosition(d.start);
        line = lc.line + 1;
        column = lc.character + 1;
      }
      errors.push({
        file: resolve(d.file?.fileName ?? rn),
        line,
        column,
        message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
      });
    }
  }
  return {
    ran: true,
    errors,
    ...(tsconfigPath ? { note: `checked against ${tsconfigPath}` } : { note: 'no tsconfig found — used defaults' }),
  };
}
