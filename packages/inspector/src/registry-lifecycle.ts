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
  /** Total candidate files found before the cap (>= filesScanned). */
  totalFiles: number;
  /** True when the scan hit the file cap and did NOT see every candidate file. */
  truncated: boolean;
  /** True when the scan hit its wall-clock budget and flushed partial results. */
  timedOut: boolean;
  /** True when the scan was scoped to the changed file set (`--changed-only`). */
  changedOnly: boolean;
  /** Project-relative subtree the scan was scoped to, when `--scope` was used. */
  scope?: string;
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

/**
 * Default directories the walk skips — build artefacts + non-source trees that
 * inflate the scan without owning runtime lifecycle. This is the DEFAULT only;
 * a repo that genuinely registers code under `tools/`, a non-standard root, etc.
 * can override the set via config (`registryLifecycle.skipDirs`) / the engine's
 * `skipDirs` input, so a hardcoded exclusion never silently blinds the check.
 */
export const DEFAULT_REGISTRY_LIFECYCLE_SKIP_DIRS: readonly string[] = Object.freeze([
  'node_modules',
  'dist',
  '.git',
  '.sharkcraft',
  'coverage',
  '.nx',
  'build',
  'out',
  'examples',
  'e2e',
  'fixtures',
  '__fixtures__',
  'scripts',
  'tools',
  '.agents',
  '.github',
]);
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx']);
/** Skip pathological single files — a 200 KB command file has no registry to pair. */
const MAX_SCAN_FILE_BYTES = 256 * 1024;
/** Hard wall-clock budget so the scan fails loud (partial flush) instead of hanging. */
const DEFAULT_BUDGET_MS = 15_000;

function isGeneratedFile(file: string, content: string): boolean {
  if (file.endsWith('.d.ts')) return true;
  if (/\.generated\.(ts|tsx)$/.test(file)) return true;
  if (/^\/\/ @generated\b/m.test(content)) return true;
  return false;
}

function walk(dir: string, projectRoot: string, out: string[], skipDirs: ReadonlySet<string>): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (skipDirs.has(e.name)) continue;
    if (e.name.startsWith('.') && e.name !== '.sharkcraft') {
      // skip hidden dotfiles
      if (e.name !== '.') continue;
    }
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      walk(abs, projectRoot, out, skipDirs);
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
  // NOTE: every modifier carries its OWN single-line (`[ \t]`) trailing space
  // and the leading whitespace class is single-line too — no two newline-
  // spanning (`\s`) quantifiers sit adjacent. The old form had `[\t ]*` then
  // `\s*` then `(?:static\s+)?` then `(?:async\s+)?` all touching, so from each
  // `\n` anchor the engine re-partitioned the whole whitespace block looking for
  // `register`: O(block^2) catastrophic backtracking that dominated the scan
  // (~90% of runtime on a stripped source full of blanked comment/string runs).
  // The only newline-spanning class is the final one, after the required `)`,
  // where it cannot backtrack against a neighbour. Match-equivalent to the old
  // pattern on real TS (modifiers always sit on the same line as `registerX(`).
  /(?:^|\n)[ \t]*(?:(?:public|private|protected)[ \t]+)?(?:static[ \t]+)?(?:async[ \t]+)?(register[A-Z]\w*)[ \t]*\([^;]*?\)[ \t\r\n]*[:{]/g,
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

/**
 * Precompute the byte offset of each line start, so an offset → line lookup is
 * O(log n) instead of the O(fileLen) `content.slice(0, i).split('\n')` done PER
 * MATCH (the original quadratic hotspot — a 57 KB file with 200 `register*`
 * tokens paid ~200 × 57 KB of slicing). Built once per file.
 */
function buildLineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

/** 1-based line number for a byte offset, via binary search over line starts. */
function lineAtOffset(lineStarts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStarts[mid]! <= offset) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans + 1;
}

function findRegistersInFile(content: string, lineStarts: readonly number[]): IRegisterMatch[] {
  const out: IRegisterMatch[] = [];
  const seen = new Set<string>();
  for (const re of REGISTER_PATTERNS) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(content)) !== null) {
      const name = m[1]!;
      if (seen.has(`${name}@${m.index}`)) continue;
      seen.add(`${name}@${m.index}`);
      out.push({ name, line: lineAtOffset(lineStarts, m.index) });
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

function findRemoverInContent(
  content: string,
  candidates: ReadonlyArray<string>,
  lineStarts: readonly number[],
): {
  name: string;
  line: number;
} | null {
  for (const name of candidates) {
    const re = new RegExp(
      `(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(|\\b${name}\\s*=\\s*\\(|(?:public|private|protected)?\\s*(?:async\\s+)?${name}\\s*\\(`,
    );
    const m = content.match(re);
    if (m && typeof m.index === 'number') {
      return { name, line: lineAtOffset(lineStarts, m.index) };
    }
  }
  return null;
}

export function buildRegistryLifecycleReport(input: {
  projectRoot: string;
  limit?: number;
  /** Project-relative subtree to scope the scan to (sub-second on a subtree). */
  scope?: string;
  /**
   * Changed-only scope: scan JUST these files (project-relative or absolute)
   * instead of walking the tree. Non-`.ts/.tsx` entries are ignored. When set,
   * an empty relevant set is reported as a loud skip, never a green pass.
   */
  files?: readonly string[];
  /** Hard wall-clock budget (ms). The scan flushes partial results on timeout. */
  budgetMs?: number;
  /**
   * Directory names the walk skips. Overrides {@link DEFAULT_REGISTRY_LIFECYCLE_SKIP_DIRS}
   * so a repo that registers code under `tools/` / a non-standard root isn't
   * silently blinded by a baked-in exclusion. Ignored on the changed-only path.
   */
  skipDirs?: readonly string[];
}): IRegistryLifecycleReport {
  const { projectRoot } = input;
  const scope = input.scope && input.scope.length > 0 ? input.scope : undefined;
  const changedOnly = input.files !== undefined;
  const deadline = Date.now() + (input.budgetMs ?? DEFAULT_BUDGET_MS);
  const limit = input.limit ?? 2000;
  const skipDirs = new Set(input.skipDirs ?? DEFAULT_REGISTRY_LIFECYCLE_SKIP_DIRS);

  // Candidate files: either the explicit changed set (bypassing the walk) or a
  // bounded tree walk. The changed set resolves relative paths under the root
  // and keeps only scannable extensions.
  let files: string[];
  if (input.files !== undefined) {
    files = input.files
      .map((f) => (f.startsWith('/') ? f : join(projectRoot, f)))
      .filter((f) => SCAN_EXTENSIONS.has(extname(f)));
  } else {
    const walkRoot = scope ? join(projectRoot, scope) : projectRoot;
    files = [];
    walk(walkRoot, projectRoot, files, skipDirs);
  }
  const scanFiles = files.slice(0, limit);
  const matchedPairs: IRegistryPair[] = [];
  const missingRemovers: IRegistryMissingRemover[] = [];
  const oneShotBootstrap: IRegistryIgnored[] = [];
  const ignored: IRegistryIgnored[] = [];
  let registersFound = 0;
  let timedOut = false;
  let filesScanned = 0;
  for (const file of scanFiles) {
    // Hard wall-clock budget checked between files — the scan is synchronous, so
    // a Date.now() deadline is the only interruption point. Flush partial results.
    if (Date.now() > deadline) {
      timedOut = true;
      break;
    }
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // Per-file size cap: a huge file (a big command/aggregate module) is a
    // catastrophic-backtracking / quadratic hazard and never holds a registry
    // that owes a remover. Skip it rather than let one file wedge the scan.
    if (content.length > MAX_SCAN_FILE_BYTES) continue;
    if (isGeneratedFile(file, content)) continue;
    filesScanned += 1;
    // Scan declarations on code with comments/strings blanked out; keep the raw
    // content only for the comment-based @shrkcrft annotations.
    const code = stripCommentsAndLiterals(content);
    const lineStarts = buildLineStarts(code);
    const registers = findRegistersInFile(code, lineStarts);
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
      const remover = findRemoverInContent(code, candidates, lineStarts);
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
    filesScanned,
    totalFiles: files.length,
    truncated: files.length > scanFiles.length || timedOut,
    timedOut,
    changedOnly,
    ...(scope ? { scope } : {}),
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
  if (report.scope) lines.push(`  scope             ${report.scope}`);
  if (report.changedOnly) lines.push('  scope             changed-only');
  // Loud skip: a changed diff that touches no scannable file was NOT verified —
  // never let "scanned nothing" read as a clean pass.
  if (report.changedOnly && report.filesScanned === 0) {
    lines.push('');
    lines.push('  ! 0 files in the changed scope — lifecycle NOT verified (this is not a pass).');
    return lines.join('\n') + '\n';
  }
  if (report.timedOut) {
    lines.push(
      `  ! wall-clock budget hit — scanned ${report.filesScanned}/${report.totalFiles} before flushing partial results (re-run with --scope <dir> to finish).`,
    );
  }
  lines.push(
    `  files scanned     ${report.filesScanned}` +
      (report.truncated && !report.timedOut
        ? ` ! capped (${report.totalFiles} candidates — re-run with --scope <dir> for the rest)`
        : ''),
  );
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
