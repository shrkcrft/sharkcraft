/**
 * `shrk feedback` family (ingest|summarize|actions|convert-to-backlog),
 * plus pack-contributed rules and `feedback rules list|doctor`.
 *
 * Deterministic — no AI. Reads freeform feedback markdown/text and emits
 * structured findings.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  FeedbackBucket,
  ingestFeedbackFile,
  inspectSharkcraft,
  loadFeedbackRules,
  renderFeedbackBacklog,
  type IFeedbackRule,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';

function ingestPositional(args: ParsedArgs): string | undefined {
  return args.positional[0];
}

async function loadRulesIfRequested(
  args: ParsedArgs,
  cwd: string,
): Promise<readonly IFeedbackRule[]> {
  if (!flagBool(args, 'with-pack-rules')) return [];
  const inspection = await inspectSharkcraft({ cwd });
  return loadFeedbackRules(inspection);
}

export const feedbackIngestCommand: ICommandHandler = {
  name: 'ingest',
  description: 'Parse a feedback file into structured findings. Supports pack rules. Read-only.',
  usage: 'shrk feedback ingest <file> [--with-pack-rules] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const file = ingestPositional(args);
    if (!file) {
      process.stderr.write('Usage: shrk feedback ingest <file>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    try {
      const rules = await loadRulesIfRequested(args, cwd);
      const report = ingestFeedbackFile(cwd, file, { rules });
      if (flagBool(args, 'json')) {
        process.stdout.write(asJson(report) + '\n');
        return 0;
      }
      process.stdout.write(header(`Feedback ingestion (${report.totalFindings})`));
      for (const b of Object.values(FeedbackBucket)) {
        process.stdout.write(`  ${b}: ${report.counts[b] ?? 0}\n`);
      }
      process.stdout.write('\nFindings:\n');
      for (const f of report.findings) {
        process.stdout.write(`  • [${f.bucket}/${f.severity}] ${f.text}\n`);
        if (f.targetArea) process.stdout.write(`        target: ${f.targetArea}\n`);
      }
      return 0;
    } catch (e) {
      process.stderr.write(`Failed to ingest: ${(e as Error).message}\n`);
      return 1;
    }
  },
};

export const feedbackSummarizeCommand: ICommandHandler = {
  name: 'summarize',
  description: 'Produce a short summary of a feedback file (counts + top tags). Read-only.',
  usage: 'shrk feedback summarize <file> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const file = ingestPositional(args);
    if (!file) {
      process.stderr.write('Usage: shrk feedback summarize <file>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const report = ingestFeedbackFile(cwd, file);
    const tagCounts = new Map<string, number>();
    for (const f of report.findings) {
      for (const t of f.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
    const sortedTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]);
    const summary = {
      schema: 'sharkcraft.feedback-summary/v1',
      sourceFile: file,
      totals: report.counts,
      topTags: sortedTags.slice(0, 10).map(([tag, count]) => ({ tag, count })),
      nextRound: report.suggestedNextRound,
    };
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(summary) + '\n');
      return 0;
    }
    process.stdout.write(header('Feedback summary'));
    for (const [k, v] of Object.entries(summary.totals)) {
      process.stdout.write(`  ${k}: ${v}\n`);
    }
    if (summary.topTags.length > 0) {
      process.stdout.write('\nTop tags:\n');
      for (const t of summary.topTags) process.stdout.write(`  ${t.tag}: ${t.count}\n`);
    }
    if (summary.nextRound.length > 0) {
      process.stdout.write('\nSuggested next round:\n');
      for (const n of summary.nextRound) process.stdout.write(`  • ${n}\n`);
    }
    return 0;
  },
};

export const feedbackActionsCommand: ICommandHandler = {
  name: 'actions',
  description:
    'Render the suggested follow-up commands extracted from a feedback file. Default emits the richer v2 schema; pass --legacy for the v1 output.',
  usage: 'shrk feedback actions <file> [--with-pack-rules] [--legacy] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const file = ingestPositional(args);
    if (!file) {
      process.stderr.write('Usage: shrk feedback actions <file>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    // Default to v2 shape.
    if (!flagBool(args, 'legacy')) {
      const { buildFeedbackActionsReport, inspectSharkcraft } = await import('@shrkcrft/inspector');
      const inspection = await inspectSharkcraft({ cwd });
      const v2 = buildFeedbackActionsReport(inspection, file);
      if (flagBool(args, 'json')) {
        process.stdout.write(asJson(v2) + '\n');
        return 0;
      }
      process.stdout.write(header(`Feedback actions v2 (${v2.actions.length})`));
      for (const a of v2.actions) {
        process.stdout.write(
          `• [${a.priority}] [${a.category}] (${a.origin}) ${a.targetArea} — ${a.paraphrase ?? ''}\n`,
        );
        for (const c of a.recommendedCommands) process.stdout.write(`    $ ${c}\n`);
      }
      return 0;
    }
    const rules = await loadRulesIfRequested(args, cwd);
    const report = ingestFeedbackFile(cwd, file, { rules });
    const seen = new Set<string>();
    const actions: { text: string; commands: readonly string[]; target?: string }[] = [];
    for (const f of report.findings) {
      const key = f.text + '|' + f.suggestedCommands.join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      if (f.suggestedCommands.length > 0) {
        actions.push({
          text: f.text,
          commands: f.suggestedCommands,
          ...(f.targetArea ? { target: f.targetArea } : {}),
        });
      }
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ schema: 'sharkcraft.feedback-actions/v1', actions }) + '\n');
      return 0;
    }
    process.stdout.write(header(`Feedback actions (${actions.length})`));
    for (const a of actions) {
      process.stdout.write(`• ${a.text}\n`);
      for (const c of a.commands) process.stdout.write(`    $ ${c}\n`);
    }
    return 0;
  },
};

export const feedbackConvertToBacklogCommand: ICommandHandler = {
  name: 'convert-to-backlog',
  description: 'Render a feedback file as a markdown backlog under .sharkcraft/reports/.',
  usage: 'shrk feedback convert-to-backlog <file> --output <path>',
  async run(args: ParsedArgs): Promise<number> {
    const file = ingestPositional(args);
    const out = flagString(args, 'output');
    if (!file) {
      process.stderr.write('Usage: shrk feedback convert-to-backlog <file> [--output <path>]\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const report = ingestFeedbackFile(cwd, file);
    const md = renderFeedbackBacklog(report);
    if (!out) {
      process.stdout.write(md);
      return 0;
    }
    const abs = nodePath.isAbsolute(out) ? out : nodePath.join(cwd, out);
    mkdirSync(nodePath.dirname(abs), { recursive: true });
    writeFileSync(abs, md, 'utf8');
    process.stdout.write(`Backlog written → ${abs}\n`);
    return 0;
  },
};

// `feedback rules` subcommands.

export const feedbackRulesListCommand: ICommandHandler = {
  name: 'list',
  description: 'List local + pack-contributed feedback rules. Read-only.',
  usage: 'shrk feedback rules list [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const rules = await loadFeedbackRules(inspection);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ count: rules.length, rules }) + '\n');
      return 0;
    }
    process.stdout.write(header(`Feedback rules (${rules.length})`));
    for (const r of rules) {
      process.stdout.write(`  ${r.id.padEnd(40)} ${r.title}\n`);
      const kws = [...(r.keywords ?? []), ...(r.phrases ?? [])].slice(0, 5).join(', ');
      if (kws) process.stdout.write(`       keywords: ${kws}\n`);
      if (r.targetArea) process.stdout.write(`       target:   ${r.targetArea}\n`);
    }
    return 0;
  },
};

export const feedbackRulesDoctorCommand: ICommandHandler = {
  name: 'doctor',
  description: 'Validate local + pack feedback rules. Read-only.',
  usage: 'shrk feedback rules doctor [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const rules = await loadFeedbackRules(inspection);
    const errors: { id: string; message: string }[] = [];
    const warnings: { id: string; message: string }[] = [];
    const ids = new Set<string>();
    for (const r of rules) {
      if (!r.id || ids.has(r.id)) {
        errors.push({ id: r.id ?? '?', message: r.id ? 'duplicate id' : 'missing id' });
      } else {
        ids.add(r.id);
      }
      const fragments =
        (r.keywords?.length ?? 0) + (r.phrases?.length ?? 0) + (r.regexes?.length ?? 0);
      if (fragments === 0) {
        errors.push({ id: r.id, message: 'rule has no keywords/phrases/regexes — will never match' });
      }
      if (!r.title) warnings.push({ id: r.id, message: 'no title' });
      if (!r.targetArea) warnings.push({ id: r.id, message: 'no targetArea — uses rule id as fallback' });
      if (
        (!r.suggestedActions || r.suggestedActions.length === 0) &&
        (!r.relatedCommands || r.relatedCommands.length === 0)
      ) {
        warnings.push({ id: r.id, message: 'no suggestedActions / relatedCommands' });
      }
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          schema: 'sharkcraft.feedback-rule-doctor/v1',
          total: rules.length,
          errors,
          warnings,
          passed: errors.length === 0,
        }) + '\n',
      );
      return errors.length > 0 ? 1 : 0;
    }
    process.stdout.write(header(`Feedback rule doctor (${rules.length} rules)`));
    process.stdout.write(`errors: ${errors.length}\nwarnings: ${warnings.length}\n`);
    for (const e of errors) process.stdout.write(`  ERROR   ${e.id}: ${e.message}\n`);
    for (const w of warnings) process.stdout.write(`  WARN    ${w.id}: ${w.message}\n`);
    return errors.length > 0 ? 1 : 0;
  },
};

// Feedback v2 outputs: backlog, prompt, plan.
export const feedbackBacklogCommand: ICommandHandler = {
  name: 'backlog',
  description: 'Render a feedback file as a priority-grouped markdown backlog (v2).',
  usage: 'shrk feedback backlog <file> [--json] [--output <path>]',
  async run(args: ParsedArgs): Promise<number> {
    const file = ingestPositional(args);
    if (!file) {
      process.stderr.write('Usage: shrk feedback backlog <file>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const { buildFeedbackBacklogReport, inspectSharkcraft } = await import('@shrkcrft/inspector');
    const inspection = await inspectSharkcraft({ cwd });
    const report = buildFeedbackBacklogReport(inspection, file);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(report) + '\n');
      return 0;
    }
    process.stdout.write(report.markdown);
    return 0;
  },
};

export const feedbackPromptCommand: ICommandHandler = {
  name: 'prompt',
  description: 'Render a feedback file as a Markdown implementation prompt (v2).',
  usage: 'shrk feedback prompt <file> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const file = ingestPositional(args);
    if (!file) {
      process.stderr.write('Usage: shrk feedback prompt <file>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const { buildFeedbackPromptReport, inspectSharkcraft } = await import('@shrkcrft/inspector');
    const inspection = await inspectSharkcraft({ cwd });
    const report = buildFeedbackPromptReport(inspection, file);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(report) + '\n');
      return 0;
    }
    process.stdout.write(report.markdown);
    return 0;
  },
};

export const feedbackPlanCommand: ICommandHandler = {
  name: 'plan',
  description: 'Render a feedback file as an ordered implementation plan with validation gates (v2).',
  usage: 'shrk feedback plan <file> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const file = ingestPositional(args);
    if (!file) {
      process.stderr.write('Usage: shrk feedback plan <file>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const { buildFeedbackPlanReport, inspectSharkcraft } = await import('@shrkcrft/inspector');
    const inspection = await inspectSharkcraft({ cwd });
    const report = buildFeedbackPlanReport(inspection, file);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(report) + '\n');
      return 0;
    }
    process.stdout.write(`=== Feedback plan ===\n`);
    for (const a of report.orderedActions) {
      process.stdout.write(
        `  [${a.priority}] ${a.targetArea} — ${a.paraphrase ?? a.originalExcerpt.slice(0, 80)}…\n`,
      );
      for (const c of a.recommendedCommands) process.stdout.write(`      $ ${c}\n`);
    }
    process.stdout.write('\nValidation gates:\n');
    for (const g of report.validationGates) process.stdout.write(`  $ ${g}\n`);
    return 0;
  },
};
