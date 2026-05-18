/**
 * Project-specific coupling audit.
 *
 * Scans the workspace for project-specific tokens (caller supplies them
 * via deny patterns) and reports each occurrence with a recommended
 * externalisation target. The engine ships no built-in tokens to keep
 * itself generic.
 *
 * Read-only — never writes.
 */
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import * as nodePath from 'node:path';

export const PROJECT_COUPLING_AUDIT_SCHEMA = 'sharkcraft.project-coupling-audit/v1';

export enum CouplingExternalizationTarget {
  /**
   * Engine-category hits live in engine source (`packages/`, `apps/`,
   * `libs/`); the audit recommends externalising them to a pack
   * contribution. `--fail-on engine` keys on this value specifically —
   * the bucket name matches the current source location, not the
   * recommended target.
   */
  Engine = 'engine',
  LocalConfig = 'local-config',
  Profile = 'profile',
  FixtureOnly = 'fixture-only',
  DocsExample = 'docs-example',
  FalsePositive = 'false-positive',
  Unclassified = 'unclassified',
}

export enum CouplingRiskLevel {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
}

export interface IProjectCouplingHit {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly token: string;
  readonly snippet: string;
  readonly externalizationTarget: CouplingExternalizationTarget;
  readonly risk: CouplingRiskLevel;
  readonly nextCommand?: string;
}

export interface IProjectCouplingAuditOptions {
  readonly projectRoot: string;
  /** Tokens to scan for; caller-supplied. */
  readonly tokens: readonly string[];
  /** Roots to scan relative to projectRoot. Defaults sensible. */
  readonly scanRoots?: readonly string[];
  /** Paths to exclude. */
  readonly excludeRoots?: readonly string[];
  /** Max files visited (safety). */
  readonly maxFiles?: number;
  /**
   * When true, matches preceded *and* followed by alphanumeric/underscore
   * (i.e. matches inside a larger identifier) are demoted to `false-positive`.
   * Default true; pass false to keep raw substring semantics.
   */
  readonly wordBoundary?: boolean;
}

export interface IProjectCouplingAuditReport {
  readonly schema: typeof PROJECT_COUPLING_AUDIT_SCHEMA;
  readonly projectRoot: string;
  readonly tokens: readonly string[];
  readonly filesScanned: number;
  readonly hits: readonly IProjectCouplingHit[];
  readonly hitsByExternalizationTarget: Readonly<Record<string, number>>;
  readonly hitsByToken: Readonly<Record<string, number>>;
  readonly verdict: 'clean' | 'has-coupling';
  readonly nextCommands: readonly string[];
}

const DEFAULT_SCAN_ROOTS = [
  'packages',
  'sharkcraft',
  'apps',
  'libs',
  'examples',
  'docs',
];

const DEFAULT_EXCLUDES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.sharkcraft',
  'tmp',
  '.next',
  '.cache',
]);

function isCodeOrDocFile(path: string): boolean {
  return /\.(ts|tsx|js|jsx|mts|mjs|cts|cjs|md|json|yaml|yml)$/i.test(path);
}

function walkFiles(
  dir: string,
  excludeRoots: ReadonlySet<string>,
  out: string[],
  maxFiles: number,
): void {
  if (out.length >= maxFiles) return;
  let dirents: Dirent[];
  try {
    dirents = readdirSync(dir, { withFileTypes: true }) as unknown as Dirent[];
  } catch {
    return;
  }
  for (const ent of dirents) {
    if (out.length >= maxFiles) break;
    const name = String(ent.name);
    if (excludeRoots.has(name)) continue;
    if (name.startsWith('.') && DEFAULT_EXCLUDES.has(name)) continue;
    const full = nodePath.join(dir, name);
    if (ent.isDirectory()) {
      walkFiles(full, excludeRoots, out, maxFiles);
    } else if (ent.isFile() && isCodeOrDocFile(name)) {
      out.push(full);
    }
  }
}

function classifyHit(
  file: string,
  _line: string,
  _token: string,
  insideIdentifier: boolean,
  wordBoundary: boolean,
): {
  externalizationTarget: CouplingExternalizationTarget;
  risk: CouplingRiskLevel;
  nextCommand?: string;
} {
  const lower = file.toLowerCase();
  if (wordBoundary && insideIdentifier) {
    return {
      externalizationTarget: CouplingExternalizationTarget.FalsePositive,
      risk: CouplingRiskLevel.Low,
    };
  }
  if (lower.includes('__tests__/') || lower.includes('.test.') || lower.includes('.spec.')) {
    return { externalizationTarget: CouplingExternalizationTarget.FixtureOnly, risk: CouplingRiskLevel.Low };
  }
  if (lower.includes('/docs/') || lower.endsWith('.md')) {
    return { externalizationTarget: CouplingExternalizationTarget.DocsExample, risk: CouplingRiskLevel.Low };
  }
  if (lower.includes('/sharkcraft/')) {
    return {
      externalizationTarget: CouplingExternalizationTarget.LocalConfig,
      risk: CouplingRiskLevel.Medium,
      nextCommand: 'Move this self-config entry into the relevant pack or remove if project-specific.',
    };
  }
  if (lower.includes('/packages/') || lower.includes('/apps/') || lower.includes('/libs/')) {
    return {
      externalizationTarget: CouplingExternalizationTarget.Engine,
      risk: CouplingRiskLevel.High,
      nextCommand: 'Move this project-specific behavior into a pack contribution (profile / contract / etc.).',
    };
  }
  return { externalizationTarget: CouplingExternalizationTarget.Unclassified, risk: CouplingRiskLevel.Medium };
}

function isIdentifierChar(ch: string | undefined): boolean {
  if (!ch) return false;
  return /[A-Za-z0-9_]/.test(ch);
}

export function auditProjectCoupling(
  options: IProjectCouplingAuditOptions,
): IProjectCouplingAuditReport {
  if (!options.tokens || options.tokens.length === 0) {
    return {
      schema: PROJECT_COUPLING_AUDIT_SCHEMA,
      projectRoot: options.projectRoot,
      tokens: [],
      filesScanned: 0,
      hits: [],
      hitsByExternalizationTarget: {},
      hitsByToken: {},
      verdict: 'clean',
      nextCommands: ['Provide --token <pattern> to scan for project-specific identifiers.'],
    };
  }
  const excludeRoots = new Set<string>(options.excludeRoots ?? []);
  const scanRoots = options.scanRoots ?? DEFAULT_SCAN_ROOTS;
  const maxFiles = options.maxFiles ?? 5000;
  const files: string[] = [];
  for (const rel of scanRoots) {
    const abs = nodePath.join(options.projectRoot, rel);
    try {
      const s = statSync(abs);
      if (s.isDirectory()) walkFiles(abs, new Set([...DEFAULT_EXCLUDES, ...excludeRoots]), files, maxFiles);
    } catch {
      continue;
    }
  }
  const wordBoundary = options.wordBoundary !== false;
  const hits: IProjectCouplingHit[] = [];
  const tokenCounts: Record<string, number> = {};
  const targetCounts: Record<string, number> = {};
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const token of options.tokens) {
        let from = 0;
        while (from < line.length) {
          const idx = line.indexOf(token, from);
          if (idx === -1) break;
          const beforeCh = idx > 0 ? line[idx - 1] : undefined;
          const endIdx = idx + token.length;
          const afterCh = endIdx < line.length ? line[endIdx] : undefined;
          // "inside identifier" means the match is wedged between word chars on
          // both sides. A token that itself ends with a non-word char (a
          // delimiter-suffixed prefix like `XXX-`) only needs the leading-side
          // check.
          const tokenEndsInsideWord = isIdentifierChar(token[token.length - 1]);
          const tokenStartsInsideWord = isIdentifierChar(token[0]);
          const insideIdentifier =
            (tokenStartsInsideWord && isIdentifierChar(beforeCh)) ||
            (tokenEndsInsideWord && isIdentifierChar(afterCh));
          const cls = classifyHit(file, line, token, insideIdentifier, wordBoundary);
          const rel = nodePath.relative(options.projectRoot, file);
          hits.push({
            file: rel,
            line: i + 1,
            column: idx + 1,
            token,
            snippet: line.length > 200 ? line.slice(0, 200) + '…' : line,
            externalizationTarget: cls.externalizationTarget,
            risk: cls.risk,
            ...(cls.nextCommand ? { nextCommand: cls.nextCommand } : {}),
          });
          tokenCounts[token] = (tokenCounts[token] ?? 0) + 1;
          targetCounts[cls.externalizationTarget] = (targetCounts[cls.externalizationTarget] ?? 0) + 1;
          from = endIdx;
        }
      }
    }
  }
  const blockingHits = hits.filter(
    (h) =>
      h.risk === CouplingRiskLevel.High &&
      h.externalizationTarget !== CouplingExternalizationTarget.FixtureOnly &&
      h.externalizationTarget !== CouplingExternalizationTarget.DocsExample &&
      h.externalizationTarget !== CouplingExternalizationTarget.FalsePositive,
  );
  return {
    schema: PROJECT_COUPLING_AUDIT_SCHEMA,
    projectRoot: options.projectRoot,
    tokens: options.tokens,
    filesScanned: files.length,
    hits,
    hitsByExternalizationTarget: targetCounts,
    hitsByToken: tokenCounts,
    verdict: blockingHits.length === 0 ? 'clean' : 'has-coupling',
    nextCommands:
      blockingHits.length === 0
        ? ['Engine packages are clean for the provided tokens.']
        : [
            `Move ${blockingHits.length} high-risk hit(s) into pack contributions or config.`,
            'See `shrk audit project-coupling plan` for the suggested extraction targets.',
          ],
  };
}

export function renderProjectCouplingAuditText(report: IProjectCouplingAuditReport): string {
  const lines: string[] = [];
  lines.push(`=== Project-specific coupling audit ===`);
  lines.push(`  projectRoot   ${report.projectRoot}`);
  lines.push(`  tokens        ${report.tokens.join(', ') || '(none)'}`);
  lines.push(`  filesScanned  ${report.filesScanned}`);
  lines.push(`  hits          ${report.hits.length}`);
  lines.push(`  verdict       ${report.verdict.toUpperCase()}`);
  lines.push('');
  if (report.hits.length === 0) {
    lines.push('  (no occurrences of any provided token)');
    return lines.join('\n') + '\n';
  }
  lines.push(`By token:`);
  for (const [t, n] of Object.entries(report.hitsByToken)) lines.push(`  ${t.padEnd(24)} ${n}`);
  lines.push('');
  lines.push(`By externalization target:`);
  for (const [t, n] of Object.entries(report.hitsByExternalizationTarget)) lines.push(`  ${t.padEnd(20)} ${n}`);
  lines.push('');
  lines.push(`Top hits (first 30):`);
  for (const h of report.hits.slice(0, 30)) {
    lines.push(`  ${h.file}:${h.line}:${h.column}  [${h.risk}] [${h.externalizationTarget}]  ${h.token}`);
  }
  lines.push('');
  lines.push(`Next:`);
  for (const c of report.nextCommands) lines.push(`  • ${c}`);
  return lines.join('\n') + '\n';
}

export function renderProjectCouplingAuditMarkdown(report: IProjectCouplingAuditReport): string {
  const lines: string[] = [];
  lines.push(`# Project-specific coupling audit`);
  lines.push('');
  lines.push(`- projectRoot: \`${report.projectRoot}\``);
  lines.push(`- tokens: ${report.tokens.map((t) => '`' + t + '`').join(', ') || '(none)'}`);
  lines.push(`- filesScanned: ${report.filesScanned}`);
  lines.push(`- hits: ${report.hits.length}`);
  lines.push(`- verdict: **${report.verdict.toUpperCase()}**`);
  lines.push('');
  if (report.hits.length === 0) {
    lines.push('No occurrences of any provided token. ✓');
    return lines.join('\n') + '\n';
  }
  lines.push('## By token');
  for (const [t, n] of Object.entries(report.hitsByToken)) lines.push(`- \`${t}\` — ${n}`);
  lines.push('');
  lines.push('## By externalisation target');
  for (const [t, n] of Object.entries(report.hitsByExternalizationTarget)) lines.push(`- ${t} — ${n}`);
  lines.push('');
  lines.push('## Hits');
  lines.push('| File | Line | Token | Risk | Target | Next |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const h of report.hits.slice(0, 200)) {
    lines.push(
      `| \`${h.file}\` | ${h.line} | \`${h.token}\` | ${h.risk} | ${h.externalizationTarget} | ${h.nextCommand ?? ''} |`,
    );
  }
  return lines.join('\n') + '\n';
}
