/**
 * PR summary / description generator.
 *
 * Builds a single PR-description blob from the changes summary + review
 * packet + CI report (if present) + release-readiness + safety audit.
 *
 * Read-only; deterministic; no AI. Schema: sharkcraft.pr-summary/v1.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { buildChangesSummary, type IChangesSummaryReport, type IChangesSummaryOptions } from './changes-summary.ts';
import { buildUncertaintyReport, type IUncertaintyReport } from './uncertainty-report.ts';
import { readDevSessionState } from './dev-session.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const PR_SUMMARY_SCHEMA = 'sharkcraft.pr-summary/v1';

export interface IPrSummarySection {
  title: string;
  body: string;
}

export interface IPrSummaryReport {
  schema: typeof PR_SUMMARY_SCHEMA;
  generatedAt: string;
  sections: readonly IPrSummarySection[];
  /** Final rendered Markdown body. */
  markdown: string;
  /** Uncertainty report (confidence + signals + safe fallback). */
  uncertainty?: IUncertaintyReport;
}

export interface IPrSummaryOptions {
  /** Diff input — same shape as IChangesSummaryOptions. */
  since?: string;
  staged?: boolean;
  files?: readonly string[];
  /** Cap items per list. Default 12. */
  maxItems?: number;
  /** Include raw links to reports (kept off by default). */
  includeRawLinks?: boolean;
  /** Reports directory. Default `.sharkcraft/reports`. */
  reportsDir?: string;
  /** Build the summary from a dev session's applied-plan files. */
  fromSession?: string;
  /** Build the summary from a bundle's plan files. */
  fromBundle?: string;
}

function loadJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function readMaybe(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function cap<T>(arr: readonly T[], limit: number): readonly T[] {
  return arr.slice(0, limit);
}

export async function buildPrSummary(
  inspection: ISharkcraftInspection,
  options: IPrSummaryOptions = {},
): Promise<IPrSummaryReport> {
  const maxItems = options.maxItems ?? 12;
  const cwd = inspection.projectRoot;
  const reportsDir = nodePath.isAbsolute(options.reportsDir ?? '.sharkcraft/reports')
    ? (options.reportsDir ?? '.sharkcraft/reports')
    : nodePath.join(cwd, options.reportsDir ?? '.sharkcraft/reports');
  const changesOpts: IChangesSummaryOptions = {};
  if (options.since) changesOpts.since = options.since;
  if (options.staged) changesOpts.staged = true;
  if (options.files && options.files.length > 0) changesOpts.files = options.files;

  // Derive `files` from a session or bundle if requested.
  if (options.fromSession && !changesOpts.files) {
    try {
      const state = readDevSessionState(cwd, options.fromSession);
      if (state) {
        const sessionFiles = state.appliedPlans.flatMap((p) => p.changedFiles ?? []);
        if (sessionFiles.length > 0) changesOpts.files = Array.from(new Set(sessionFiles));
      }
    } catch {
      // ignore — empty files leaves the standard `working-tree` mode.
    }
  }
  if (options.fromBundle && !changesOpts.files) {
    // Bundle resolution: read the bundle's plan-list JSON if present under
    // `.sharkcraft/bundles/<id>/manifest.json`.
    const bundleManifest = nodePath.join(cwd, '.sharkcraft', 'bundles', options.fromBundle, 'manifest.json');
    if (existsSync(bundleManifest)) {
      try {
        const json = JSON.parse(readFileSync(bundleManifest, 'utf8')) as {
          plans?: readonly { changedFiles?: readonly string[] }[];
        };
        const bundleFiles = (json.plans ?? []).flatMap((p) => p.changedFiles ?? []);
        if (bundleFiles.length > 0) changesOpts.files = Array.from(new Set(bundleFiles));
      } catch {
        // ignore
      }
    }
  }
  const changes: IChangesSummaryReport = await buildChangesSummary(inspection, changesOpts);

  const sections: IPrSummarySection[] = [];

  // Summary
  sections.push({
    title: 'Summary',
    body: changes.likelyPrSummary,
  });

  // Why
  sections.push({
    title: 'Why',
    body:
      'Edit this section to describe the motivation. The PR generator surfaces what changed; the human writes why.',
  });

  // What changed
  const whatChanged: string[] = [];
  for (const [area, files] of Object.entries(changes.filesByArea)) {
    whatChanged.push(`- **${area}** (${files.length}):`);
    for (const f of cap(files, maxItems)) whatChanged.push(`  - \`${f}\``);
    if (files.length > maxItems) whatChanged.push(`  - … ${files.length - maxItems} more`);
  }
  sections.push({
    title: 'What changed',
    body: whatChanged.join('\n'),
  });

  // Safety
  const safetyBody: string[] = [];
  if (changes.touchedMcpTools.length > 0) {
    safetyBody.push(`- MCP tool files touched (${changes.touchedMcpTools.length}). Read-only invariant must be re-verified.`);
    for (const m of cap(changes.touchedMcpTools, maxItems)) safetyBody.push(`  - \`${m}\``);
  }
  if (changes.safetyRelevantFiles.length > 0) {
    safetyBody.push(`- Safety-relevant files: ${changes.safetyRelevantFiles.length}`);
    for (const m of cap(changes.safetyRelevantFiles, maxItems)) safetyBody.push(`  - \`${m}\``);
  }
  if (safetyBody.length === 0) safetyBody.push('No safety-relevant files touched.');
  sections.push({ title: 'Safety', body: safetyBody.join('\n') });

  // Validation
  sections.push({
    title: 'Validation',
    body: changes.suggestedValidationCommands.map((c) => `- \`${c}\``).join('\n'),
  });

  // Risk / review notes
  const risk: string[] = [`Risk: **${changes.risk}**`];
  for (const r of changes.riskReasons) risk.push(`- ${r}`);
  sections.push({ title: 'Risk / review notes', body: risk.join('\n') });

  // Breaking changes
  sections.push({
    title: 'Breaking changes',
    body: 'None known. Edit if this PR removes/renames public exports or changes write-path defaults.',
  });

  // Migration notes
  sections.push({
    title: 'Migration notes',
    body: 'None. Edit if downstream consumers need an upgrade path.',
  });

  // Known limitations
  sections.push({
    title: 'Known limitations',
    body: 'None. Edit if any TODO / partial implementation remains.',
  });

  // Follow-ups
  sections.push({
    title: 'Follow-ups',
    body: 'Edit to list deferred items.',
  });

  // Commands run
  sections.push({
    title: 'Commands run',
    body: changes.suggestedValidationCommands.map((c) => `- \`${c}\``).join('\n'),
  });

  // Reports / artifacts
  const reports = collectReports(reportsDir);
  const reportLines: string[] = [];
  if (reports.length === 0) reportLines.push('_(no reports under `.sharkcraft/reports/`)_');
  for (const r of cap(reports, maxItems)) reportLines.push(`- \`${r}\``);
  sections.push({ title: 'Reports / artifacts', body: reportLines.join('\n') });

  const markdown = sections
    .map((s) => `## ${s.title}\n\n${s.body}\n`)
    .join('\n');

  // Uncertainty.
  let confidence: 'high' | 'medium' | 'low' | 'unknown' = 'high';
  const reasons: string[] = [];
  const missing: { id: string; message: string }[] = [];
  if (!changesOpts.files && !options.since && !options.staged) {
    confidence = 'medium';
    reasons.push('Diff scope was inferred from working tree — explicit --since or --files is more reliable.');
    missing.push({
      id: 'no-explicit-scope',
      message: 'No --since / --from-session / --from-bundle scope provided.',
    });
  }
  if ((options.fromSession || options.fromBundle) && !changesOpts.files) {
    confidence = 'low';
    reasons.push('Session/bundle scope was requested but no files were resolved.');
    missing.push({
      id: 'session-or-bundle-empty',
      message: 'Session/bundle had no applied-plan files.',
    });
  }
  const uncertainty = buildUncertaintyReport({
    confidence,
    reasons,
    missingSignals: missing,
    suggestedCommands: [
      'shrk pr summary --since main',
      'shrk pr summary --from-session <id>',
    ],
    safeFallbackCommand: 'shrk impact --since main',
  });

  return {
    schema: PR_SUMMARY_SCHEMA,
    generatedAt: new Date().toISOString(),
    sections,
    markdown,
    uncertainty,
  };
}

function collectReports(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = nodePath.join(dir, name);
    try {
      if (statSync(full).isFile()) out.push(nodePath.relative(process.cwd(), full));
    } catch {
      // ignore
    }
  }
  return out.sort();
}
