/**
 * Product coherence check.
 *
 * Verifies the SharkCraft narrative is coherent: README has the right
 * sections, primary commands exist, release docs are present, MCP
 * read-only statement is in place, no "autonomous write agent" claims.
 * Additionally checks:
 * - CHANGELOG has a current-version or Unreleased entry.
 * - README links to release notes / limitations / external quickstart.
 * - docs/commands-taxonomy.md presence (when expected).
 * - docs/public-alpha-checklist.md mentions final validation gates.
 * - docs/releases/0.1.0-alpha.2.md states "not production stable" or equivalent.
 *
 * `--strict` converts warnings to errors.
 *
 * Read-only.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const PRODUCT_COHERENCE_SCHEMA = 'sharkcraft.product-coherence/v1';

export interface IProductCoherenceFinding {
  id: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  evidence?: string;
}

export interface IProductCoherenceReport {
  schema: typeof PRODUCT_COHERENCE_SCHEMA;
  generatedAt: string;
  findings: readonly IProductCoherenceFinding[];
  passed: boolean;
  /** When strict mode is on, warnings are reported as errors. */
  strict: boolean;
}

const REQUIRED_DOCS: readonly string[] = [
  'README.md',
  'docs/safety-model.md',
  'docs/releases/0.1.0-alpha.2.md',
  'docs/public-alpha-limitations.md',
  'docs/external-repo-quickstart.md',
  'CHANGELOG.md',
];

const README_REQUIRED_PHRASES: readonly { phrase: RegExp; id: string; message: string }[] = [
  { phrase: /MCP[^\n]*read[-\s]?only|MCP server never writes|MCP[^\n]*no\s+writes/i, id: 'readme-mcp-read-only', message: 'README must state MCP is read-only.' },
  { phrase: /dry[-\s]?run\s+by\s+default|plan[-\s]?first|never auto-?(apply|publish)|Apply requires/i, id: 'readme-no-auto-apply', message: 'README must state SharkCraft does not auto-apply code.' },
  { phrase: /start[-\s]?here|Try it in/i, id: 'readme-start-here', message: 'README must include a start-here or "Try it in N seconds" section.' },
];

const README_FORBIDDEN_PHRASES: readonly { phrase: RegExp; id: string; message: string }[] = [
  { phrase: /autonomous\s+write[-\s]?agent\b/i, id: 'forbidden-autonomous-write-claim', message: 'README must not claim SharkCraft is an autonomous write agent.' },
];

const README_RECOMMENDED_LINKS: readonly { phrase: RegExp; id: string; message: string }[] = [
  {
    phrase: /docs\/releases\/[^\s\)]+|release[-\s]?notes/i,
    id: 'readme-link-release-notes',
    message: 'README should link to release notes (e.g. docs/releases/0.1.0-alpha.2.md).',
  },
  {
    phrase: /docs\/public[-\s]?alpha[-\s]?limitations/i,
    id: 'readme-link-limitations',
    message: 'README should link to docs/public-alpha-limitations.md.',
  },
  {
    phrase: /docs\/external[-\s]?repo[-\s]?quickstart/i,
    id: 'readme-link-external-quickstart',
    message: 'README should link to docs/external-repo-quickstart.md.',
  },
];

export interface IProductCoherenceOptions {
  strict?: boolean;
}

function readFileText(root: string, rel: string): string | undefined {
  const p = nodePath.join(root, rel);
  if (!existsSync(p)) return undefined;
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

function checkChangelog(root: string, findings: IProductCoherenceFinding[]): void {
  const cl = readFileText(root, 'CHANGELOG.md');
  if (!cl) return;
  const hasUnreleased = /^##\s+\[?Unreleased\]?/im.test(cl);
  const hasVersionedEntry = /^##\s+\[?\d+\.\d+\.\d+[a-zA-Z0-9.\-+]*\]?/im.test(cl);
  if (!hasUnreleased && !hasVersionedEntry) {
    findings.push({
      id: 'changelog-no-current-entry',
      severity: 'warning',
      message: 'CHANGELOG.md should have either an Unreleased section or a versioned entry.',
    });
  }
}

function checkReleaseNotes(root: string, findings: IProductCoherenceFinding[]): void {
  const rel = readFileText(root, 'docs/releases/0.1.0-alpha.2.md');
  if (!rel) return;
  if (!/not\s+production[-\s]?stable|public[-\s]?alpha|preview|early[-\s]?stage/i.test(rel)) {
    findings.push({
      id: 'release-notes-stability-disclaimer',
      severity: 'warning',
      message:
        'docs/releases/0.1.0-alpha.2.md should state the release is not production-stable (or equivalent).',
    });
  }
}

function checkPublicAlphaChecklist(root: string, findings: IProductCoherenceFinding[]): void {
  const cl = readFileText(root, 'docs/public-alpha-checklist.md');
  if (!cl) {
    // Not required; skipped silently.
    return;
  }
  if (!/preflight|readiness|smoke|safety[-\s]?audit/i.test(cl)) {
    findings.push({
      id: 'public-alpha-checklist-gates',
      severity: 'info',
      message:
        'docs/public-alpha-checklist.md should mention preflight/readiness/smoke/safety-audit gates.',
    });
  }
}

function checkTaxonomyDocPresence(root: string, findings: IProductCoherenceFinding[]): void {
  const taxonomyDoc = nodePath.join(root, 'docs/commands-taxonomy.md');
  if (!existsSync(taxonomyDoc)) {
    findings.push({
      id: 'taxonomy-doc-missing',
      severity: 'info',
      message:
        'docs/commands-taxonomy.md is not present. Run `shrk commands taxonomy --write-docs` to generate it.',
    });
  }
}

export function buildProductCoherenceReport(
  inspection: ISharkcraftInspection,
  options: IProductCoherenceOptions = {},
): IProductCoherenceReport {
  const findings: IProductCoherenceFinding[] = [];
  const root = inspection.projectRoot;
  for (const d of REQUIRED_DOCS) {
    if (!existsSync(nodePath.join(root, d))) {
      findings.push({ id: `required-doc:${d}`, severity: 'warning', message: `Required doc missing: ${d}` });
    }
  }
  // README narrative checks.
  const readme = readFileText(root, 'README.md');
  if (readme !== undefined) {
    for (const r of README_REQUIRED_PHRASES) {
      if (!r.phrase.test(readme)) {
        findings.push({ id: r.id, severity: 'warning', message: r.message });
      }
    }
    for (const r of README_FORBIDDEN_PHRASES) {
      if (r.phrase.test(readme)) {
        findings.push({ id: r.id, severity: 'error', message: r.message });
      }
    }
    for (const r of README_RECOMMENDED_LINKS) {
      if (!r.phrase.test(readme)) {
        findings.push({ id: r.id, severity: 'info', message: r.message });
      }
    }
  }
  checkChangelog(root, findings);
  checkReleaseNotes(root, findings);
  checkPublicAlphaChecklist(root, findings);
  checkTaxonomyDocPresence(root, findings);

  const strict = options.strict === true;
  const effectiveFindings = strict
    ? findings.map((f) =>
        f.severity === 'warning' ? ({ ...f, severity: 'error' as const }) : f,
      )
    : findings;
  const passed = effectiveFindings.every((f) => f.severity !== 'error');
  return {
    schema: PRODUCT_COHERENCE_SCHEMA,
    generatedAt: new Date().toISOString(),
    findings: effectiveFindings,
    passed,
    strict,
  };
}
