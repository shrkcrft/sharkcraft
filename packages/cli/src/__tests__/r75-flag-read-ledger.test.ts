/**
 * r75 — a flag a command's code READS is a flag of that command (round 11
 * §5.2, review fix).
 *
 * The post-run unknown-flag detector (`dispatch/unread-flags.ts`) turns a `0`
 * into `usageExitFor(path)` when a supplied flag was never read AND is not
 * documented — "documented-but-unread never changes the exit". That held only
 * as far as the usage strings named every flag the code reads, and nothing
 * enforced it: `export claude-md --write --force` WROTE CLAUDE.md and then
 * exited 2 — the handler reads `--force` only when the file already exists,
 * and no usage named it — so one command answered 0 or 2 depending on disk
 * state. `eslint scaffold` / `biome scaffold --write --force` the same: the
 * bridge dispatches `scaffold` internally, so the scaffold usage (which names
 * `--force`) was never documentation of the `eslint` / `biome` handler.
 *
 * The lock, over THE registry: for every handler the detector tracks, every
 * flag literal its code can reach — `flagBool / flagString / flagNumber /
 * flagPositiveInt / flagList(args, '<x>')` and `args.flags|multiFlags
 * .get|.has('<x>')`, through module-level helpers and named, re-exported,
 * `export *`, namespace and lazily `import()`ed modules — is documented by its
 * usage (`usageFlagDocumentation`) or listed in `UNDOCUMENTED_FLAG_READS`, the
 * ledger the detector reads at runtime. Two-way: an entry whose flag is now
 * documented, or no longer read, fails as stale, so the ledger only shrinks.
 * Only the global flags are let through. What it cannot see: a flag NAME
 * computed at runtime.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import * as ts from 'typescript';
import type { ICommandHandler } from '../command-registry.ts';
import { GLOBAL_FLAGS } from '../dispatch/global-flags.ts';
import { UNDOCUMENTED_FLAG_READS } from '../dispatch/undocumented-flag-reads.ts';
import {
  flagDocumentation,
  isFlagDocumented,
  settleUnreadFlags,
  tracksFlagReads,
  usageFlagDocumentation,
} from '../dispatch/unread-flags.ts';
import { walkDeclaredSubverbs } from '../dispatch/walk-declared-subverbs.ts';
import { buildRegistry } from '../main.ts';
import { commandIndexFor } from '../surface/command-index.ts';

const CLI_SRC = join(import.meta.dir, '..');
const CLI_MAIN = join(CLI_SRC, 'main.ts');

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

// ─── the scanner ─────────────────────────────────────────────────────────────

/** THE flag readers (command-registry.ts): `reader(args, '<flag>', …)`. */
const FLAG_READERS: ReadonlySet<string> = new Set(['flagBool', 'flagString', 'flagNumber', 'flagPositiveInt', 'flagList']);

/** Handlers a factory builds — no module export identifies them, so the factory is where their code lives. */
const FACTORY_BUILT: Readonly<Record<string, { readonly file: string; readonly name: string }>> = {
  help: { file: join(CLI_SRC, 'commands/help.command.ts'), name: 'makeHelpCommand' },
  commands: { file: join(CLI_SRC, 'commands/commands.command.ts'), name: 'makeCommandsCommand' },
};

interface IModule {
  readonly file: string;
  readonly source: ts.SourceFile;
  /** Top-level functions, classes and variables by name. */
  readonly decls: ReadonlyMap<string, ts.Node>;
  /** Named imports and `export { x } from` of relative modules: local name → where it is declared. */
  readonly imports: ReadonlyMap<string, { readonly file: string; readonly name: string }>;
  /** `import * as ns from './x.ts'`: ns → module. */
  readonly namespaces: ReadonlyMap<string, string>;
  /** `export * from './x.ts'`. */
  readonly starExports: readonly string[];
}

interface IFlagRead {
  readonly flag: string;
  /** `file:line` of the read, relative to packages/cli/src. */
  readonly at: string;
}

function resolveRelative(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

const moduleCache = new Map<string, IModule>();

function loadModule(file: string): IModule {
  const cached = moduleCache.get(file);
  if (cached) return cached;
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const decls = new Map<string, ts.Node>();
  const imports = new Map<string, { file: string; name: string }>();
  const namespaces = new Map<string, string>();
  const starExports: string[] = [];
  for (const st of source.statements) {
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) {
      decls.set(st.name.text, st);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) decls.set(d.name.text, d);
    } else if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const target = st.moduleSpecifier.text.startsWith('.') ? resolveRelative(file, st.moduleSpecifier.text) : undefined;
      const bindings = st.importClause?.namedBindings;
      if (target && bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) imports.set(el.name.text, { file: target, name: (el.propertyName ?? el.name).text });
      } else if (target && bindings && ts.isNamespaceImport(bindings)) {
        namespaces.set(bindings.name.text, target);
      }
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      const target = st.moduleSpecifier.text.startsWith('.') ? resolveRelative(file, st.moduleSpecifier.text) : undefined;
      if (!target) continue;
      if (!st.exportClause) starExports.push(target);
      else if (ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) imports.set(el.name.text, { file: target, name: (el.propertyName ?? el.name).text });
      }
    }
  }
  const mod: IModule = { file, source, decls, imports, namespaces, starExports };
  moduleCache.set(file, mod);
  return mod;
}

/** `import('<relative>')` — awaited and/or parenthesised — → the module it loads. */
function lazyImportTarget(mod: IModule, node: ts.Expression): string | undefined {
  let n: ts.Expression = node;
  while (ts.isParenthesizedExpression(n) || ts.isAwaitExpression(n)) n = n.expression;
  if (!ts.isCallExpression(n) || n.expression.kind !== ts.SyntaxKind.ImportKeyword) return undefined;
  const spec = n.arguments[0];
  return spec && ts.isStringLiteralLike(spec) && spec.text.startsWith('.') ? resolveRelative(mod.file, spec.text) : undefined;
}

/** An identifier in a property-NAME slot (`x.name`, `{ name: … }`) refers to no binding. */
function isPropertyNameSlot(id: ts.Identifier): boolean {
  const p = id.parent;
  return (
    (ts.isPropertyAccessExpression(p) && p.name === id) ||
    (ts.isPropertyAssignment(p) && p.name === id) ||
    (ts.isMethodDeclaration(p) && p.name === id) ||
    (ts.isPropertyDeclaration(p) && p.name === id) ||
    (ts.isBindingElement(p) && p.propertyName === id)
  );
}

/**
 * The reader implementations themselves (command-registry.ts) read a flag NAME
 * parameter: each call site records its literal, so the bodies are not walked
 * (their `args.flags.get(name)` would otherwise read as a blind spot).
 */
const READER_IMPLS: ReadonlySet<string> = new Set([...FLAG_READERS, 'requireInputSelector']);
const COMMAND_REGISTRY_FILE = join(CLI_SRC, 'command-registry.ts');

/**
 * Every flag-reader argument the scan could NOT reduce to literal names
 * (`at` → source text). Each one is a blind spot: a real flag read there is
 * invisible to the ledger, so the post-run detector would call it dropped. The
 * lock below fails on any entry — round 11 review: `readArtifact(args, name)`
 * read `--boundaries|--coverage|--drift` through a parameter, and `review
 * render-comment <v3 packet> --boundaries b.json` exited 2.
 */
const unresolvedNames = new Map<string, string>();

function unwrapExpression(e: ts.Expression): ts.Expression {
  let n = e;
  while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isTypeAssertionExpression(n)) {
    n = n.expression;
  }
  return n;
}

/** The initializer of a module-level `const name = …` here, or where a relative import / re-export points. */
function constInitializer(mod: IModule, name: string, depth = 0): { mod: IModule; init: ts.Expression } | undefined {
  if (depth > 4) return undefined;
  const decl = mod.decls.get(name);
  if (decl && ts.isVariableDeclaration(decl) && decl.initializer) return { mod, init: unwrapExpression(decl.initializer) };
  const imported = mod.imports.get(name);
  if (imported) return constInitializer(loadModule(imported.file), imported.name, depth + 1);
  for (const star of mod.starExports) {
    const hit = constInitializer(loadModule(star), name, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

/** The named function whose parameter `id` refers to: its name and the parameter index. */
function enclosingParameter(id: ts.Identifier): { name: string; index: number } | undefined {
  for (let p: ts.Node | undefined = id.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) || ts.isArrowFunction(p) || ts.isFunctionExpression(p) || ts.isMethodDeclaration(p)) {
      const index = p.parameters.findIndex((param) => ts.isIdentifier(param.name) && param.name.text === id.text);
      if (index < 0) continue;
      if (ts.isFunctionDeclaration(p) && p.name) return { name: p.name.text, index };
      if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name)) {
        return { name: p.parent.name.text, index };
      }
      return undefined;
    }
  }
  return undefined;
}

/** `for (const x of ['a', 'b'])` — the loop variable's literal values. */
function forOfLiterals(id: ts.Identifier): string[] | undefined {
  for (let p: ts.Node | undefined = id.parent; p; p = p.parent) {
    if (!ts.isForOfStatement(p) || !ts.isVariableDeclarationList(p.initializer)) continue;
    const decl = p.initializer.declarations[0];
    if (!decl || !ts.isIdentifier(decl.name) || decl.name.text !== id.text) continue;
    const list = unwrapExpression(p.expression);
    if (!ts.isArrayLiteralExpression(list) || !list.elements.every((e) => ts.isStringLiteralLike(e))) return undefined;
    return list.elements.map((e) => (e as ts.StringLiteralLike).text);
  }
  return undefined;
}

/** Every non-test CLI source file. */
function cliSourceFiles(): string[] {
  const out: string[] = [];
  const walkDir = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) {
        if (name !== '__tests__') walkDir(abs);
      } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(abs);
    }
  };
  walkDir(CLI_SRC);
  return out;
}

/**
 * Every call of the function `name` declared in `declFile`: in its own module,
 * and in every module that imports it (under any local name).
 */
function callSitesOf(declFile: string, name: string): { mod: IModule; call: ts.CallExpression }[] {
  const out: { mod: IModule; call: ts.CallExpression }[] = [];
  for (const file of cliSourceFiles()) {
    const mod = loadModule(file);
    const local = new Set<string>(file === declFile ? [name] : []);
    for (const [alias, target] of mod.imports) if (target.file === declFile && target.name === name) local.add(alias);
    if (local.size === 0) continue;
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && local.has(n.expression.text)) out.push({ mod, call: n });
      ts.forEachChild(n, visit);
    };
    visit(mod.source);
  }
  return out;
}

/**
 * The literal flag names `arg` can hold: a literal; a module const
 * (`ALLOW_EMPTY_FLAG`); a `for…of` loop variable over a literal array; or a
 * helper's parameter (`readArtifact(args, name)`), resolved at every call site
 * of the helper. `undefined` = a blind spot.
 */
function literalNames(mod: IModule, arg: ts.Expression, depth = 0): string[] | undefined {
  const e = unwrapExpression(arg);
  if (ts.isStringLiteralLike(e)) return e.text.length > 0 ? [e.text] : [];
  if (!ts.isIdentifier(e) || depth > 3) return undefined;
  const constant = constInitializer(mod, e.text);
  if (constant) return ts.isStringLiteralLike(constant.init) ? [constant.init.text] : undefined;
  const loop = forOfLiterals(e);
  if (loop) return loop;
  const param = enclosingParameter(e);
  if (!param) return undefined;
  const sites = callSitesOf(mod.file, param.name);
  if (sites.length === 0) return undefined;
  const out: string[] = [];
  for (const site of sites) {
    const passed = site.call.arguments[param.index];
    const names = passed ? literalNames(site.mod, passed, depth + 1) : undefined;
    if (!names) return undefined;
    out.push(...names);
  }
  return out;
}

/** Every flag name the code declared as `name` in `file` can reach — a deliberate over-approximation. */
function flagReadsFrom(file: string, name: string): IFlagRead[] {
  const reads: IFlagRead[] = [];
  const seen = new Set<string>();
  const follow = (at: string, declName: string): void => {
    const key = `${at}#${declName}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (at === COMMAND_REGISTRY_FILE && READER_IMPLS.has(declName)) return;
    const mod = loadModule(at);
    const decl = mod.decls.get(declName);
    if (decl) return walk(mod, decl);
    const imported = mod.imports.get(declName);
    if (imported) return follow(imported.file, imported.name);
    for (const star of mod.starExports) follow(star, declName);
  };
  const walk = (mod: IModule, root: ts.Node): void => {
    const where = (call: ts.Node): string =>
      `${relative(CLI_SRC, mod.file)}:${mod.source.getLineAndCharacterOfPosition(call.getStart(mod.source)).line + 1}`;
    const record = (arg: ts.Expression | undefined, call: ts.Node): void => {
      if (!arg) return;
      const names = literalNames(mod, arg);
      if (!names) {
        unresolvedNames.set(where(call), arg.getText(mod.source));
        return;
      }
      for (const flag of names) reads.push({ flag, at: where(call) });
    };
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        if (ts.isIdentifier(callee) && callee.text === 'requireInputSelector') {
          // `requireInputSelector(args, { flags: ['files', …] })` reads each listed flag.
          const spec = n.arguments[1] ? unwrapExpression(n.arguments[1]) : undefined;
          const prop =
            spec && ts.isObjectLiteralExpression(spec)
              ? spec.properties.find((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'flags')
              : undefined;
          let list = prop && ts.isPropertyAssignment(prop) ? unwrapExpression(prop.initializer) : undefined;
          if (list && ts.isIdentifier(list)) list = constInitializer(mod, list.text)?.init;
          if (list && ts.isArrayLiteralExpression(list)) {
            for (const el of list.elements) record(el, n);
          } else {
            unresolvedNames.set(where(n), n.getText(mod.source).slice(0, 80));
          }
        } else if (ts.isIdentifier(callee) && FLAG_READERS.has(callee.text)) {
          record(n.arguments[1], n);
        } else if (
          ts.isPropertyAccessExpression(callee) &&
          (callee.name.text === 'get' || callee.name.text === 'has') &&
          ts.isPropertyAccessExpression(callee.expression) &&
          (callee.expression.name.text === 'flags' || callee.expression.name.text === 'multiFlags')
        ) {
          record(n.arguments[0], n);
        }
      } else if (ts.isPropertyAccessExpression(n)) {
        // `ns.fn` (namespace import) and `(await import('./x.ts')).fn`.
        const target = ts.isIdentifier(n.expression)
          ? mod.namespaces.get(n.expression.text)
          : lazyImportTarget(mod, n.expression);
        if (target) follow(target, n.name.text);
      } else if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer) {
        // `const { a, b: c } = await import('./x.ts')`.
        const target = lazyImportTarget(mod, n.initializer);
        if (target) {
          for (const el of n.name.elements) {
            const prop = el.propertyName ?? el.name;
            if (ts.isIdentifier(prop)) follow(target, prop.text);
          }
        }
      } else if (ts.isIdentifier(n) && !isPropertyNameSlot(n) && (mod.decls.has(n.text) || mod.imports.has(n.text))) {
        follow(mod.file, n.text);
      }
      ts.forEachChild(n, visit);
    };
    visit(root);
  };
  follow(file, name);
  return reads;
}

/** Every `commands/**` module — where the registered handlers are exported from. */
function commandModules(): string[] {
  const out: string[] = [];
  const walkDir = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walkDir(abs);
      else if (name.endsWith('.ts')) out.push(abs);
    }
  };
  walkDir(join(CLI_SRC, 'commands'));
  return out;
}

interface IScan {
  /** Tracked handler paths the scan could not attribute to source. */
  readonly unlocated: readonly string[];
  readonly tracked: number;
  /** Every flag each tracked path's code reads (global flags excluded). */
  readonly readsByPath: ReadonlyMap<string, ReadonlySet<string>>;
  /** path → flag → first read site, for reads its usage does not document. */
  readonly undocumented: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

async function scanRegistry(): Promise<IScan> {
  const registry = buildRegistry();
  const index = commandIndexFor(registry);
  const tracked = registry
    .listAll()
    .filter(({ path, handler }) => tracksFlagReads(handler, walkDeclaredSubverbs(handler, path, [])));
  const wanted = new Set<unknown>(tracked.map((t) => t.handler));
  const located = new Map<unknown, { file: string; name: string }>();
  for (const file of commandModules()) {
    const exported = (await import(file)) as Record<string, unknown>;
    const mod = loadModule(file);
    for (const [name, value] of Object.entries(exported)) {
      if (wanted.has(value) && mod.decls.has(name) && !located.has(value)) located.set(value, { file, name });
    }
  }
  const unlocated: string[] = [];
  const readsByPath = new Map<string, Set<string>>();
  const undocumented = new Map<string, Map<string, string>>();
  for (const { path, handler } of tracked) {
    const key = path.join(' ');
    const where = located.get(handler) ?? FACTORY_BUILT[key];
    if (!where) {
      unlocated.push(key);
      continue;
    }
    const docs = usageFlagDocumentation(handler as ICommandHandler, path, index);
    const reads = new Set<string>();
    for (const read of flagReadsFrom(where.file, where.name)) {
      if (GLOBAL_FLAGS.has(read.flag)) continue;
      reads.add(read.flag);
      if (isFlagDocumented(read.flag, docs)) continue;
      const flags = undocumented.get(key) ?? new Map<string, string>();
      if (!flags.has(read.flag)) flags.set(read.flag, read.at);
      undocumented.set(key, flags);
    }
    readsByPath.set(key, reads);
  }
  return { unlocated, tracked: tracked.length, readsByPath, undocumented };
}

/** The ledger's entries as they should read — printed when the lock fails, to paste into undocumented-flag-reads.ts. */
function renderLedger(undocumented: ReadonlyMap<string, ReadonlyMap<string, string>>): string {
  const lines: string[] = [];
  for (const path of [...undocumented.keys()].sort()) {
    const flags = [...undocumented.get(path)!.keys()].sort().map((f) => `'${f}'`);
    const oneLine = `  ['${path}', [${flags.join(', ')}]],`;
    if (oneLine.length <= 110) {
      lines.push(oneLine);
      continue;
    }
    lines.push(`  [`, `    '${path}',`, `    [`);
    let row = '     ';
    for (const f of flags) {
      if (row.length + f.length + 2 > 110) {
        lines.push(row.trimEnd());
        row = '     ';
      }
      row += ` ${f},`;
    }
    lines.push(row.trimEnd(), `    ],`, `  ],`);
  }
  return lines.join('\n');
}

// ─── the lock ────────────────────────────────────────────────────────────────

describe('r75 — every flag a tracked handler reads is documented, or in the ledger (two-way)', () => {
  test('the scan over THE registry: no missing entry, no stale entry, every tracked handler examined', async () => {
    const scan = await scanRegistry();
    // An unattributed handler was never examined — an unexamined unit, not a clean one.
    expect(scan.unlocated).toEqual([]);
    // A flag NAME the scan could not reduce to literals is a blind spot: a real
    // read there is invisible to the ledger (round 11 review — `readArtifact(
    // args, name)` hid `--boundaries|--coverage|--drift`). Consts, `for…of`
    // over a literal array and helper parameters resolve; anything else fails.
    expect([...unresolvedNames].map(([at, text]) => `${at}  ${text}`).sort()).toEqual([]);
    // Non-vacuous: the scan sees the registry and the reads that motivated it.
    expect(scan.tracked).toBeGreaterThan(250);
    for (const path of ['export', 'eslint', 'biome']) {
      expect({ path, readsForce: scan.readsByPath.get(path)?.has('force') }).toEqual({ path, readsForce: true });
      expect({ path, undocumented: scan.undocumented.get(path)?.has('force') ?? false }).toEqual({
        path,
        undocumented: false,
      });
    }
    const missing: string[] = [];
    for (const [path, flags] of scan.undocumented) {
      for (const [flag, at] of flags) {
        if (!(UNDOCUMENTED_FLAG_READS.get(path) ?? []).includes(flag)) missing.push(`${path} --${flag}  (read at ${at})`);
      }
    }
    const stale: string[] = [];
    for (const [path, flags] of UNDOCUMENTED_FLAG_READS) {
      for (const flag of flags) {
        if (!scan.undocumented.get(path)?.has(flag)) {
          const why = scan.readsByPath.get(path)?.has(flag) ? 'now documented — delete it' : 'no longer read — delete it';
          stale.push(`${path} --${flag}: ${why}`);
        }
      }
    }
    if (missing.length > 0 || stale.length > 0) {
      process.stderr.write(
        '\nUNDOCUMENTED_FLAG_READS drifted from the code. Prefer documenting a flag in its usage; ' +
          'otherwise the ledger entries should read:\n' +
          `${renderLedger(scan.undocumented)}\n`,
      );
    }
    expect(missing).toEqual([]);
    expect(stale).toEqual([]);
  }, 120_000);

  test('the detector reads the ledger at runtime: an unread ledger flag keeps a 0', () => {
    const registry = buildRegistry();
    const index = commandIndexFor(registry);
    const quiet = (): void => undefined;
    const failures: string[] = [];
    for (const [path, flags] of UNDOCUMENTED_FLAG_READS) {
      const tokens = path.split(' ');
      const handler = registry.getAt(tokens);
      if (!handler) {
        failures.push(`${path}: not a registered path`);
        continue;
      }
      const docs = flagDocumentation(handler, tokens, index);
      for (const flag of flags) {
        const exit = settleUnreadFlags({ unread: [flag], path, documentation: docs, exit: 0, write: quiet });
        if (exit !== 0) failures.push(`${path} --${flag}: exit ${exit}`);
      }
    }
    expect(failures).toEqual([]);
    // …and the ledger entries are canonical: sorted, no duplicates, never a global flag.
    for (const [path, flags] of UNDOCUMENTED_FLAG_READS) {
      expect({ path, flags: [...flags] }).toEqual({ path, flags: [...new Set(flags)].sort() });
      expect({ path, global: flags.filter((f) => GLOBAL_FLAGS.has(f)) }).toEqual({ path, global: [] });
    }
    expect([...UNDOCUMENTED_FLAG_READS.keys()]).toEqual([...UNDOCUMENTED_FLAG_READS.keys()].sort());
  });

  test('a handler that forwards its argv declares flags covering every flag its code reads (nothing judges it after the run)', async () => {
    // Round 11 review: `smart-context "x" --dry-run --budgt 5` ran at exit 0 —
    // the forwarding exemption skipped the post-run detector in the parent AND
    // in the worker child (and in the inline dry-run), so no process judged the
    // argv. The declared set is what the pre-run guard judges instead.
    const registry = buildRegistry();
    const forwarding = registry.listAll().filter(({ handler }) => handler.forwardsArgv === true);
    expect(forwarding.length).toBeGreaterThanOrEqual(2);
    const failures: string[] = [];
    for (const { path, handler } of forwarding) {
      const label = path.join(' ');
      const declared = handler.flags;
      if (!declared) {
        failures.push(`${label}: forwards its argv but declares no flags`);
        continue;
      }
      let where: { file: string; name: string } | undefined;
      for (const file of commandModules()) {
        const exported = (await import(file)) as Record<string, unknown>;
        const hit = Object.entries(exported).find(([name, value]) => value === handler && loadModule(file).decls.has(name));
        if (hit) {
          where = { file, name: hit[0] };
          break;
        }
      }
      if (!where) {
        failures.push(`${label}: not located in source`);
        continue;
      }
      for (const read of flagReadsFrom(where.file, where.name)) {
        if (!GLOBAL_FLAGS.has(read.flag) && !declared.has(read.flag)) {
          failures.push(`${label} --${read.flag} (read at ${read.at}) is not in its declared flags`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);
});

// ─── spawned from source ─────────────────────────────────────────────────────

function consumerFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-flag-reads-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'consumer-app', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'consumer-app' };\n",
    'src/index.ts': "export const hello = (): string => 'hi';\n",
    'README.md': '# consumer-app\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  const git = (...a: string[]): void =>
    void spawnSync('git', ['-c', 'user.email=r75@test', '-c', 'user.name=r75', '-c', 'commit.gpgsign=false', ...a], {
      cwd: root,
    });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'r75');
  return root;
}

function shrk(cwd: string, argv: readonly string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('bun', [CLI_MAIN, ...argv], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, SHARKCRAFT_USAGE_DISABLED: '1' },
    timeout: 120_000,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('r75 — spawned from source: a real flag read behind a branch never escalates', () => {
  test('`export claude-md` / `eslint scaffold` / `biome scaffold --write --force`: 0 on the first write AND the rerun', () => {
    const fx = consumerFixture();
    const cases: readonly (readonly [readonly string[], string])[] = [
      [['export', 'claude-md', '--write', '--force'], 'CLAUDE.md'],
      [['eslint', 'scaffold', '--write', '--force'], 'eslint.sharkcraft.config.mjs'],
      [['biome', 'scaffold', '--write', '--force'], 'biome.sharkcraft.json'],
    ];
    for (const [argv, written] of cases) {
      expect({ written, before: existsSync(join(fx, written)) }).toEqual({ written, before: false });
      for (const attempt of ['first write', 'rerun'] as const) {
        const r = shrk(fx, argv);
        expect({
          argv: argv.join(' '),
          attempt,
          status: r.status,
          warned: r.stderr.includes('is not a flag of this command'),
        }).toEqual({ argv: argv.join(' '), attempt, status: 0, warned: false });
      }
      expect({ written, after: existsSync(join(fx, written)) }).toEqual({ written, after: true });
    }
  }, 300_000);

  test('a flag nothing reads still escalates on the same command: `export claude-md --zz-bogus` → 2', () => {
    const r = shrk(consumerFixture(), ['export', 'claude-md', '--zz-bogus']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--zz-bogus is not a flag of this command');
  }, 120_000);
});
