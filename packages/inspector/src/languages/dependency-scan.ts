/**
 * Polyglot dependency scan.
 *
 * Parses common import / use / using / package directives across Java, C#,
 * Python, Go, Rust. The output is approximate (no compiler integration); each
 * profile carries its own confidence + a `limitations` block. Pure regex
 * scanning, no AST library.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { LanguageId } from './language-id.ts';
import { detectLanguageProfiles, type ILanguageProfile } from './language-detection.ts';

export const POLYGLOT_DEPENDENCY_GRAPH_SCHEMA = 'sharkcraft.polyglot-dependency-graph/v1';

export interface IPolyglotImportEdge {
  from: string;
  to: string;
  language: LanguageId;
  external?: boolean;
}

export interface IPolyglotLanguageDeps {
  language: LanguageId;
  filesScanned: number;
  imports: readonly IPolyglotImportEdge[];
  internalEdges: readonly IPolyglotImportEdge[];
  externalDeps: readonly string[];
  unresolvedDeps: readonly string[];
  confidence: 'low' | 'medium' | 'high';
  limitations: readonly string[];
}

export interface IPolyglotDependencyGraph {
  schema: typeof POLYGLOT_DEPENDENCY_GRAPH_SCHEMA;
  generatedAt: string;
  projectRoot: string;
  perLanguage: readonly IPolyglotLanguageDeps[];
  notes: readonly string[];
}

function tryRead(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function rel(root: string, abs: string): string {
  return nodePath.relative(root, abs).replace(/\\/g, '/');
}

function scanJava(root: string, files: readonly string[]): IPolyglotLanguageDeps {
  const imports: IPolyglotImportEdge[] = [];
  const externals = new Set<string>();
  const internalPackages = new Set<string>();
  let filesScanned = 0;
  // First pass: catalogue `package com.foo;` declarations so we can classify
  // `import com.foo.Bar;` as internal vs external.
  for (const file of files) {
    const body = tryRead(file);
    if (!body) continue;
    const pkg = /^\s*package\s+([a-zA-Z0-9_.]+)\s*;/m.exec(body);
    if (pkg) internalPackages.add(pkg[1]!);
  }
  for (const file of files) {
    const body = tryRead(file);
    if (!body) continue;
    filesScanned++;
    const r = rel(root, file);
    const importRe = /^\s*import\s+(?:static\s+)?([a-zA-Z0-9_.*]+)\s*;/gm;
    for (const m of body.matchAll(importRe)) {
      const target = m[1]!.replace(/\.\*$/, '');
      const isInternal = [...internalPackages].some((p) => target === p || target.startsWith(p + '.'));
      imports.push({ from: r, to: target, language: LanguageId.Java, external: !isInternal });
      if (!isInternal) externals.add(target);
    }
  }
  return {
    language: LanguageId.Java,
    filesScanned,
    imports,
    internalEdges: imports.filter((e) => !e.external),
    externalDeps: [...externals].sort(),
    unresolvedDeps: [],
    confidence: filesScanned > 0 ? 'medium' : 'low',
    limitations: ['Java imports parsed by regex; star imports collapsed.'],
  };
}

function scanCSharp(root: string, files: readonly string[]): IPolyglotLanguageDeps {
  const imports: IPolyglotImportEdge[] = [];
  const externals = new Set<string>();
  const internalNamespaces = new Set<string>();
  let filesScanned = 0;
  for (const file of files) {
    const body = tryRead(file);
    if (!body) continue;
    // Both file-scoped `namespace X.Y;` and block `namespace X.Y { … }`.
    for (const m of body.matchAll(/^\s*namespace\s+([A-Za-z0-9_.]+)\s*[;{]/gm)) {
      internalNamespaces.add(m[1]!);
    }
  }
  for (const file of files) {
    const body = tryRead(file);
    if (!body) continue;
    filesScanned++;
    const r = rel(root, file);
    for (const m of body.matchAll(/^\s*using\s+(?:static\s+)?([A-Za-z0-9_.]+)\s*;/gm)) {
      const target = m[1]!;
      const isInternal = [...internalNamespaces].some((ns) => target === ns || target.startsWith(ns + '.'));
      imports.push({ from: r, to: target, language: LanguageId.CSharp, external: !isInternal });
      if (!isInternal) externals.add(target);
    }
  }
  return {
    language: LanguageId.CSharp,
    filesScanned,
    imports,
    internalEdges: imports.filter((e) => !e.external),
    externalDeps: [...externals].sort(),
    unresolvedDeps: [],
    confidence: filesScanned > 0 ? 'medium' : 'low',
    limitations: ['C# usings parsed by regex; alias usings (`using X = Y;`) not categorised.'],
  };
}

function scanPython(root: string, files: readonly string[]): IPolyglotLanguageDeps {
  const imports: IPolyglotImportEdge[] = [];
  const externals = new Set<string>();
  const unresolved = new Set<string>();
  let filesScanned = 0;
  // Internal modules are derived from the files themselves: every directory
  // chain rooted at a known src/ or top-level is considered local.
  const localModules = new Set<string>();
  for (const f of files) {
    const r = rel(root, f);
    const parts = r.split('/');
    if (parts.length > 0) localModules.add(parts[0]!);
    if (r.startsWith('src/') && parts.length > 1) localModules.add(parts[1]!);
  }
  for (const file of files) {
    const body = tryRead(file);
    if (!body) continue;
    filesScanned++;
    const r = rel(root, file);
    for (const m of body.matchAll(/^\s*(?:import\s+([A-Za-z_][A-Za-z0-9_.]*)(?:\s+as\s+\w+)?|from\s+(\.?\.?[A-Za-z_][A-Za-z0-9_.]*)\s+import\s+[^\n]+)/gm)) {
      const target = (m[1] ?? m[2] ?? '').trim();
      if (!target) continue;
      const top = target.replace(/^\.+/, '').split('.')[0]!;
      const isInternal = target.startsWith('.') || localModules.has(top);
      imports.push({ from: r, to: target, language: LanguageId.Python, external: !isInternal });
      if (!isInternal) externals.add(top);
      else if (target.startsWith('.') && !target.match(/^\.+[A-Za-z_]/)) unresolved.add(target);
    }
  }
  return {
    language: LanguageId.Python,
    filesScanned,
    imports,
    internalEdges: imports.filter((e) => !e.external),
    externalDeps: [...externals].sort(),
    unresolvedDeps: [...unresolved].sort(),
    confidence: filesScanned > 0 ? 'medium' : 'low',
    limitations: ['Python imports parsed by regex; conditional / runtime imports may be missed.'],
  };
}

function scanGo(root: string, files: readonly string[]): IPolyglotLanguageDeps {
  const imports: IPolyglotImportEdge[] = [];
  const externals = new Set<string>();
  let filesScanned = 0;
  // Detect the module name from go.mod for internal classification.
  let modulePrefix = '';
  const goMod = tryRead(nodePath.join(root, 'go.mod'));
  if (goMod) {
    const m = /^module\s+([^\s]+)/m.exec(goMod);
    if (m) modulePrefix = m[1]!;
  }
  for (const file of files) {
    const body = tryRead(file);
    if (!body) continue;
    filesScanned++;
    const r = rel(root, file);
    // Single-line `import "x"`
    for (const m of body.matchAll(/^\s*import\s+"([^"]+)"/gm)) {
      const target = m[1]!;
      const isInternal = modulePrefix.length > 0 && (target === modulePrefix || target.startsWith(modulePrefix + '/'));
      imports.push({ from: r, to: target, language: LanguageId.Go, external: !isInternal });
      if (!isInternal) externals.add(target);
    }
    // Block import (foo "x" or alias)
    const blockMatch = body.match(/import\s*\(([\s\S]*?)\)/m);
    if (blockMatch) {
      for (const line of blockMatch[1]!.split('\n')) {
        const lm = /\s*(?:[A-Za-z_]\w*\s+)?"([^"]+)"/.exec(line);
        if (!lm) continue;
        const target = lm[1]!;
        const isInternal = modulePrefix.length > 0 && (target === modulePrefix || target.startsWith(modulePrefix + '/'));
        imports.push({ from: r, to: target, language: LanguageId.Go, external: !isInternal });
        if (!isInternal) externals.add(target);
      }
    }
  }
  return {
    language: LanguageId.Go,
    filesScanned,
    imports,
    internalEdges: imports.filter((e) => !e.external),
    externalDeps: [...externals].sort(),
    unresolvedDeps: [],
    confidence: filesScanned > 0 ? 'high' : 'low',
    limitations: modulePrefix ? [] : ['No `module` directive in go.mod — internal classification may be incorrect.'],
  };
}

function scanRust(root: string, files: readonly string[]): IPolyglotLanguageDeps {
  const imports: IPolyglotImportEdge[] = [];
  const externals = new Set<string>();
  let filesScanned = 0;
  // First crate name from Cargo.toml.
  const cargo = tryRead(nodePath.join(root, 'Cargo.toml'));
  let crateName = '';
  if (cargo) {
    const m = /name\s*=\s*"([^"]+)"/.exec(cargo);
    if (m) crateName = m[1]!.replace(/-/g, '_');
  }
  for (const file of files) {
    const body = tryRead(file);
    if (!body) continue;
    filesScanned++;
    const r = rel(root, file);
    for (const m of body.matchAll(/^\s*use\s+([A-Za-z_][A-Za-z0-9_:]*)/gm)) {
      const target = m[1]!;
      const head = target.split('::')[0]!;
      const isInternal = head === 'crate' || head === 'super' || head === 'self' || head === crateName;
      imports.push({ from: r, to: target, language: LanguageId.Rust, external: !isInternal });
      if (!isInternal) externals.add(head);
    }
    for (const m of body.matchAll(/^\s*mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/gm)) {
      imports.push({ from: r, to:'mod::' + m[1]!, language: LanguageId.Rust, external: false });
    }
  }
  return {
    language: LanguageId.Rust,
    filesScanned,
    imports,
    internalEdges: imports.filter((e) => !e.external),
    externalDeps: [...externals].sort(),
    unresolvedDeps: [],
    confidence: filesScanned > 0 ? 'medium' : 'low',
    limitations: ['Rust `use` parsed by regex; grouped `use foo::{a, b};` only records `foo` head.'],
  };
}

const LANG_EXTENSIONS: Record<string, readonly string[]> = {
  [LanguageId.Java]: ['.java'],
  [LanguageId.CSharp]: ['.cs'],
  [LanguageId.Python]: ['.py'],
  [LanguageId.Go]: ['.go'],
  [LanguageId.Rust]: ['.rs'],
};

function collectFilesByExtension(root: string, exts: readonly string[]): string[] {
  // Walk the tree limited by the same ignored-dir rules.
  const out: string[] = [];
  const ignored = new Set(['node_modules', '.git', 'target', 'build', 'bin', 'obj', 'dist', 'out', '__pycache__', '.venv', 'venv', 'vendor']);
  const stack: string[] = [root];
  while (stack.length > 0 && out.length < 25000) {
    const cur = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (ignored.has(e)) continue;
      const abs = nodePath.join(cur, e);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (st.isFile() && exts.some((x) => abs.endsWith(x))) out.push(abs);
    }
  }
  return out;
}

export function scanPolyglotDependencies(
  projectRoot: string,
  options: { languages?: readonly LanguageId[] } = {},
): IPolyglotDependencyGraph {
  const cached = detectLanguageProfiles(projectRoot);
  const wanted = options.languages && options.languages.length > 0
    ? new Set<LanguageId>(options.languages)
    : new Set<LanguageId>([LanguageId.Java, LanguageId.CSharp, LanguageId.Python, LanguageId.Go, LanguageId.Rust]);

  const perLanguage: IPolyglotLanguageDeps[] = [];
  void cached;

  if (wanted.has(LanguageId.Java)) {
    const files = collectFilesByExtension(projectRoot, LANG_EXTENSIONS[LanguageId.Java]!);
    if (files.length > 0) perLanguage.push(scanJava(projectRoot, files));
  }
  if (wanted.has(LanguageId.CSharp)) {
    const files = collectFilesByExtension(projectRoot, LANG_EXTENSIONS[LanguageId.CSharp]!);
    if (files.length > 0) perLanguage.push(scanCSharp(projectRoot, files));
  }
  if (wanted.has(LanguageId.Python)) {
    const files = collectFilesByExtension(projectRoot, LANG_EXTENSIONS[LanguageId.Python]!);
    if (files.length > 0) perLanguage.push(scanPython(projectRoot, files));
  }
  if (wanted.has(LanguageId.Go)) {
    const files = collectFilesByExtension(projectRoot, LANG_EXTENSIONS[LanguageId.Go]!);
    if (files.length > 0) perLanguage.push(scanGo(projectRoot, files));
  }
  if (wanted.has(LanguageId.Rust)) {
    const files = collectFilesByExtension(projectRoot, LANG_EXTENSIONS[LanguageId.Rust]!);
    if (files.length > 0) perLanguage.push(scanRust(projectRoot, files));
  }

  return {
    schema: POLYGLOT_DEPENDENCY_GRAPH_SCHEMA,
    generatedAt: new Date().toISOString(),
    projectRoot,
    perLanguage,
    notes: ['Regex-based scan — no compiler / AST integration.'],
  };
}

export function renderPolyglotDependenciesText(g: IPolyglotDependencyGraph): string {
  let out = `=== Polyglot dependencies ===\n`;
  out += `  project root  ${g.projectRoot}\n`;
  out += `  languages     ${g.perLanguage.map((p) => p.language).join(', ') || '(none)'}\n\n`;
  for (const p of g.perLanguage) {
    out += `[${p.language}]  files=${p.filesScanned}  imports=${p.imports.length}  internal=${p.internalEdges.length}  external=${p.externalDeps.length}  confidence=${p.confidence}\n`;
    if (p.externalDeps.length) out += `  external deps: ${p.externalDeps.slice(0, 12).join(', ')}${p.externalDeps.length > 12 ? ', …' : ''}\n`;
    if (p.limitations.length) for (const l of p.limitations) out += `  note: ${l}\n`;
    out += `\n`;
  }
  return out;
}

export function _exportLangExtensionsForTests(): typeof LANG_EXTENSIONS {
  return LANG_EXTENSIONS;
}
