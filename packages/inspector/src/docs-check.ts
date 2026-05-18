/**
 * `shrk docs check` — verify the docs / README content.
 *
 * Read-only. Verifies:
 *  - required docs exist (`docs/<canonical>.md`)
 *  - README contains required sections (heading keywords)
 *  - relative docs links in README point to files that exist
 *  - safety statement is present in README
 *  - no obvious stale command references (when a catalog is provided)
 *
 * The check is intentionally minimal — it answers "would a new reader find
 * the runnable bits?", not "are the docs prose-quality".
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';

export const DOCS_CHECK_SCHEMA = 'sharkcraft.docs-check/v1';

export interface IDocsCheckFinding {
  code:
    | 'required-doc-missing'
    | 'readme-section-missing'
    | 'readme-link-broken'
    | 'safety-statement-missing'
    | 'mcp-readonly-statement-missing'
    | 'stale-command-reference';
  severity: 'info' | 'warning' | 'error';
  message: string;
  file?: string;
  suggestion?: string;
}

export interface IDocsCheckReport {
  schema: typeof DOCS_CHECK_SCHEMA;
  generatedAt: string;
  projectRoot: string;
  findings: readonly IDocsCheckFinding[];
  readmePresent: boolean;
  docsFolderPresent: boolean;
  requiredDocsPresent: number;
  requiredDocsExpected: number;
  ok: boolean;
}

const REQUIRED_DOCS = [
  'overview.md',
  'philosophy.md',
  'safety-model.md',
  'testing.md',
];

const README_REQUIRED_KEYWORDS = ['quick demo', 'onboard', 'safety'];

const README_SAFETY_KEYWORDS = ['mcp', 'read-only', 'never writes', 'safety'];

function readSafe(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function extractMarkdownLinks(body: string): { text: string; href: string }[] {
  const out: { text: string; href: string }[] = [];
  const re = /\[([^\]]+)\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    out.push({ text: m[1]!, href: m[2]! });
  }
  return out;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export interface IBuildDocsCheckOptions {
  /** Known CLI subcommand strings (e.g. ['shrk doctor', 'shrk brief']).
   *  Used to detect stale references. */
  knownCommands?: readonly string[];
}

export function buildDocsCheck(
  projectRoot: string,
  options: IBuildDocsCheckOptions = {},
): IDocsCheckReport {
  const findings: IDocsCheckFinding[] = [];
  const readmeFile = nodePath.join(projectRoot, 'README.md');
  const readmeBody = readSafe(readmeFile);
  const readmePresent = readmeBody !== null;
  const docsDir = nodePath.join(projectRoot, 'docs');
  const docsFolderPresent = existsSync(docsDir);
  let requiredDocsPresent = 0;
  for (const rel of REQUIRED_DOCS) {
    const file = nodePath.join(docsDir, rel);
    if (existsSync(file)) {
      requiredDocsPresent += 1;
    } else {
      findings.push({
        code: 'required-doc-missing',
        severity: 'error',
        message: `Required doc missing: docs/${rel}`,
        file: `docs/${rel}`,
        suggestion: 'Add the canonical doc; release-readiness checks for it.',
      });
    }
  }
  if (readmePresent) {
    const lower = readmeBody!.toLowerCase();
    for (const keyword of README_REQUIRED_KEYWORDS) {
      if (!lower.includes(keyword)) {
        findings.push({
          code: 'readme-section-missing',
          severity: 'warning',
          message: `README does not mention "${keyword}".`,
          file: 'README.md',
          suggestion: `Add a section that includes the word "${keyword}".`,
        });
      }
    }
    const safetyHits = README_SAFETY_KEYWORDS.filter((k) => lower.includes(k));
    if (safetyHits.length < 2) {
      findings.push({
        code: 'safety-statement-missing',
        severity: 'warning',
        message: 'README does not include a clear safety statement.',
        file: 'README.md',
        suggestion: 'Add a paragraph that says MCP never writes and the CLI is the only write path.',
      });
    }
    if (!lower.includes('mcp') || !lower.includes('read-only')) {
      findings.push({
        code: 'mcp-readonly-statement-missing',
        severity: 'warning',
        message: 'README does not explicitly state that MCP is read-only.',
        file: 'README.md',
        suggestion: 'Include the phrase "MCP is read-only" so adopters can scan-find it.',
      });
    }
    // Validate internal links.
    for (const link of extractMarkdownLinks(readmeBody!)) {
      if (/^https?:/.test(link.href) || link.href.startsWith('#')) continue;
      const target = link.href.split('#')[0]!;
      const abs = nodePath.resolve(projectRoot, target);
      if (!existsSync(abs)) {
        findings.push({
          code: 'readme-link-broken',
          severity: 'warning',
          message: `README links to ${target} but that file does not exist.`,
          file: 'README.md',
          suggestion: `Either create ${target} or update the link.`,
        });
      }
    }
    // Detect stale `shrk …` references when a catalog is supplied.
    if (options.knownCommands && options.knownCommands.length > 0) {
      const knownSet = new Set(options.knownCommands);
      const re = /\bshrk\s+([\w-]+(?:\s+[\w-]+)?)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(readmeBody!))) {
        const command = `shrk ${m[1]!.trim()}`;
        // Allow partial prefix matches (some commands have arguments after).
        let known = false;
        for (const k of knownSet) {
          if (k === command || k.startsWith(command) || command.startsWith(k)) {
            known = true;
            break;
          }
        }
        if (!known) {
          findings.push({
            code: 'stale-command-reference',
            severity: 'info',
            message: `README references "${command}" which is not in the command catalog.`,
            file: 'README.md',
            suggestion: 'Check whether the command was renamed or removed.',
          });
        }
      }
    }
  } else {
    findings.push({
      code: 'required-doc-missing',
      severity: 'error',
      message: 'README.md is missing at the project root.',
      file: 'README.md',
    });
  }
  // Cross-check docs/ for broken intra-doc links.
  if (docsFolderPresent) {
    for (const entry of safeReaddir(docsDir)) {
      if (!entry.endsWith('.md')) continue;
      const file = nodePath.join(docsDir, entry);
      try {
        if (!statSync(file).isFile()) continue;
      } catch {
        continue;
      }
      const body = readSafe(file);
      if (!body) continue;
      for (const link of extractMarkdownLinks(body)) {
        if (/^https?:/.test(link.href) || link.href.startsWith('#')) continue;
        const target = link.href.split('#')[0]!;
        const abs = nodePath.resolve(docsDir, target);
        if (!existsSync(abs)) {
          findings.push({
            code: 'readme-link-broken',
            severity: 'info',
            message: `docs/${entry} links to ${target} but it does not exist.`,
            file: `docs/${entry}`,
            suggestion: `Either create ${target} or update the link.`,
          });
        }
      }
    }
  }
  const ok = findings.filter((f) => f.severity === 'error').length === 0;
  return {
    schema: DOCS_CHECK_SCHEMA,
    generatedAt: new Date().toISOString(),
    projectRoot,
    findings,
    readmePresent,
    docsFolderPresent,
    requiredDocsPresent,
    requiredDocsExpected: REQUIRED_DOCS.length,
    ok,
  };
}

export function renderDocsCheckText(report: IDocsCheckReport): string {
  const lines: string[] = [];
  lines.push('# Docs check');
  lines.push(`OK: ${report.ok ? 'yes' : 'no'}  · README present: ${report.readmePresent}`);
  lines.push(`Required docs: ${report.requiredDocsPresent}/${report.requiredDocsExpected}`);
  if (report.findings.length === 0) {
    lines.push('No findings.');
  } else {
    lines.push('Findings:');
    for (const f of report.findings) {
      lines.push(`  [${f.severity}] ${f.code}: ${f.message}`);
      if (f.suggestion) lines.push(`     → ${f.suggestion}`);
    }
  }
  return lines.join('\n') + '\n';
}
