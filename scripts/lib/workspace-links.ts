#!/usr/bin/env bun
// The ONE workspace-link check (round 13, 13.2): a green build must be a
// runnable build.
//
// tsc resolves every @shrkcrft/* import through tsconfig paths (base: → src;
// build-dist: → ../<dep>/dist), and Bun resolves them the same way at runtime,
// so NEITHER build ever consults node_modules. The emitted dist keeps the bare
// `@shrkcrft/x` specifiers, and Node resolves those through the per-package
// links `bun install` creates (packages/<p>/node_modules/@shrkcrft/<dep> →
// ../../../<dep>). A tree built without re-running the install therefore builds
// green and dies under node at ESM link time — on every verb, --version
// included, and in the MCP server — while every Bun-run check stays green.
//
// Two rules, one pass (about a second on this repo — rule 1 alone is
// milliseconds; rule 2 parses every src file that names a workspace scope),
// run at the top of scripts/build.ts, before the
// scripts/build-dist.ts build loop, and as release-preflight's required
// `workspace-links` step:
//
//   1. LINKED — every `workspace:` pin in dependencies / peerDependencies /
//      optionalDependencies of every packages/* package (private ones and
//      dashboard included) resolves, from that package's directory, to the
//      workspace package itself: walk createRequire(<pkg>/package.json)
//      .resolve.paths(dep), take the first <p>/<dep>/package.json, realpath its
//      directory, compare. Not `require.resolve(dep + '/package.json')` (no
//      exports map exposes ./package.json, so Node refuses every one with
//      ERR_PACKAGE_PATH_NOT_EXPORTED), and not `resolve(dep)` / Bun.resolveSync
//      (tsconfig paths MASK the missing link).
//   2. DECLARED — every bare import of a workspace package in non-test src
//      (static, `import type`, `export … from`, `import x = require()`, literal
//      dynamic `import()`, `require()`, `typeof import()`) is declared in
//      dependencies, peerDependencies or optionalDependencies.
//      devDependencies-only fails: a src import ships in dist/, build-dist maps
//      paths from `dependencies` only, so such an import compiles through a
//      leftover link and publishes a bare runtime import no install provides.
//      The imports come from a full TypeScript parse: ts.preProcessFile's token
//      scanner loses sync after some constructs (a template literal whose
//      substitution holds a quote-bearing regex) and misses every dynamic
//      import after it — 6 in packages/cli/src/commands/bundle.command.ts.
//
// A link with no declaration at all (a leftover from an earlier install) is a
// WARNING: it can silently satisfy an undeclared import, locally and at runtime.
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, type Dirent } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import ts from 'typescript';

export interface IWorkspaceLinkReport {
  /** Realpath of the checked workspace root — the directory the messages name. */
  readonly root: string;
  /** Each one fails the build (exit 1). */
  readonly problems: readonly string[];
  /** Printed, never fatal. */
  readonly warnings: readonly string[];
  /** packages/* packages checked. */
  readonly packages: number;
  /** Runtime `workspace:` pins link-checked (rule 1). */
  readonly pins: number;
  /** Non-test src files read (rule 2). */
  readonly files: number;
  /** Bare workspace-package import sites checked against the manifest (rule 2). */
  readonly imports: number;
  readonly durationMs: number;
}

/** Where {@link runWorkspaceLinkGate} writes; defaults to stdout / stderr. */
export interface IWorkspaceLinkGateIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

type DependencySection = 'dependencies' | 'peerDependencies' | 'optionalDependencies' | 'devDependencies';

interface IWorkspacePackage {
  /** Realpath of the package directory. */
  readonly dir: string;
  /** Root-relative directory, e.g. `packages/cli`. */
  readonly rel: string;
  readonly name: string;
  readonly sections: Readonly<Record<DependencySection, Readonly<Record<string, string>>>>;
}

/** The sections a runtime import may be declared in, and whose `workspace:` pins must be linked. */
const RUNTIME_SECTIONS: readonly DependencySection[] = ['dependencies', 'peerDependencies', 'optionalDependencies'];
const ALL_SECTIONS: readonly DependencySection[] = [...RUNTIME_SECTIONS, 'devDependencies'];
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SKIPPED_DIRS: ReadonlySet<string> = new Set(['__tests__', 'node_modules', 'dist']);

/** The sentence the build prints for a missing link — the bin bootstrap prints the same one, `shrk: `-prefixed. */
function unlinkedMessage(dependency: string, neededBy: string, root: string): string {
  return `workspace dependency ${dependency} (needed by ${neededBy}) is not linked — run \`bun install\` in ${root}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, spec] of Object.entries(value)) if (typeof spec === 'string') out[key] = spec;
  return out;
}

function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Every workspace package directory the root's `workspaces` globs name (`<dir>/*` and literal dirs). */
function workspaceDirs(root: string, manifest: Record<string, unknown>): string[] {
  const raw = manifest['workspaces'];
  const globs = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw['packages']) ? raw['packages'] : ['packages/*'];
  const out: string[] = [];
  for (const glob of globs) {
    if (typeof glob !== 'string') continue;
    if (glob.endsWith('/*')) {
      const parent = glob.slice(0, -2);
      for (const name of listDirs(join(root, parent))) out.push(`${parent}/${name}`);
    } else if (!glob.includes('*')) {
      out.push(glob.replace(/\/$/, ''));
    }
  }
  return out;
}

function readPackage(root: string, rel: string, problems: string[]): IWorkspacePackage | undefined {
  const manifestPath = join(root, rel, 'package.json');
  if (!existsSync(manifestPath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    problems.push(`cannot read ${rel}/package.json (${(e as Error).message}) — its workspace links were not checked`);
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const name = typeof parsed['name'] === 'string' ? parsed['name'] : rel;
  const sections = {
    dependencies: stringRecord(parsed['dependencies']),
    peerDependencies: stringRecord(parsed['peerDependencies']),
    optionalDependencies: stringRecord(parsed['optionalDependencies']),
    devDependencies: stringRecord(parsed['devDependencies']),
  };
  return { dir: realpathSync(join(root, rel)), rel, name, sections };
}

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`; relative, absolute and `node:` specifiers → undefined. */
function packageNameOf(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes(':')) return undefined;
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined;
  return parts[0];
}

/** Every literal module specifier `text` imports, with its 1-based line — from a full parse, never a token scan. */
function importSpecifiers(file: string, text: string): Array<{ readonly specifier: string; readonly line: number }> {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  const out: Array<{ readonly specifier: string; readonly line: number }> = [];
  const visit = (node: ts.Node): void => {
    let spec: ts.Node | undefined;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      spec = node.moduleSpecifier;
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      spec = node.moduleReference.expression;
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      spec = node.arguments[0];
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      spec = node.argument.literal;
    }
    if (spec !== undefined && (ts.isStringLiteral(spec) || ts.isNoSubstitutionTemplateLiteral(spec))) {
      out.push({ specifier: spec.text, line: source.getLineAndCharacterOfPosition(spec.getStart(source)).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** Non-test source files under `dir`, sorted; an unreadable directory or file is a problem, never a pass. */
function sourceFiles(dir: string, root: string, problems: string[]): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (e) {
      problems.push(`cannot list ${relative(root, current)} (${(e as Error).message}) — its imports were not checked`);
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) stack.push(full);
      } else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

/** Rule 1 for one pin: undefined when `dependency` resolves from `pkg` to the workspace package itself. */
function linkProblem(pkg: IWorkspacePackage, dependency: string, target: IWorkspacePackage, root: string): string | undefined {
  const lookup = createRequire(join(pkg.dir, 'package.json')).resolve.paths(dependency) ?? [];
  for (const nodeModules of lookup) {
    const candidate = join(nodeModules, dependency);
    if (!existsSync(join(candidate, 'package.json'))) continue;
    const real = realpathSync(candidate);
    if (real === target.dir) return undefined;
    return (
      `workspace dependency ${dependency} (needed by ${pkg.name}) resolves to ${real}, ` +
      `not the workspace package ${target.rel} — run \`bun install\` in ${root}`
    );
  }
  return unlinkedMessage(dependency, pkg.name, root);
}

/**
 * Check every packages/* package under `root` against both rules. Reads the
 * file system only; never writes. `problems` fail the build, `warnings` do not.
 */
export function checkWorkspaceLinks(root: string): IWorkspaceLinkReport {
  const started = performance.now();
  const realRoot = realpathSync(root);
  const problems: string[] = [];
  const warnings: string[] = [];
  let rootManifest: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(realRoot, 'package.json'), 'utf8'));
    if (isRecord(parsed)) rootManifest = parsed;
  } catch {
    // No readable root manifest: fall back to the packages/* layout.
  }

  // Every workspace package is a name a pin may resolve to; the packages/* ones are the build's, and are checked.
  const byName = new Map<string, IWorkspacePackage>();
  const checked: IWorkspacePackage[] = [];
  const checkedRels = new Set(listDirs(join(realRoot, 'packages')).map((d) => `packages/${d}`));
  for (const rel of [...new Set([...checkedRels, ...workspaceDirs(realRoot, rootManifest)])]) {
    const pkg = readPackage(realRoot, rel, problems);
    if (pkg === undefined) continue;
    if (!byName.has(pkg.name)) byName.set(pkg.name, pkg);
    if (checkedRels.has(rel)) checked.push(pkg);
  }
  // A file that names no workspace scope (or unscoped workspace name) cannot import one: skip its parse.
  const scopes = [...new Set([...byName.keys()].map((n) => (n.startsWith('@') ? `${n.split('/')[0]}/` : n)))];

  let pins = 0;
  let files = 0;
  let imports = 0;
  for (const pkg of checked) {
    // Rule 1 — linked.
    const seen = new Set<string>();
    for (const section of RUNTIME_SECTIONS) {
      for (const [dependency, spec] of Object.entries(pkg.sections[section])) {
        if (!spec.startsWith('workspace:') || seen.has(dependency)) continue;
        seen.add(dependency);
        pins += 1;
        const target = byName.get(dependency);
        if (target === undefined) {
          problems.push(
            `${pkg.name} pins ${dependency} as "${spec}" in ${section}, but no workspace package has that name — fix ${pkg.rel}/package.json`,
          );
          continue;
        }
        const problem = linkProblem(pkg, dependency, target, realRoot);
        if (problem !== undefined) problems.push(problem);
      }
    }

    // A link with no declaration at all: a leftover that can mask an undeclared import.
    const declared = new Set(ALL_SECTIONS.flatMap((s) => Object.keys(pkg.sections[s])));
    for (const name of byName.keys()) {
      if (name === pkg.name || declared.has(name)) continue;
      if (lexists(join(pkg.dir, 'node_modules', name))) {
        warnings.push(
          `${name} is linked into ${pkg.rel}/node_modules, but ${pkg.name} does not declare it — ` +
            'a leftover link can silently satisfy an undeclared import (delete the link, or declare the dependency)',
        );
      }
    }

    // Rule 2 — declared.
    const runtime = new Set(RUNTIME_SECTIONS.flatMap((s) => Object.keys(pkg.sections[s])));
    const dev = new Set(Object.keys(pkg.sections.devDependencies));
    const findings = new Map<string, { first: string; count: number }>();
    for (const file of sourceFiles(join(pkg.dir, 'src'), realRoot, problems)) {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch (e) {
        problems.push(`cannot read ${relative(realRoot, file)} (${(e as Error).message}) — its imports were not checked`);
        continue;
      }
      files += 1;
      if (!scopes.some((s) => text.includes(s))) continue;
      for (const { specifier, line } of importSpecifiers(file, text)) {
        const name = packageNameOf(specifier);
        if (name === undefined || name === pkg.name || !byName.has(name)) continue;
        imports += 1;
        if (runtime.has(name)) continue;
        const at = `${relative(realRoot, file)}:${line}`;
        const prior = findings.get(name);
        findings.set(name, prior === undefined ? { first: at, count: 1 } : { first: prior.first, count: prior.count + 1 });
      }
    }
    for (const [name, { first, count }] of findings) {
      const where = count > 1 ? `${first}, and ${count - 1} more` : first;
      problems.push(
        dev.has(name)
          ? `${pkg.name} imports ${name} (${where}) but declares it only in devDependencies — ` +
              `a src import ships in dist/, so move it to "dependencies" (or "peerDependencies") in ${pkg.rel}/package.json`
          : `${pkg.name} imports ${name} (${where}) but does not declare it — ` +
              `add "${name}": "workspace:*" to "dependencies" in ${pkg.rel}/package.json`,
      );
    }
  }

  return {
    root: realRoot,
    problems,
    warnings,
    packages: checked.length,
    pins,
    files,
    imports,
    durationMs: performance.now() - started,
  };
}

const STDIO: IWorkspaceLinkGateIo = {
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
};

/**
 * Run the check and print it under `tag` (`[build]`, `[build-dist]`, …).
 * Returns the exit code: 1 on any problem, else 0. Warnings print either way.
 */
export function runWorkspaceLinkGate(root: string, tag: string, io: IWorkspaceLinkGateIo = STDIO): number {
  const report = checkWorkspaceLinks(root);
  for (const warning of report.warnings) io.err(`${tag} warning: ${warning}\n`);
  if (report.problems.length > 0) {
    for (const problem of report.problems) io.err(`${tag} ${problem}\n`);
    io.err(
      `${tag} ${report.problems.length} workspace dependency problem(s) — a build over this tree emits a dist that ` +
        'dies under node at load time (ERR_MODULE_NOT_FOUND), on every command, --version included\n',
    );
    return 1;
  }
  io.out(
    `${tag} workspace links ok — ${report.pins} workspace pin(s) linked across ${report.packages} package(s); ` +
      `${report.imports} workspace import(s) in ${report.files} src file(s) declared (${Math.round(report.durationMs)}ms)\n`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(runWorkspaceLinkGate(process.cwd(), '[workspace-links]'));
}
