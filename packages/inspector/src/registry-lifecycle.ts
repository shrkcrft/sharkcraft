/**
 * Registry lifecycle symmetry rule.
 *
 * Scans the workspace for `register*` APIs (functions or methods) and checks
 * that a matching `remove*` / `unregister*` / `clear*` exists in the same file,
 * with optional scope-aware naming (e.g. `registerXByScope` ↔ `removeXByScope`).
 *
 * Ignored: generated files (.generated.*, .d.ts), files containing
 * `@shrkcrft lifecycle-ignore <reason>`. Sites with `@shrkcrft lifecycle-managed-by <name>`
 * are reported under `ignored` with the managed-by reference.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

export interface IRegistryPair {
  registerName: string;
  removerName: string;
  file: string;
  registerLine: number;
  removerLine: number;
}

export interface IRegistryMissingRemover {
  registerName: string;
  expectedRemoverNames: ReadonlyArray<string>;
  file: string;
  line: number;
  suggestion: string;
}

export interface IRegistryIgnored {
  registerName: string;
  file: string;
  line: number;
  reason: string;
  managedBy?: string;
}

export interface IRegistryLifecycleReport {
  schema: 'sharkcraft.registry-lifecycle/v1';
  filesScanned: number;
  registersFound: number;
  matchedPairs: ReadonlyArray<IRegistryPair>;
  missingRemovers: ReadonlyArray<IRegistryMissingRemover>;
  /**
   * `register*` declarations in a file with NO teardown-shaped API — treated as
   * one-shot / bootstrap registrations that legitimately need no remover. Kept
   * out of `missingRemovers` so the check isn't a wall of false positives.
   */
  oneShotBootstrap: ReadonlyArray<IRegistryIgnored>;
  ignored: ReadonlyArray<IRegistryIgnored>;
  recommendations: ReadonlyArray<string>;
}

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.sharkcraft',
  'coverage',
  '.nx',
  'build',
  'out',
]);
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx']);

function isGeneratedFile(file: string, content: string): boolean {
  if (file.endsWith('.d.ts')) return true;
  if (/\.generated\.(ts|tsx)$/.test(file)) return true;
  if (/^\/\/ @generated\b/m.test(content)) return true;
  return false;
}

function walk(dir: string, projectRoot: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    if (e.name.startsWith('.') && e.name !== '.sharkcraft') {
      // skip hidden dotfiles
      if (e.name !== '.') continue;
    }
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      walk(abs, projectRoot, out);
    } else if (e.isFile() && SCAN_EXTENSIONS.has(extname(e.name))) {
      out.push(abs);
    }
  }
}

interface IRegisterMatch {
  name: string;
  line: number;
}

const REGISTER_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  // export function registerX(
  /(?:export\s+)?(?:async\s+)?function\s+(register[A-Z]\w*)\s*\(/g,
  // class method DECLARATION: requires a body `{` or return-type `:` after the
  // params, which a bare call site (`registry.registerX(...)`) never has.
  /(?:^|\n)[\t ]*(?:public|private|protected)?\s*(?:static\s+)?(?:async\s+)?(register[A-Z]\w*)\s*\([^;]*?\)\s*[:{]/g,
  // assigned arrow / function expression: `registerX = (…) =>` / `registerX = function`
  /\b(register[A-Z]\w*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]*)?=>)/g,
]);

// Accumulation of removable per-entry state — a registry that ADDS entries one
// at a time plausibly needs a way to remove them.
const ACCUMULATION_RE = /\.(?:set|add|push)\s*\(|\[[^\]]+\]\s*=[^=]/;
// A teardown-shaped API somewhere in the file — evidence the file is in the
// business of removing things, so a missing per-register remover is suspicious.
const TEARDOWN_RE = /\b(?:remove|unregister|clear|dispose|unsubscribe)\w*\s*\(|\boff\s*\(/i;

/**
 * Blank out comments and string / template-literal bodies (preserving newlines
 * so line numbers stay accurate) before scanning for `register*` declarations.
 * Deterministic char-scan — no TS parser, consistent with this module's no-AST
 * posture. Stops `register*` mentions inside comments / strings / docs from
 * being counted as code.
 */
function stripCommentsAndLiterals(content: string): string {
  const out: string[] = [];
  const n = content.length;
  type State = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl';
  let state: State = 'code';
  const blank = (ch: string): string => (ch === '\n' ? '\n' : ' ');
  let i = 0;
  while (i < n) {
    const ch = content[i]!;
    const next = content[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') { state = 'line'; out.push('  '); i += 2; continue; }
      if (ch === '/' && next === '*') { state = 'block'; out.push('  '); i += 2; continue; }
      if (ch === "'") { state = 'sq'; out.push(' '); i += 1; continue; }
      if (ch === '"') { state = 'dq'; out.push(' '); i += 1; continue; }
      if (ch === '`') { state = 'tpl'; out.push(' '); i += 1; continue; }
      out.push(ch); i += 1; continue;
    }
    if (state === 'line') {
      if (ch === '\n') { state = 'code'; out.push('\n'); i += 1; continue; }
      out.push(blank(ch)); i += 1; continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') { state = 'code'; out.push('  '); i += 2; continue; }
      out.push(blank(ch)); i += 1; continue;
    }
    // string / template literal body
    const quote = state === 'sq' ? "'" : state === 'dq' ? '"' : '`';
    if (ch === '\\') {
      out.push(' ');
      out.push(next === undefined ? '' : blank(next));
      i += 2;
      continue;
    }
    if (ch === quote) { state = 'code'; out.push(' '); i += 1; continue; }
    out.push(blank(ch)); i += 1; continue;
  }
  return out.join('');
}

function findRegistersInFile(content: string): IRegisterMatch[] {
  const out: IRegisterMatch[] = [];
  const seen = new Set<string>();
  for (const re of REGISTER_PATTERNS) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(content)) !== null) {
      const name = m[1]!;
      if (seen.has(`${name}@${m.index}`)) continue;
      seen.add(`${name}@${m.index}`);
      const line = content.slice(0, m.index).split('\n').length;
      out.push({ name, line });
    }
  }
  return out;
}

function findIgnoreAnnotations(
  content: string,
  registerName: string,
): { ignore: boolean; managedBy?: string; reason?: string } {
  const ignoreRe = new RegExp(
    `@shrkcrft\\s+lifecycle-ignore(?:\\s+([^\\n]+))?[\\s\\S]{0,200}?\\b${registerName}\\b`,
    'm',
  );
  const managedRe = new RegExp(
    `@shrkcrft\\s+lifecycle-managed-by\\s+([\\w.-]+)[\\s\\S]{0,200}?\\b${registerName}\\b`,
    'm',
  );
  const ignoreMatch = content.match(ignoreRe);
  if (ignoreMatch) {
    return { ignore: true, reason: ignoreMatch[1]?.trim() ?? 'no reason given' };
  }
  const managedMatch = content.match(managedRe);
  if (managedMatch) {
    return { ignore: true, managedBy: managedMatch[1], reason: 'managed-by directive' };
  }
  return { ignore: false };
}

function expectedRemoverNames(registerName: string): string[] {
  // registerX → removeX / unregisterX / clearX / disposeX / unsubscribeX / Xoff
  // registerXByScope → removeXByScope / … (stem carries the scope suffix)
  const stem = registerName.slice('register'.length);
  return [
    `remove${stem}`,
    `unregister${stem}`,
    `clear${stem}`,
    `dispose${stem}`,
    `unsubscribe${stem}`,
    `${stem}Off`,
  ];
}

function findRemoverInContent(content: string, candidates: ReadonlyArray<string>): {
  name: string;
  line: number;
} | null {
  for (const name of candidates) {
    const re = new RegExp(
      `(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(|\\b${name}\\s*=\\s*\\(|(?:public|private|protected)?\\s*(?:async\\s+)?${name}\\s*\\(`,
    );
    const m = content.match(re);
    if (m && typeof m.index === 'number') {
      const line = content.slice(0, m.index).split('\n').length;
      return { name, line };
    }
  }
  return null;
}

export function buildRegistryLifecycleReport(input: {
  projectRoot: string;
  limit?: number;
}): IRegistryLifecycleReport {
  const { projectRoot } = input;
  const files: string[] = [];
  walk(projectRoot, projectRoot, files);
  const limit = input.limit ?? 2000;
  const scanFiles = files.slice(0, limit);
  const matchedPairs: IRegistryPair[] = [];
  const missingRemovers: IRegistryMissingRemover[] = [];
  const oneShotBootstrap: IRegistryIgnored[] = [];
  const ignored: IRegistryIgnored[] = [];
  let registersFound = 0;
  for (const file of scanFiles) {
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (isGeneratedFile(file, content)) continue;
    // Scan declarations on code with comments/strings blanked out; keep the raw
    // content only for the comment-based @shrkcrft annotations.
    const code = stripCommentsAndLiterals(content);
    const registers = findRegistersInFile(code);
    // Per-file lifecycle evidence: only a file that BOTH accumulates removable
    // state AND has a teardown-shaped API plausibly owes a per-register remover.
    const hasAccumulation = ACCUMULATION_RE.test(code);
    const hasTeardown = TEARDOWN_RE.test(code);
    const ownsLifecycle = hasAccumulation && hasTeardown;
    for (const reg of registers) {
      registersFound += 1;
      const ann = findIgnoreAnnotations(content, reg.name);
      if (ann.ignore) {
        ignored.push({
          registerName: reg.name,
          file: relative(projectRoot, file),
          line: reg.line,
          reason: ann.reason ?? 'ignored',
          ...(ann.managedBy ? { managedBy: ann.managedBy } : {}),
        });
        continue;
      }
      const candidates = expectedRemoverNames(reg.name);
      const remover = findRemoverInContent(code, candidates);
      if (remover) {
        matchedPairs.push({
          registerName: reg.name,
          removerName: remover.name,
          file: relative(projectRoot, file),
          registerLine: reg.line,
          removerLine: remover.line,
        });
      } else if (ownsLifecycle) {
        missingRemovers.push({
          registerName: reg.name,
          expectedRemoverNames: candidates,
          file: relative(projectRoot, file),
          line: reg.line,
          suggestion: `Add ${candidates[0]}() / ${candidates[1]}() / ${candidates[2]}() — or annotate with \`@shrkcrft lifecycle-ignore <reason>\` / \`@shrkcrft lifecycle-managed-by <name>\` if cleanup is owned elsewhere.`,
        });
      } else {
        // No teardown-shaped API in the file → one-shot / bootstrap registration.
        oneShotBootstrap.push({
          registerName: reg.name,
          file: relative(projectRoot, file),
          line: reg.line,
          reason: 'no teardown-shaped API in file — treated as one-shot bootstrap',
        });
      }
    }
  }
  const recommendations: string[] = [];
  if (missingRemovers.length > 0) {
    recommendations.push(
      `Run \`shrk check registry-lifecycle --json\` and add the matching remover(s), or document why not via a \`@shrkcrft lifecycle-ignore\` / \`@shrkcrft lifecycle-managed-by\` annotation.`,
    );
  }
  return {
    schema: 'sharkcraft.registry-lifecycle/v1',
    filesScanned: scanFiles.length,
    registersFound,
    matchedPairs,
    missingRemovers,
    oneShotBootstrap,
    ignored,
    recommendations,
  };
}

export function renderRegistryLifecycleReportText(report: IRegistryLifecycleReport): string {
  const lines: string[] = [];
  lines.push('=== Registry lifecycle ===');
  lines.push(`  files scanned     ${report.filesScanned}`);
  lines.push(`  registers found   ${report.registersFound}`);
  lines.push(`  matched pairs     ${report.matchedPairs.length}`);
  lines.push(`  missing removers  ${report.missingRemovers.length}`);
  lines.push(`  one-shot bootstrap ${report.oneShotBootstrap.length}`);
  lines.push(`  ignored           ${report.ignored.length}`);
  lines.push('');
  if (report.missingRemovers.length > 0) {
    lines.push('Missing removers:');
    for (const m of report.missingRemovers.slice(0, 50)) {
      lines.push(`  ${m.file}:${m.line}  ${m.registerName}`);
      lines.push(`      ↳ ${m.suggestion}`);
    }
  }
  if (report.ignored.length > 0) {
    lines.push('');
    lines.push('Ignored:');
    for (const i of report.ignored.slice(0, 20)) {
      lines.push(`  ${i.file}:${i.line}  ${i.registerName}  (${i.reason}${i.managedBy ? `; managed-by ${i.managedBy}` : ''})`);
    }
  }
  if (report.recommendations.length > 0) {
    lines.push('');
    lines.push('Recommendations:');
    for (const r of report.recommendations) lines.push(`  • ${r}`);
  }
  return lines.join('\n') + '\n';
}
