/**
 * Import hygiene checker.
 *
 * Detects bad import patterns that hide module dependencies or invent
 * cycles where none exist:
 *
 *   - inline-type-import:  `import('./x').Type` used as a type annotation.
 *   - runtime-require:     `require('./x')` inside a normal TS/TSX source.
 *   - dynamic-import:      `await import('./x')` or `import('./x')` used
 *                          as a runtime escape hatch in normal engine
 *                          source. Allowlisted entries (e.g. legitimate
 *                          lazy-load boundaries between CLI subcommand
 *                          modules) opt out via
 *                          `sharkcraft/import-hygiene.allowlist.json`.
 *
 * Read-only: scans source files; never writes.
 *
 * Schema: sharkcraft.import-hygiene/v1
 */
import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs';
import * as nodePath from 'node:path';

export const IMPORT_HYGIENE_SCHEMA = 'sharkcraft.import-hygiene/v1';

export enum ImportHygieneFindingKind {
  InlineTypeImport = 'inline-type-import',
  RuntimeRequire = 'runtime-require',
  DynamicImport = 'dynamic-import',
}

export type ImportHygieneSeverity = 'info' | 'warning' | 'error';

export interface IImportHygieneFinding {
  readonly file: string;
  readonly line: number;
  readonly column?: number;
  readonly kind: ImportHygieneFindingKind;
  readonly severity: ImportHygieneSeverity;
  readonly snippet: string;
  readonly suggestedFix: string;
  readonly allowlisted: boolean;
  readonly reason?: string;
}

export interface IImportHygieneReport {
  readonly schema: typeof IMPORT_HYGIENE_SCHEMA;
  readonly generatedAt: string;
  readonly projectRoot: string;
  readonly findings: readonly IImportHygieneFinding[];
  readonly counts: Readonly<Record<string, number>>;
  readonly verdict: 'ok' | 'warnings' | 'errors';
  readonly nextCommand: string;
}

export interface IImportHygieneOptions {
  /** Restrict scan to a set of relative file paths (e.g. changed files). */
  readonly files?: readonly string[];
  /** Roots to scan; defaults to `packages/*\/src`. */
  readonly roots?: readonly string[];
  /** Skip allowlist loading; useful for tests. */
  readonly skipAllowlist?: boolean;
  /** Path to the allowlist JSON; defaults to `sharkcraft/import-hygiene.allowlist.json`. */
  readonly allowlistFile?: string;
  /**
   * Strict mode: treat allowlist entries with TODO-shaped reasons as
   * un-allowlisted. The finding then keeps its original severity instead of
   * being downgraded to info.
   */
  readonly strictAllowlistReasons?: boolean;
}

/**
 * Sentinel value used by the draft-allowlist generator for the
 * `reason` field. A human is expected to replace this with a real
 * justification before the entry is allowed to suppress a finding.
 */
export const ALLOWLIST_TODO_REASON_PREFIX = 'TODO:';

export function isTodoReason(reason: string | undefined | null): boolean {
  if (!reason) return true;
  const trimmed = reason.trim();
  if (trimmed.length === 0) return true;
  return trimmed.toUpperCase().startsWith('TODO');
}

export interface IAllowlistEntry {
  /** Relative file path. */
  readonly path: string;
  /** Optional: restrict to specific finding kind. */
  readonly kind?: ImportHygieneFindingKind;
  /** Free-form reason — required. */
  readonly reason: string;
  /** Optional ISO date after which this allowlist entry should be re-evaluated. */
  readonly expiresAt?: string;
}

const INLINE_TYPE_RE = /import\s*\(\s*['"][^'"]+['"]\s*\)\s*\./g;
const RUNTIME_REQUIRE_RE = /\brequire\s*\(\s*['"][^'"]+['"]\s*\)/g;
const DYNAMIC_IMPORT_RE = /(?:^|[^.\w])(?:await\s+)?import\s*\(\s*['"][^'"]+['"]\s*\)/g;
/** Type-only `typeof import('x')` is a TS type expression — never a runtime call. */
const TYPEOF_IMPORT_PREFIX = /typeof\s+$/;

function loadAllowlist(
  projectRoot: string,
  allowlistFile: string | undefined,
): readonly IAllowlistEntry[] {
  const path = allowlistFile
    ? (nodePath.isAbsolute(allowlistFile) ? allowlistFile : nodePath.join(projectRoot, allowlistFile))
    : nodePath.join(projectRoot, 'sharkcraft', 'import-hygiene.allowlist.json');
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf8');
    const json = JSON.parse(raw) as { allow?: readonly IAllowlistEntry[] };
    return json.allow ?? [];
  } catch {
    return [];
  }
}

function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as Dirent[];
    } catch {
      return;
    }
    for (const e of entries) {
      const name = String(e.name);
      if (name === 'node_modules' || name === 'dist' || name === '.sharkcraft') continue;
      const abs = nodePath.join(dir, name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) {
        if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(abs);
      }
    }
  }
  if (existsSync(root) && statSync(root).isDirectory()) walk(root);
  return out;
}

function scanFile(
  projectRoot: string,
  absFile: string,
  allowlist: readonly IAllowlistEntry[],
  strictReasons: boolean = false,
): IImportHygieneFinding[] {
  const findings: IImportHygieneFinding[] = [];
  let rawContent: string;
  try {
    rawContent = readFileSync(absFile, 'utf8');
  } catch {
    return findings;
  }
  const relFile = nodePath.relative(projectRoot, absFile);
  const lines = rawContent.split('\n');
  // Strip block and line comments before regex scanning so the checker
  // doesn't false-positive on docstrings / inline comments. Replace each
  // comment character with a space so line/column offsets stay accurate.
  const content = stripCommentsPreservingOffsets(rawContent);

  function lineColOf(idx: number): { line: number; column: number } {
    let line = 1;
    let lineStart = 0;
    for (let i = 0; i < idx; i++) {
      if (content[i] === '\n') {
        line += 1;
        lineStart = i + 1;
      }
    }
    return { line, column: idx - lineStart + 1 };
  }

  function isAllowed(kind: ImportHygieneFindingKind): IAllowlistEntry | undefined {
    return allowlist.find((a) => a.path === relFile && (a.kind === undefined || a.kind === kind));
  }

  function record(kind: ImportHygieneFindingKind, idx: number, severity: ImportHygieneSeverity): void {
    const allowed = isAllowed(kind);
    // In strict mode, allowlist entries with empty/TODO reasons do NOT
    // suppress findings. The entry is still surfaced (allowlisted=true,
    // reasonAccepted=false) so the operator can see what needs explaining.
    const reasonAccepted = allowed ? !isTodoReason(allowed.reason) : false;
    const effectiveAllowed = allowed && (!strictReasons || reasonAccepted);
    const { line, column } = lineColOf(idx);
    const snippet = (lines[line - 1] ?? '').trim().slice(0, 200);
    let suggestedFix = '';
    switch (kind) {
      case ImportHygieneFindingKind.InlineTypeImport:
        suggestedFix = `Replace with a top-level \`import type { ... } from './...';\` statement.`;
        break;
      case ImportHygieneFindingKind.RuntimeRequire:
        suggestedFix = `Replace with a top-level \`import { ... } from '...';\`. Node built-ins gain nothing from lazy require (they're already in memory); for real circular dependencies, extract the shared types into a neutral lower-level module instead of hiding the cycle.`;
        break;
      case ImportHygieneFindingKind.DynamicImport:
        suggestedFix = effectiveAllowed
          ? `Allowlisted as intentional lazy-load.`
          : allowed && !reasonAccepted
            ? `Allowlist entry has a TODO/empty reason — replace it with a real justification or remove the entry.`
            : `Convert to a top-level import; if this is intentional code-splitting, add an allowlist entry with a justification.`;
        break;
    }
    findings.push({
      file: relFile,
      line,
      column,
      kind,
      severity: effectiveAllowed ? 'info' : severity,
      snippet,
      suggestedFix,
      allowlisted: allowed !== undefined,
      ...(allowed?.reason ? { reason: allowed.reason } : {}),
    });
  }

  // 1) Inline type imports: `import('./...').Type`.
  INLINE_TYPE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_TYPE_RE.exec(content)) !== null) {
    record(ImportHygieneFindingKind.InlineTypeImport, m.index, 'error');
  }

  // 2) Runtime `require(...)`.
  //    Always `error`. Node built-ins (`node:fs`, `node:path`, …) are
  //    already resolved before any user code runs — there is no lazy-load
  //    benefit, and `require('node:fs') as typeof import('node:fs')` is
  //    a hack to satisfy strict TS where a top-level `import` would have
  //    typed the call for free. Cross-module requires are even worse —
  //    they hide dependencies from static analysis. Use the allowlist
  //    (with a documented `reason`) for the rare legitimate case.
  RUNTIME_REQUIRE_RE.lastIndex = 0;
  while ((m = RUNTIME_REQUIRE_RE.exec(content)) !== null) {
    record(ImportHygieneFindingKind.RuntimeRequire, m.index, 'error');
  }

  // 3) Dynamic `import(...)` / `await import(...)`.
  DYNAMIC_IMPORT_RE.lastIndex = 0;
  while ((m = DYNAMIC_IMPORT_RE.exec(content)) !== null) {
    // Skip the inline-type-import case (already recorded by INLINE_TYPE_RE).
    const after = content.slice(m.index + m[0].length, m.index + m[0].length + 2);
    if (after.startsWith('.')) continue;
    // Skip TS type-only `typeof import('x')` — it's a type expression.
    const before = content.slice(Math.max(0, m.index - 16), m.index + (m[0][0] === 'i' ? 0 : 1));
    if (TYPEOF_IMPORT_PREFIX.test(before)) continue;
    record(ImportHygieneFindingKind.DynamicImport, m.index, 'warning');
  }
  return findings;
}

/**
 * Replace comment characters with spaces so regex scans don't false-positive
 * on docstrings / inline comments. Strings are SKIPPED (their contents are
 * preserved verbatim) so we can still extract the module specifier from a
 * `require('x')` call after this pass. Line and column offsets stay accurate
 * because every replacement is character-for-character.
 */
function stripCommentsPreservingOffsets(source: string): string {
  const buf: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    // Block comment.
    if (ch === '/' && next === '*') {
      buf.push('  ');
      i += 2;
      while (i < source.length) {
        const c = source[i];
        const n = source[i + 1];
        if (c === '*' && n === '/') {
          buf.push('  ');
          i += 2;
          break;
        }
        buf.push(c === '\n' ? '\n' : ' ');
        i += 1;
      }
      continue;
    }
    // Line comment.
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        buf.push(' ');
        i += 1;
      }
      continue;
    }
    // String literal — preserve contents verbatim. We do walk through it
    // so that comment delimiters inside strings (e.g. `"//"` as data) don't
    // start a fake comment.
    if (ch === '"' || ch === '\'' || ch === '`') {
      const quote = ch;
      buf.push(ch);
      i += 1;
      while (i < source.length) {
        const c = source[i] ?? '';
        if (c === '\\' && i + 1 < source.length) {
          buf.push(c);
          buf.push(source[i + 1] ?? '');
          i += 2;
          continue;
        }
        buf.push(c);
        i += 1;
        if (c === quote) break;
      }
      continue;
    }
    buf.push(ch ?? '');
    i += 1;
  }
  return buf.join('');
}

function defaultRoots(projectRoot: string): string[] {
  const pkgsDir = nodePath.join(projectRoot, 'packages');
  if (!existsSync(pkgsDir)) return [projectRoot];
  const out: string[] = [];
  for (const name of readdirSync(pkgsDir)) {
    const src = nodePath.join(pkgsDir, name, 'src');
    if (existsSync(src) && statSync(src).isDirectory()) out.push(src);
  }
  return out;
}

export function buildImportHygieneReport(
  projectRoot: string,
  options: IImportHygieneOptions = {},
): IImportHygieneReport {
  const allowlist = options.skipAllowlist
    ? []
    : loadAllowlist(projectRoot, options.allowlistFile);
  const roots = options.roots ?? defaultRoots(projectRoot);
  let scanned: string[];
  if (options.files && options.files.length > 0) {
    scanned = options.files
      .map((f) => (nodePath.isAbsolute(f) ? f : nodePath.join(projectRoot, f)))
      .filter((f) => existsSync(f) && /\.(ts|tsx)$/.test(f) && !/\.d\.ts$/.test(f));
  } else {
    scanned = roots.flatMap(listSourceFiles).filter((f) => !/__tests__|\/__fixtures__/.test(f));
  }
  const findings: IImportHygieneFinding[] = [];
  const strictReasons = options.strictAllowlistReasons === true;
  for (const f of scanned)
    findings.push(...scanFile(projectRoot, f, allowlist, strictReasons));
  const counts: Record<string, number> = { total: findings.length };
  for (const f of findings) {
    counts[f.kind] = (counts[f.kind] ?? 0) + 1;
    counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  }
  const errorCount = counts['error'] ?? 0;
  const warnCount = counts['warning'] ?? 0;
  const verdict: 'ok' | 'warnings' | 'errors' =
    errorCount > 0 ? 'errors' : warnCount > 0 ? 'warnings' : 'ok';
  return {
    schema: IMPORT_HYGIENE_SCHEMA,
    generatedAt: new Date().toISOString(),
    projectRoot,
    findings,
    counts,
    verdict,
    nextCommand:
      verdict === 'errors'
        ? 'Replace inline imports and runtime requires with top-level ESM imports.'
        : verdict === 'warnings'
          ? 'Review dynamic imports; allowlist legitimate lazy-load boundaries with a reason.'
          : 'shrk check imports --changed-only',
  };
}

// ─── Draft allowlist generator ──────────────────────────────────────

export interface IImportHygieneAllowlistDraft {
  readonly schema: 'sharkcraft.import-hygiene-allowlist/v1';
  readonly comment: string;
  readonly allow: ReadonlyArray<IAllowlistEntry>;
}

export interface IEmitAllowlistOptions {
  /**
   * Restrict the emitted draft to a specific finding kind. Defaults to
   * `dynamic-import` — runtime requires and inline type imports require
   * deliberate justification per case and should never be batched.
   */
  readonly kind?: ImportHygieneFindingKind | 'all';
  /** Skip entries that already appear in the loaded allowlist. */
  readonly skipExisting?: boolean;
}

/**
 * Build a draft allowlist JSON from the current report. Each candidate
 * gets a `TODO:` reason placeholder so the operator MUST fill in real
 * justification before strict mode will accept it.
 *
 * Behaviour:
 *   - Only findings that are NOT already allowlisted are emitted (unless
 *     `skipExisting=false`).
 *   - For `dynamic-import`, entries are batched by path so a single CLI
 *     boundary file collapses to one entry instead of N.
 *   - `runtime-require` and `inline-type-import` are NOT included by default
 *     and must be opted-in via `kind=all` or the specific kind — those
 *     patterns require per-case justification.
 */
export function emitImportHygieneAllowlistDraft(
  report: IImportHygieneReport,
  options: IEmitAllowlistOptions = {},
): IImportHygieneAllowlistDraft {
  const allowKind = options.kind ?? ImportHygieneFindingKind.DynamicImport;
  const wantKind = (k: ImportHygieneFindingKind): boolean =>
    allowKind === 'all' || allowKind === k;
  // Group: path|kind → reason placeholder.
  const seen = new Map<string, IAllowlistEntry>();
  for (const f of report.findings) {
    if (!wantKind(f.kind)) continue;
    if (options.skipExisting !== false && f.allowlisted) continue;
    const key = `${f.file}|${f.kind}`;
    if (seen.has(key)) continue;
    const placeholder = `${ALLOWLIST_TODO_REASON_PREFIX} explain why this ${f.kind} is intentional (added by shrk check imports --emit-allowlist)`;
    seen.set(key, { path: f.file, kind: f.kind, reason: placeholder });
  }
  // Sort deterministically.
  const entries = [...seen.values()].sort((a, b) => {
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return (a.kind ?? '').localeCompare(b.kind ?? '');
  });
  return {
    schema: 'sharkcraft.import-hygiene-allowlist/v1',
    comment:
      'Allowlist for legitimate dynamic imports. Each entry must carry a non-TODO reason. The checker downgrades these from warning to info; strict mode (--fail-on-unexplained-allowlist) rejects entries whose reason is still a TODO placeholder.',
    allow: entries,
  };
}

export function renderImportHygieneText(report: IImportHygieneReport): string {
  const lines: string[] = [];
  lines.push(`=== Import hygiene (${report.verdict.toUpperCase()}) ===`);
  lines.push(`  scanned files (with findings)  ${new Set(report.findings.map((f) => f.file)).size}`);
  lines.push(`  errors    ${report.counts['error'] ?? 0}`);
  lines.push(`  warnings  ${report.counts['warning'] ?? 0}`);
  lines.push(`  info      ${report.counts['info'] ?? 0}`);
  lines.push('');
  for (const f of report.findings) {
    const tag = f.allowlisted ? '[allowlisted]' : `[${f.severity}]`;
    lines.push(`  ${tag} ${f.file}:${f.line}:${f.column ?? 0}  ${f.kind}`);
    lines.push(`    ${f.snippet}`);
    if (!f.allowlisted) lines.push(`    fix: ${f.suggestedFix}`);
  }
  lines.push('');
  lines.push(`Next: ${report.nextCommand}`);
  return lines.join('\n') + '\n';
}
