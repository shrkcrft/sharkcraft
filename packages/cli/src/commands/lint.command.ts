/**
 * Unified `shrk lint` verb.
 *
 * Pure CLI aggregator over the per-kind doctor / lint surfaces:
 *   - knowledge → `lintKnowledge` + `buildKnowledgeLintFixPreview`
 *   - rules     → `diagnoseRuleQuality`
 *   - templates → `buildTemplateDriftReport`
 *
 * No new domain logic. Layer order preserved (inspector → cli only).
 * The per-kind verbs (`knowledge lint`, `rules doctor`, `rules lint`,
 * `templates doctor`, `templates drift`) keep working unchanged.
 */

import {
  buildKnowledgeLintFixPreview,
  buildKnowledgeStaleReport,
  buildTemplateDriftReport,
  diagnoseRuleQuality,
  inspectSharkcraft,
  lintKnowledge,
  ReferenceCheckOutcome,
  TemplateDriftStatus,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagList,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';
import { collectChangedPaths } from '../diff/collect-changed-paths.ts';

type Kind = 'knowledge' | 'rules' | 'templates' | 'all';

function parseKind(value: string | undefined): Kind {
  switch ((value ?? 'all').toLowerCase()) {
    case 'knowledge':
      return 'knowledge';
    case 'rules':
      return 'rules';
    case 'templates':
      return 'templates';
    default:
      return 'all';
  }
}

export const lintCommand: ICommandHandler = {
  name: 'lint',
  description:
    'Unified lint aggregator. Runs knowledge / rules / templates per-kind doctors in one pass. `--since <ref>` annotates the run with diff-aware metadata (lints themselves run whole-graph and emit a notice).',
  usage:
    'shrk lint [--kind knowledge|rules|templates|all] [--strict] [--fix-preview] [--since <ref>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const kind = parseKind(flagString(args, 'kind'));
    const strict = flagBool(args, 'strict');
    const fixPreview = flagBool(args, 'fix-preview');
    const wantJson = flagBool(args, 'json');
    // Diff-aware metadata. The per-kind lints operate on the
    // whole asset graph (entries / rules / templates), so `--since`
    // is recorded in the report but does not restrict the lint. Add
    // a one-line notice in the text render so the user knows.
    const sinceRaw = args.flags.get('since');
    const since =
      typeof sinceRaw === 'string'
        ? collectChangedPaths({ cwd, ref: sinceRaw })
        : sinceRaw === true
          ? collectChangedPaths({ cwd })
          : null;

    const knowledgePart =
      kind === 'all' || kind === 'knowledge'
        ? runKnowledgeLint(inspection, { fixPreview })
        : null;
    const rulesPart =
      kind === 'all' || kind === 'rules' ? runRulesLint(inspection, { strict }) : null;
    const templatesPart =
      kind === 'all' || kind === 'templates'
        ? runTemplatesLint(inspection, { strict })
        : null;

    // Knowledge lint emits info/warning only; we no longer carry a
    // hardcoded errors=0 through the totals. Errors come from rules and
    // templates whose underlying doctors actually emit error severity.
    const errors = (rulesPart?.errors ?? 0) + (templatesPart?.errors ?? 0);
    const warnings =
      (knowledgePart?.warnings ?? 0) +
      (rulesPart?.warnings ?? 0) +
      (templatesPart?.warnings ?? 0);
    const ready =
      errors === 0 && (!strict || warnings === 0);

    if (wantJson) {
      process.stdout.write(
        asJson({
          // Schema v2: knowledge.errors field removed (was hardcoded
          // to 0); totals now reflect rules+templates only.
          schema: 'sharkcraft.lint/v2',
          generatedAt: new Date().toISOString(),
          kind,
          strict,
          fixPreview,
          totals: { errors, warnings, ready },
          ...(since
            ? {
                since: {
                  ref: since.ref,
                  available: since.isAvailable,
                  changedPaths: since.changed.length,
                  note: 'whole-graph lints ignore --since; reported here for tooling parity',
                  ...(since.error ? { error: since.error } : {}),
                },
              }
            : {}),
          ...(knowledgePart ? { knowledge: knowledgePart } : {}),
          ...(rulesPart ? { rules: rulesPart } : {}),
          ...(templatesPart ? { templates: templatesPart } : {}),
        }) + '\n',
      );
      return ready ? 0 : 1;
    }

    process.stdout.write(header(`Lint — ${kind}${strict ? ' (strict)' : ''}`));
    if (since) {
      process.stdout.write(
        `  --since ${since.ref}${since.isAvailable ? ` (${since.changed.length} changed)` : ' (unavailable)'} — whole-graph lints run regardless\n\n`,
      );
    }
    if (knowledgePart) {
      process.stdout.write(
        `  knowledge:   ${knowledgePart.warnings} warnings (${knowledgePart.findings} findings)\n`,
      );
    }
    if (rulesPart) {
      process.stdout.write(
        `  rules:       ${rulesPart.errors} errors, ${rulesPart.warnings} warnings (${rulesPart.findings} findings)\n`,
      );
    }
    if (templatesPart) {
      process.stdout.write(
        `  templates:   ${templatesPart.errors} errors, ${templatesPart.warnings} warnings across ${templatesPart.totalTemplates} template(s)\n`,
      );
    }
    process.stdout.write(
      `\n  totals:      ${errors} errors, ${warnings} warnings\n`,
    );
    if (ready) {
      process.stdout.write('\nClean. ✓\n');
    } else {
      process.stdout.write(
        '\nIssues found. Drill in:\n' +
          (knowledgePart && knowledgePart.warnings > 0
            ? '  $ shrk knowledge lint --fix-preview\n'
            : '') +
          (rulesPart && (rulesPart.errors > 0 || rulesPart.warnings > 0)
            ? '  $ shrk rules doctor --strict\n'
            : '') +
          (templatesPart && (templatesPart.errors > 0 || templatesPart.warnings > 0)
            ? '  $ shrk templates drift --min-severity warning\n'
            : ''),
      );
    }
    return ready ? 0 : 1;
  },
};

/**
 * `errors` removed. `KnowledgeLintSeverity` emits `info` / `warning`
 * only today; hard-failures short-circuit before lint runs (load
 * failure, config invalid). A hardcoded `errors = 0` was lying;
 * widening the enum with an error class that never fires would be
 * worse.
 */
interface IKnowledgePartSummary {
  warnings: number;
  findings: number;
  categories: Record<string, number>;
  staleReferences: number;
  fixPreview?: unknown;
}

function runKnowledgeLint(
  inspection: Awaited<ReturnType<typeof inspectSharkcraft>>,
  options: { fixPreview: boolean },
): IKnowledgePartSummary {
  const stale = buildKnowledgeStaleReport(inspection);
  const staleIds = new Set<string>();
  for (const c of stale.referenceChecks) {
    if (
      c.outcome === ReferenceCheckOutcome.Stale ||
      c.outcome === ReferenceCheckOutcome.Missing
    ) {
      staleIds.add(c.entryId);
    }
  }
  const report = lintKnowledge(inspection.knowledgeEntries, {
    staleReferenceEntryIds: [...staleIds],
  });
  const warnings = report.findings.filter(
    (f) => f.severity === 'warning' && !f.advisory,
  ).length;
  const categories: Record<string, number> = {};
  for (const f of report.findings) {
    categories[f.category] = (categories[f.category] ?? 0) + 1;
  }
  const summary: IKnowledgePartSummary = {
    warnings,
    findings: report.findings.length,
    categories,
    staleReferences: stale.referenceChecks.filter(
      (c) =>
        c.outcome === ReferenceCheckOutcome.Stale ||
        c.outcome === ReferenceCheckOutcome.Missing,
    ).length,
  };
  if (options.fixPreview) {
    summary.fixPreview = buildKnowledgeLintFixPreview(report);
  }
  return summary;
}

interface IRulesPartSummary {
  errors: number;
  warnings: number;
  findings: number;
  byCode: Record<string, number>;
}

function runRulesLint(
  inspection: Awaited<ReturnType<typeof inspectSharkcraft>>,
  _options: { strict: boolean },
): IRulesPartSummary {
  const rules = inspection.ruleService.list();
  const knownVerificationIds = new Set(
    (inspection.config?.verificationCommands ?? []).map((c) => c.id),
  );
  const report = diagnoseRuleQuality(rules, {}, { knownVerificationIds });
  const byCode: Record<string, number> = {};
  for (const f of report.findings) {
    byCode[f.code] = (byCode[f.code] ?? 0) + 1;
  }
  return {
    errors: report.summary.errors,
    warnings: report.summary.warnings,
    findings: report.findings.length,
    byCode,
  };
}

interface ITemplatesPartSummary {
  totalTemplates: number;
  errors: number;
  warnings: number;
  passing: number;
  byCode: Record<string, number>;
}

function runTemplatesLint(
  inspection: Awaited<ReturnType<typeof inspectSharkcraft>>,
  _options: { strict: boolean },
): ITemplatesPartSummary {
  const drift = buildTemplateDriftReport(inspection, {});
  let errors = 0;
  let warnings = 0;
  let passing = 0;
  const byCode: Record<string, number> = {};
  for (const e of drift.entries) {
    if (e.status === TemplateDriftStatus.Pass) passing++;
    for (const i of e.issues) {
      if (i.severity === 'error') errors++;
      else if (i.severity === 'warning') warnings++;
      byCode[i.code] = (byCode[i.code] ?? 0) + 1;
    }
  }
  return {
    totalTemplates: drift.entries.length,
    errors,
    warnings,
    passing,
    byCode,
  };
}

// Silence unused-imports warnings if optional drill-in paths get rolled back.
void flagList;
