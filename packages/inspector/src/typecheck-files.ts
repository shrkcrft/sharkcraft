/**
 * THE in-process TypeScript check — one `ts.Program` builder shared by
 * `gen --typecheck` (emitted, not-yet-written files over an overlay) and
 * `packs test|doctor|release-check --typecheck` (a pack's own assets).
 *
 * It used to live in the CLI layer only, so nothing below the CLI could
 * type-check a pack; pack loading is transpile-only (Bun), and an asset with an
 * implicit-any parameter or a misspelled field loaded with every signal green.
 *
 * Deterministic, read-only, never emits. Only errors (not warnings) are
 * reported, and only for the files the caller scoped the check to.
 */
import * as ts from 'typescript';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

export interface ITypecheckFilesResult {
  /** False when there was nothing to check, or TypeScript could not run. */
  readonly ran: boolean;
  readonly errors: readonly {
    readonly file: string;
    readonly line: number;
    readonly column: number;
    readonly code: number;
    readonly message: string;
  }[];
  /** Absolute paths of the root files the program was built from. */
  readonly checkedFiles: readonly string[];
  /** The tsconfig whose options were applied, or null for the built-in defaults. */
  readonly tsconfigPath: string | null;
  /** Human note (why it did not run, or which tsconfig it used). */
  readonly note?: string;
}

const TSCONFIG_NAMES = ['tsconfig.json', 'tsconfig.base.json'];
const TS_SOURCE = /\.(?:[cm]?ts|tsx)$/;

function findTsconfig(root: string): string | null {
  for (const name of TSCONFIG_NAMES) {
    const p = resolve(root, name);
    if (existsSync(p)) return p;
  }
  return null;
}

function pushDiagnostic(
  out: { file: string; line: number; column: number; code: number; message: string }[],
  d: ts.Diagnostic,
  fallbackFile: string,
): void {
  if (d.category !== ts.DiagnosticCategory.Error) return;
  let line = 0;
  let column = 0;
  if (d.file && typeof d.start === 'number') {
    const lc = d.file.getLineAndCharacterOfPosition(d.start);
    line = lc.line + 1;
    column = lc.character + 1;
  }
  out.push({
    file: resolve(d.file?.fileName ?? fallbackFile),
    line,
    column,
    code: d.code,
    message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
  });
}

/**
 * Type-check `rootNames` (absolute or `root`-relative) against `root`'s
 * tsconfig (auto-detected unless `tsconfigPath` is given; `null` forces the
 * strict defaults). `overlay` supplies in-memory contents for paths that are
 * not on disk yet. By default only diagnostics IN the root files are reported;
 * `reportOnlyUnder` widens that to every program file under a directory (so a
 * group module an aggregator imports is checked too), excluding node_modules.
 */
export function typecheckFiles(
  root: string,
  options: {
    readonly rootNames: readonly string[];
    readonly overlay?: ReadonlyMap<string, string>;
    readonly tsconfigPath?: string | null;
    readonly reportOnlyUnder?: string;
    /** With no tsconfig, allow `.ts` import specifiers (Bun-loaded pack assets use them). */
    readonly allowTsExtensionsByDefault?: boolean;
    /** Report options/global diagnostics (e.g. a broken tsconfig) as errors too. */
    readonly includeGlobalDiagnostics?: boolean;
  },
): ITypecheckFilesResult {
  const rootNames = options.rootNames.map((p) => resolve(root, p)).filter((p) => TS_SOURCE.test(p));
  if (rootNames.length === 0) {
    return { ran: false, errors: [], checkedFiles: [], tsconfigPath: null, note: 'no TS/TSX files to check' };
  }

  let compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    esModuleInterop: true,
    ...(options.allowTsExtensionsByDefault ? { allowImportingTsExtensions: true } : {}),
  };
  const tsconfigPath =
    options.tsconfigPath === null
      ? null
      : options.tsconfigPath !== undefined
        ? resolve(root, options.tsconfigPath)
        : findTsconfig(root);
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
      compilerOptions = parsed.options;
    }
  }
  // Force a non-emitting, lib-skipping check regardless of the project's config.
  compilerOptions.noEmit = true;
  compilerOptions.skipLibCheck = true;
  compilerOptions.incremental = false;
  delete compilerOptions.composite;
  delete compilerOptions.outDir;
  delete compilerOptions.declaration;

  const overlay = new Map<string, string>();
  for (const [k, v] of options.overlay ?? []) overlay.set(resolve(k), v);

  const errors: { file: string; line: number; column: number; code: number; message: string }[] = [];
  try {
    const host = ts.createCompilerHost(compilerOptions, true);
    const origGetSourceFile = host.getSourceFile.bind(host);
    const origReadFile = host.readFile.bind(host);
    const origFileExists = host.fileExists.bind(host);
    host.readFile = (fileName) => {
      const k = resolve(fileName);
      return overlay.has(k) ? overlay.get(k) : origReadFile(fileName);
    };
    host.fileExists = (fileName) => overlay.has(resolve(fileName)) || origFileExists(fileName);
    host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreate) => {
      const body = overlay.get(resolve(fileName));
      if (body !== undefined) return ts.createSourceFile(fileName, body, languageVersionOrOptions, true);
      return origGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreate);
    };

    const program = ts.createProgram({ rootNames, options: compilerOptions, host });
    if (options.includeGlobalDiagnostics) {
      for (const d of [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()]) {
        pushDiagnostic(errors, d, tsconfigPath ?? root);
      }
    }
    const scoped: ts.SourceFile[] = [];
    if (options.reportOnlyUnder) {
      const under = resolve(options.reportOnlyUnder) + sep;
      const roots = new Set(rootNames);
      for (const sf of program.getSourceFiles()) {
        const f = resolve(sf.fileName);
        if (!roots.has(f) && (!f.startsWith(under) || f.includes(`${sep}node_modules${sep}`) || sf.isDeclarationFile)) {
          continue;
        }
        scoped.push(sf);
      }
    } else {
      for (const rn of rootNames) {
        const sf = program.getSourceFile(rn);
        if (sf) scoped.push(sf);
      }
    }
    for (const sf of scoped) {
      for (const d of [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)]) {
        pushDiagnostic(errors, d, sf.fileName);
      }
    }
  } catch (e) {
    return {
      ran: false,
      errors: [],
      checkedFiles: rootNames,
      tsconfigPath,
      note: `TypeScript could not run: ${(e as Error).message}`,
    };
  }
  return {
    ran: true,
    errors,
    checkedFiles: rootNames,
    tsconfigPath,
    note: tsconfigPath ? `checked against ${tsconfigPath}` : 'no tsconfig found — used defaults',
  };
}
