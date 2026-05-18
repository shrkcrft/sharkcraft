import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const CONTRADICTIONS_SCHEMA = 'sharkcraft.contradictions/v1';

export enum ContradictionKind {
  MissingPath = 'missing-path',
  MissingCommand = 'missing-command',
  StalePath = 'stale-path',
  OldCliPath = 'old-cli-path',
  MissingExport = 'missing-export',
  DocVsConfigConflict = 'doc-vs-config-conflict',
  DeprecatedRecommendation = 'deprecated-recommendation',
}

export enum ContradictionSeverity {
  Error = 'error',
  Warning = 'warning',
  Info = 'info',
}

export interface IContradictionFinding {
  id: string;
  kind: ContradictionKind;
  severity: ContradictionSeverity;
  message: string;
  /** Where the contradiction is referenced. */
  source: string;
  /** Optional 1-based line number in the source. */
  line?: number;
  /** The thing being referenced incorrectly. */
  reference: string;
  suggestion?: string;
  reason: string;
}

export interface IContradictionReport {
  schema: typeof CONTRADICTIONS_SCHEMA;
  projectRoot: string;
  findings: readonly IContradictionFinding[];
  /** Files scanned. */
  filesScanned: number;
  /** Limitations / sampling notes. */
  limitations: readonly string[];
}

export interface IBuildContradictionReportOptions {
  inspection: ISharkcraftInspection;
  /** Max doc files to scan. Default 80. */
  docScanLimit?: number;
  /** Max bytes per doc. Default 200_000. */
  bytesPerDoc?: number;
}

const DEFAULT_DOC_SCAN_LIMIT = 80;
const DEFAULT_BYTES_PER_DOC = 200_000;

const DOC_EXTS = new Set(['.md', '.mdx', '.rst', '.txt']);
const DOC_DIR_NAMES = new Set(['docs', 'documentation', 'doc']);

const DEPRECATED_CLI_HINTS: ReadonlyArray<{ re: RegExp; replacement: string }> = [
  { re: /\bsharkcraft\s+/i, replacement: 'shrk ' },
  { re: /\b@shrkcrft\/cli\s+/i, replacement: 'shrk ' },
];

const DEPRECATED_RECOMMENDATION_HINTS: ReadonlyArray<{ re: RegExp; reason: string }> = [
  { re: /TSLint/i, reason: 'TSLint has been deprecated in favour of ESLint.' },
  { re: /\bvar\s+[A-Za-z_$]/g, reason: 'Prefer `const` / `let` over `var` in modern code.' },
];

const CODE_FENCE_RE = /^```([a-zA-Z0-9_-]*)\s*$/;
const COMMAND_FENCE_LANGS = new Set(['sh', 'bash', 'shell', 'zsh', 'console']);

const REL_PATH_HINT_RE = /(?:^|[\s`(\[])(?:\.\/|src\/|packages\/|libs\/|apps\/|examples\/|docs\/|scripts\/|tools\/|tests?\/|e2e\/|sharkcraft\/)[\w@\/_.\-+]+/g;
const INLINE_CODE_PATH_RE = /`([^`]+)`/g;
const SOURCE_PREFIX_RE = /^(\.\/|src\/|packages\/|libs\/|apps\/|examples\/|docs\/|scripts\/|tools\/|tests?\/|e2e\/|sharkcraft\/|\.github\/)/;
const SCHEMA_ID_RE = /^[a-z][\w.-]*\.[\w.-]*\/v\d+$/;
const GH_ACTION_RE = /^[\w.-]+\/[\w.-]+(@[\w.\-+~]+)?$/;

export function buildContradictionReport(
  options: IBuildContradictionReportOptions,
): IContradictionReport {
  const inspection = options.inspection;
  const projectRoot = inspection.projectRoot;
  const docLimit = options.docScanLimit ?? DEFAULT_DOC_SCAN_LIMIT;
  const byteLimit = options.bytesPerDoc ?? DEFAULT_BYTES_PER_DOC;
  const limitations: string[] = [];

  const findings: IContradictionFinding[] = [];
  const docs = collectDocs(projectRoot, docLimit);
  if (docs.length >= docLimit) {
    limitations.push(`Doc scan limited to ${docLimit} files; deeper trees may not be covered.`);
  }

  const knownScripts = new Set<string>();
  for (const script of Object.keys(inspection.workspace.scripts ?? {})) knownScripts.add(script);

  const cliCommandNames = collectShrkCommandNames();

  for (const doc of docs) {
    let body = '';
    try {
      body = readFileSync(doc.abs, 'utf8');
    } catch {
      continue;
    }
    if (body.length > byteLimit) {
      body = body.slice(0, byteLimit);
      limitations.push(`Doc ${doc.rel} truncated at ${byteLimit} bytes.`);
    }
    const lines = body.split(/\r?\n/);

    let inFence = false;
    let fenceLang: string | null = null;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      const fenceMatch = line.match(CODE_FENCE_RE);
      if (fenceMatch) {
        if (inFence) {
          inFence = false;
          fenceLang = null;
        } else {
          inFence = true;
          fenceLang = fenceMatch[1]?.toLowerCase() ?? '';
        }
        continue;
      }

      // Missing paths — only check inline-coded paths and well-known relative path forms.
      const refs = extractPathReferences(line);
      const seenOnLine = new Set<string>();
      for (const ref of refs) {
        if (!looksLikePath(ref)) continue;
        const cleaned = ref.replace(/[.,;:!\)\]`]+$/g, '').replace(/^[`(\[]+/, '');
        if (!cleaned) continue;
        if (cleaned.startsWith('http://') || cleaned.startsWith('https://')) continue;
        const probe = cleaned.startsWith('./') ? cleaned.slice(2) : cleaned;
        if (seenOnLine.has(probe)) continue;
        seenOnLine.add(probe);
        const abs = nodePath.join(projectRoot, probe);
        if (!existsSync(abs)) {
          findings.push({
            id: `missing-path:${doc.rel}:${i + 1}:${probe}`,
            kind: ContradictionKind.MissingPath,
            severity: ContradictionSeverity.Warning,
            message: `Doc references missing path \`${probe}\`.`,
            source: doc.rel,
            line: i + 1,
            reference: probe,
            suggestion: 'Update the doc or restore the file.',
            reason: 'Doc-vs-tree consistency.',
          });
        }
      }

      // Commands referenced inside a shell fence.
      if (inFence && fenceLang && COMMAND_FENCE_LANGS.has(fenceLang)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const tokens = trimmed.split(/\s+/);
        if (tokens.length === 0) continue;
        const head = tokens[0];
        const next = tokens[1] ?? '';

        // Old `sharkcraft <verb>` patterns.
        if (head === 'sharkcraft' && next) {
          findings.push({
            id: `old-cli-path:${doc.rel}:${i + 1}`,
            kind: ContradictionKind.OldCliPath,
            severity: ContradictionSeverity.Warning,
            message: `Doc uses deprecated CLI prefix \`sharkcraft ${next}\` (now \`shrk ${next}\`).`,
            source: doc.rel,
            line: i + 1,
            reference: trimmed,
            suggestion: `Replace with \`shrk ${next}\`.`,
            reason: 'CLI renamed from sharkcraft to shrk.',
          });
        }

        // `shrk <verb>` — verify verb exists in command catalogue.
        if (head === 'shrk' && next && !next.startsWith('-')) {
          if (cliCommandNames.size > 0 && !cliCommandNames.has(next)) {
            findings.push({
              id: `missing-command:${doc.rel}:${i + 1}:${next}`,
              kind: ContradictionKind.MissingCommand,
              severity: ContradictionSeverity.Warning,
              message: `Doc references CLI command \`shrk ${next}\` which is not in the catalogue.`,
              source: doc.rel,
              line: i + 1,
              reference: `shrk ${next}`,
              suggestion: 'Update the doc or add the command.',
              reason: 'Doc-vs-CLI consistency.',
            });
          }
        }

        // npm/bun script references.
        if ((head === 'bun' || head === 'npm' || head === 'pnpm' || head === 'yarn') && (next === 'run' || next === 'x')) {
          const script = tokens[2];
          if (script && !script.startsWith('-') && next === 'run' && knownScripts.size > 0 && !knownScripts.has(script)) {
            findings.push({
              id: `missing-command:${doc.rel}:${i + 1}:${script}`,
              kind: ContradictionKind.MissingCommand,
              severity: ContradictionSeverity.Warning,
              message: `Doc references package-script \`${head} run ${script}\` which is not defined in package.json.`,
              source: doc.rel,
              line: i + 1,
              reference: `${head} run ${script}`,
              suggestion: 'Add the script or update the doc.',
              reason: 'Doc-vs-scripts consistency.',
            });
          }
        }
      }

      // Deprecated CLI hints (inline mentions, even outside fences).
      if (!inFence) {
        for (const hint of DEPRECATED_CLI_HINTS) {
          const m = line.match(/\bsharkcraft\s+([\w-]+)/);
          if (m && !line.includes('shrk ')) {
            findings.push({
              id: `deprecated:${doc.rel}:${i + 1}`,
              kind: ContradictionKind.OldCliPath,
              severity: ContradictionSeverity.Info,
              message: `Doc mentions \`sharkcraft ${m[1] ?? ''}\` (now \`shrk ${m[1] ?? ''}\`).`,
              source: doc.rel,
              line: i + 1,
              reference: m[0],
              suggestion: `Use \`shrk ${m[1] ?? ''}\`.`,
              reason: 'CLI rename.',
            });
          }
          // Marker — uses the imported hint to satisfy lint.
          void hint;
        }
      }
    }
  }

  return {
    schema: CONTRADICTIONS_SCHEMA,
    projectRoot,
    findings,
    filesScanned: docs.length,
    limitations,
  };
}

interface IDocFile {
  rel: string;
  abs: string;
}

function collectDocs(projectRoot: string, limit: number): IDocFile[] {
  const found: IDocFile[] = [];
  const visit = (dir: string): void => {
    if (found.length >= limit) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit) return;
      if (entry.startsWith('.') && entry !== '.cursor') continue;
      if (entry === 'node_modules' || entry === 'dist' || entry === 'build' || entry === 'coverage' || entry === '.angular' || entry === '.next' || entry === '.nuxt') continue;
      const abs = nodePath.join(dir, entry);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        visit(abs);
        continue;
      }
      const ext = nodePath.extname(entry).toLowerCase();
      const base = entry.toLowerCase();
      const isTopReadme = dir === projectRoot && /^readme\.(md|mdx|rst)$/i.test(entry);
      const isChangelog = /^changelog\./i.test(entry);
      const isDocsDir = DOC_DIR_NAMES.has(nodePath.basename(dir).toLowerCase());
      if (isTopReadme || isChangelog || (DOC_EXTS.has(ext) && (isDocsDir || base.includes('readme') || base.includes('guide')))) {
        const rel = nodePath.relative(projectRoot, abs);
        found.push({ rel, abs });
      }
    }
  };
  visit(projectRoot);
  return found;
}

function extractPathReferences(line: string): string[] {
  const refs: string[] = [];
  let m: RegExpExecArray | null;
  const re1 = new RegExp(INLINE_CODE_PATH_RE.source, 'g');
  while ((m = re1.exec(line)) !== null) {
    const captured = m[1];
    if (captured && captured.length > 0 && captured.length < 200) refs.push(captured);
  }
  const re2 = new RegExp(REL_PATH_HINT_RE.source, 'g');
  while ((m = re2.exec(line)) !== null) {
    refs.push(m[0].trim());
  }
  return refs;
}

function looksLikePath(s: string): boolean {
  if (!s) return false;
  if (s.startsWith('http')) return false;
  if (s.includes(' ')) return false;
  if (/[<>{}]/.test(s)) return false; // placeholders / brace-expansions
  if (s.endsWith('/')) return false; // generic dir reference
  if (s.startsWith('@')) return false; // npm package
  if (SCHEMA_ID_RE.test(s)) return false; // sharkcraft.foo/v1
  if (GH_ACTION_RE.test(s)) return false; // org/repo style
  // Require either a specific source-tree prefix and a `.ext`, or a fully-qualified path with extension.
  const hasSlash = s.includes('/');
  const hasExt = /\.(md|mdx|ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|toml|svg|png|css|scss|html|sh|py|go|rs|java|kt|cs)$/i.test(s);
  if (!hasSlash) return false;
  if (!SOURCE_PREFIX_RE.test(s) && !hasExt) return false;
  // Reject pseudo-paths that contain literal globs/wildcards.
  if (/[*?]/.test(s)) return false;
  return true;
}

function collectShrkCommandNames(): Set<string> {
  // Hard-coded list of well-known top-level commands. Importing the CLI here
  // would create a layering violation (inspector → cli) — instead we mirror
  // the catalogue that `shrk commands` would print. Missing entries simply
  // suppress contradiction findings for those commands, which is the safe
  // failure mode.
  return new Set<string>([
    'init', 'inspect', 'doctor', 'context', 'gen', 'apply', 'export', 'import',
    'task', 'next', 'find', 'explain', 'check', 'watch', 'drift', 'graph',
    'coverage', 'review', 'onboard', 'test', 'plan', 'session', 'dev', 'ask',
    'mcp', 'version', 'quality', 'ci', 'commands', 'safety', 'infer', 'report',
    'dashboard', 'bundle', 'impact', 'search', 'brief', 'demo', 'release',
    'start-here', 'handoff', 'map', 'intent', 'orchestrate', 'simulate', 'view',
    'recommend', 'risk', 'migration', 'contract', 'languages', 'help',
    'memory', 'heal', 'agent', 'docs', 'examples', 'self', 'install',
    'diagnostics', 'intelligence', 'architecture', 'decisions', 'compliance',
    'policy', 'product', 'reposet', 'packs', 'upgrade', 'api', 'boundaries',
    'repo', 'owners', 'ownership', 'runtime', 'constructs', 'playbooks',
    'presets', 'pipelines', 'paths', 'rules', 'templates', 'knowledge',
    'schemas', 'scaffolds', 'tests',
    // Additions
    'ingest', 'understand-task', 'validate-change', 'contradictions', 'generated', 'stability',
  ]);
}

export function renderContradictionReportText(report: IContradictionReport): string {
  const lines: string[] = [];
  lines.push('=== Contradictions report ===');
  lines.push(`  findings   ${report.findings.length}`);
  lines.push(`  docs scanned ${report.filesScanned}`);
  if (report.findings.length === 0) {
    lines.push('');
    lines.push('No contradictions found.');
    return lines.join('\n');
  }
  const grouped = new Map<ContradictionKind, IContradictionFinding[]>();
  for (const f of report.findings) {
    const arr = grouped.get(f.kind) ?? [];
    arr.push(f);
    grouped.set(f.kind, arr);
  }
  for (const [kind, arr] of grouped) {
    lines.push('');
    lines.push(`${kind} (${arr.length}):`);
    for (const f of arr.slice(0, 20)) {
      const loc = f.line ? `${f.source}:${f.line}` : f.source;
      lines.push(`  - [${f.severity}] ${loc} — ${f.message}`);
      if (f.suggestion) lines.push(`      suggestion: ${f.suggestion}`);
    }
    if (arr.length > 20) lines.push(`  ... ${arr.length - 20} more`);
  }
  if (report.limitations.length > 0) {
    lines.push('');
    lines.push('Limitations:');
    for (const l of report.limitations) lines.push(`  - ${l}`);
  }
  return lines.join('\n');
}

export function renderContradictionReportMarkdown(report: IContradictionReport): string {
  const lines: string[] = [];
  lines.push('# Contradictions report');
  lines.push('');
  lines.push(`- Findings: **${report.findings.length}**`);
  lines.push(`- Docs scanned: **${report.filesScanned}**`);
  if (report.findings.length === 0) {
    lines.push('');
    lines.push('_No contradictions found._');
    return lines.join('\n');
  }
  lines.push('');
  lines.push('## Findings');
  lines.push('');
  lines.push('| Severity | Kind | Source | Reference | Message | Suggestion |');
  lines.push('|---|---|---|---|---|---|');
  for (const f of report.findings) {
    const loc = f.line ? `${f.source}:${f.line}` : f.source;
    lines.push(`| ${f.severity} | ${f.kind} | \`${loc}\` | \`${f.reference}\` | ${f.message} | ${f.suggestion ?? '-'} |`);
  }
  if (report.limitations.length > 0) {
    lines.push('');
    lines.push('## Limitations');
    lines.push('');
    for (const l of report.limitations) lines.push(`- ${l}`);
  }
  return lines.join('\n');
}

export function renderContradictionReportHtml(report: IContradictionReport): string {
  const rows = report.findings
    .map(
      (f) => `<tr><td>${f.severity}</td><td>${f.kind}</td><td><code>${esc(f.source)}${f.line ? `:${f.line}` : ''}</code></td><td><code>${esc(f.reference)}</code></td><td>${esc(f.message)}</td><td>${esc(f.suggestion ?? '')}</td></tr>`,
    )
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Contradictions</title><style>body{font-family:system-ui;max-width:920px;margin:32px auto;padding:0 16px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ddd;padding:6px;font-size:13px;text-align:left}th{background:#f6f6f6}code{font-size:12px}</style></head><body><h1>Contradictions report</h1><p>Findings: <strong>${report.findings.length}</strong> · Docs scanned: <strong>${report.filesScanned}</strong></p><table><thead><tr><th>Severity</th><th>Kind</th><th>Source</th><th>Reference</th><th>Message</th><th>Suggestion</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderContradictionReportJson(report: IContradictionReport): string {
  return JSON.stringify(report, null, 2);
}
