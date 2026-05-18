import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  AdoptionCategory,
  AdoptionCheckpointStatus,
  AdoptionKind,
  archivePreviousAdoptionOutputs,
  buildAdoptionCheck,
  buildAdoptionMergePreview,
  buildAdoptionReport,
  buildOnboardAdoptionDiff,
  buildOnboardingAdoptionPlan,
  buildOnboardingDiff,
  buildOnboardingPlan,
  computeAdoptionFreshness,
  evaluateAdoptionCheckpoint,
  hashDiffBody,
  importAgentRulesForOnboarding,
  inspectSharkcraft,
  readAdoptionCheckpoint,
  readAdoptionState,
  recordAdoptionCheckpoint,
  renderAdoptionMergePreviewHtml,
  renderAdoptionMergePreviewMarkdown,
  renderAdoptionMergePreviewText,
  renderAdoptionPatch,
  renderAdoptionPlanMarkdown,
  renderAdoptionReportHtml,
  renderAdoptionReportJson,
  renderAdoptionReportMarkdown,
  renderAdoptionReportText,
  renderOnboardAdoptionDiff,
  renderOnboardingDiff,
  renderOnboardingReport,
  validatePatchTargets,
  writeAdoptionPatch,
  writeOnboardingDrafts,
  AdoptionCheckResult,
  AdoptionFreshnessStatus,
  type IAdoptionPatchTarget,
  type IAdoptionPlan,
  type IImportedAgentRulesBundle,
  type IOnboardAdoptionDiff,
  type OnboardAdoptionDiffFormat,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagNumber,
  flagString,
  flagList,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';

export const onboardCommand: ICommandHandler = {
  name: 'onboard',
  description:
    'Analyze an existing repository and produce a SharkCraft onboarding plan (rules / paths / templates / boundaries / pipelines + readiness estimate). Default is dry-run; `--write-drafts` writes advisory drafts under sharkcraft/onboarding/ (never overwrites rules.ts / paths.ts / templates.ts). `--scaffold-templates` drafts runnable template bodies. `--import-agents` parses AGENTS.md / CLAUDE.md / .cursor/rules into a draft. `--diff` compares the plan against the live config.',
  usage:
    'shrk [--cwd <dir>] onboard [--dry-run] [--write-drafts] [--scaffold-templates] [--import-agents] [--diff] [--preset <id>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    // Dispatch sub-verb: `shrk onboard adopt [...]`.
    if (args.positional[0] === 'adopt') {
      const sliced = { ...args, positional: args.positional.slice(1) };
      return runOnboardAdopt(sliced);
    }
    const cwd = resolveCwd(args);
    const writeDrafts = flagBool(args, 'write-drafts');
    const scaffoldTemplates = flagBool(args, 'scaffold-templates');
    const importAgents = flagBool(args, 'import-agents');
    const diffMode = flagBool(args, 'diff');
    const dryRun = flagBool(args, 'dry-run') || !writeDrafts;
    const preferredPreset = flagString(args, 'preset');
    const asJsonOut = flagBool(args, 'json');

    const inspection = await inspectSharkcraft({ cwd });
    const plan = buildOnboardingPlan(inspection, {
      ...(preferredPreset ? { preferredPreset } : {}),
      ...(scaffoldTemplates ? { scaffoldTemplates: true } : {}),
    });

    let importedAgentRules: IImportedAgentRulesBundle | undefined;
    if (importAgents) {
      importedAgentRules = importAgentRulesForOnboarding({ projectRoot: cwd });
    }

    let written: ReturnType<typeof writeOnboardingDrafts> | undefined;
    if (writeDrafts) {
      written = writeOnboardingDrafts(plan, {
        projectRoot: cwd,
        ...(importedAgentRules ? { importedAgentRules } : {}),
      });
    }

    const diff = diffMode ? buildOnboardingDiff(inspection, plan) : undefined;

    if (asJsonOut) {
      process.stdout.write(
        asJson({
          mode: diffMode
            ? 'diff'
            : writeDrafts
              ? 'write-drafts'
              : 'dry-run',
          plan,
          ...(diff ? { diff } : {}),
          ...(importedAgentRules ? { importedAgentRules } : {}),
          written: written
            ? {
                outDir: written.outDir,
                files: written.files.map((f) => ({
                  path: f.path,
                  bytes: f.bytes,
                })),
              }
            : undefined,
        }) + '\n',
      );
      return 0;
    }

    if (diffMode && diff) {
      process.stdout.write(renderOnboardingDiff(diff));
      return 0;
    }

    // Human-readable output.
    process.stdout.write(header('SharkCraft onboarding'));
    process.stdout.write(
      kv(
        'mode',
        diffMode ? 'diff' : writeDrafts ? 'write-drafts' : 'dry-run',
      ) + '\n',
    );
    process.stdout.write(
      kv(
        'project',
        plan.projectSummary.projectName ?? plan.projectSummary.projectRoot,
      ) + '\n',
    );
    process.stdout.write(
      kv(
        'profiles',
        plan.projectSummary.profiles.length
          ? plan.projectSummary.profiles.join(', ')
          : 'none',
      ) + '\n',
    );
    process.stdout.write(
      kv(
        'readiness',
        `${plan.readiness.current} (${plan.readiness.currentScore}) → ${plan.readiness.expected} (${plan.readiness.expectedScore})`,
      ) + '\n',
    );
    process.stdout.write('\n');

    if (plan.recommendedPresets.length) {
      process.stdout.write('Recommended presets:\n');
      for (const r of plan.recommendedPresets) {
        process.stdout.write(
          `  • ${r.preset.id.padEnd(24)} ${r.confidence.padEnd(8)} ${r.preset.title}\n`,
        );
      }
      process.stdout.write('\n');
    }
    if (plan.inferredPathConventions.length) {
      process.stdout.write(
        `Path conventions inferred: ${plan.inferredPathConventions.length}\n`,
      );
      for (const p of plan.inferredPathConventions) {
        process.stdout.write(`  • ${p.id} — ${p.title}\n`);
      }
      process.stdout.write('\n');
    }
    if (plan.inferredVerificationCommands.length) {
      process.stdout.write(
        `Verification commands inferred: ${plan.inferredVerificationCommands.length}\n`,
      );
      for (const v of plan.inferredVerificationCommands) {
        process.stdout.write(`  • ${v.id.padEnd(14)} ${v.command}\n`);
      }
      process.stdout.write('\n');
    }
    if (plan.inferredBoundaryRules.length) {
      process.stdout.write(
        `Boundary rules inferred: ${plan.inferredBoundaryRules.length}\n`,
      );
      for (const b of plan.inferredBoundaryRules) {
        process.stdout.write(`  • ${b.id} (${b.severity}) — ${b.title}\n`);
      }
      process.stdout.write('\n');
    }
    if (plan.inferredTemplateCandidates.length) {
      process.stdout.write(
        `Template candidates: ${plan.inferredTemplateCandidates.length}\n`,
      );
      for (const t of plan.inferredTemplateCandidates) {
        const scaffoldTag = t.scaffold ? ' [runnable draft]' : '';
        process.stdout.write(
          `  • ${t.id.padEnd(22)} ${t.confidence.padEnd(7)} ${t.name}${scaffoldTag}\n`,
        );
      }
      process.stdout.write('\n');
    }
    if (plan.inferredRules.length) {
      process.stdout.write(`Rules inferred: ${plan.inferredRules.length}\n`);
      for (const r of plan.inferredRules) {
        process.stdout.write(`  • ${r.id.padEnd(28)} ${r.priority.padEnd(8)} ${r.title}\n`);
      }
      process.stdout.write('\n');
    }
    if (plan.inferredPipelines.length) {
      process.stdout.write(`Pipelines inferred: ${plan.inferredPipelines.length}\n`);
      for (const p of plan.inferredPipelines) {
        process.stdout.write(`  • ${p.id.padEnd(18)} ${p.title}\n`);
      }
      process.stdout.write('\n');
    }
    if (plan.detectedInstructionFiles.length) {
      process.stdout.write('Existing instruction files:\n');
      for (const f of plan.detectedInstructionFiles) {
        process.stdout.write(`  • ${f.path}  →  ${f.importCommand}\n`);
      }
      process.stdout.write('\n');
    }
    if (plan.monorepoSummary) {
      const m = plan.monorepoSummary;
      process.stdout.write(`Monorepo summary:\n`);
      process.stdout.write(
        `  apps: ${m.apps.length}, packages: ${m.packages.length}, libs: ${m.libs.length}\n`,
      );
      for (const n of m.notes) process.stdout.write(`  - ${n}\n`);
      if (m.boundaryCandidates.length) {
        process.stdout.write(`  boundary candidates: ${m.boundaryCandidates.length}\n`);
      }
      process.stdout.write('\n');
    }
    if (importedAgentRules) {
      process.stdout.write(
        `Imported agent rules: ${importedAgentRules.entries.length} entr${importedAgentRules.entries.length === 1 ? 'y' : 'ies'}\n`,
      );
      for (const s of importedAgentRules.perSource) {
        process.stdout.write(
          `  • ${s.kind.padEnd(13)} ${s.path.padEnd(20)} ${s.entryCount} entr${s.entryCount === 1 ? 'y' : 'ies'}\n`,
        );
      }
      if (importedAgentRules.warnings.length) {
        for (const w of importedAgentRules.warnings) {
          process.stdout.write(`  ! ${w}\n`);
        }
      }
      process.stdout.write('\n');
    }
    if (plan.risks.length) {
      process.stdout.write('Risks / warnings:\n');
      for (const r of plan.risks) process.stdout.write(`  ! ${r}\n`);
      process.stdout.write('\n');
    }
    process.stdout.write('Next:\n');
    for (const c of plan.nextCommands) process.stdout.write(`  $ ${c}\n`);
    process.stdout.write('\n');

    if (writeDrafts && written) {
      process.stdout.write(`Wrote ${written.files.length} draft file(s) to:\n  ${written.outDir}\n`);
      for (const f of written.files) {
        process.stdout.write(`  + ${f.path} (${f.bytes} bytes)\n`);
      }
    } else if (dryRun) {
      process.stdout.write(
        'Dry-run only. Re-run with `--write-drafts` to write advisory drafts.\n',
      );
    }
    return 0;
  },
};

// ─── shrk onboard adopt ─────────────────────────────────────────────────────

const CONFIDENCE_VALUES = new Set(['high', 'medium', 'low']);

const KIND_MAP: Record<string, AdoptionKind> = {
  rules: AdoptionKind.Rule,
  rule: AdoptionKind.Rule,
  paths: AdoptionKind.Path,
  path: AdoptionKind.Path,
  verifications: AdoptionKind.Verification,
  verification: AdoptionKind.Verification,
  templates: AdoptionKind.Template,
  template: AdoptionKind.Template,
  boundaries: AdoptionKind.Boundary,
  boundary: AdoptionKind.Boundary,
  pipelines: AdoptionKind.Pipeline,
  pipeline: AdoptionKind.Pipeline,
};

function parseKindList(values: readonly string[]): AdoptionKind[] {
  const out = new Set<AdoptionKind>();
  for (const v of values) {
    const k = KIND_MAP[v.toLowerCase()];
    if (!k) {
      process.stderr.write(`Unknown kind: "${v}" — expected one of rules|paths|verifications|templates|boundaries|pipelines\n`);
      continue;
    }
    out.add(k);
  }
  return [...out];
}

async function runOnboardAdopt(args: ParsedArgs): Promise<number> {
  const subVerb = args.positional[0];
  if (subVerb === 'status') return runAdoptStatus(args);
  if (subVerb === 'regenerate') return runAdoptRegenerate(args);
  if (subVerb === 'merge-preview') return runAdoptMergePreview(args);
  if (subVerb === 'report') return runAdoptReport(args);
  if (subVerb === 'check') return runAdoptCheck(args);
  if (subVerb === 'diff') return runAdoptDiff(args);
  const reviewMode = subVerb === 'review';
  const cwd = resolveCwd(args);
  const inspection = await inspectSharkcraft({ cwd });
  const plan = buildOnboardingPlan(inspection, {});

  const confidenceFlag = flagString(args, 'confidence') ?? 'high';
  if (!CONFIDENCE_VALUES.has(confidenceFlag)) {
    process.stderr.write(`Invalid --confidence: "${confidenceFlag}". Use high|medium|low.\n`);
    return 2;
  }
  const include = parseKindList(flagList(args, 'include'));
  const exclude = parseKindList(flagList(args, 'exclude'));
  const adoption = buildOnboardingAdoptionPlan({
    inspection,
    plan,
    confidence: confidenceFlag as 'high' | 'medium' | 'low',
    ...(include.length > 0 ? { include } : {}),
    ...(exclude.length > 0 ? { exclude } : {}),
  });

  if (reviewMode) {
    return outputAdoptionReview(args, adoption);
  }

  const wantJson = flagBool(args, 'json');
  const wantWritePatch = flagBool(args, 'write-patch');
  const dryRun = flagBool(args, 'dry-run') || !wantWritePatch;

  if (wantWritePatch) {
    const diffFormat = (flagString(args, 'diff-format') ?? 'pseudo') as 'pseudo' | 'unified';
    if (diffFormat !== 'pseudo' && diffFormat !== 'unified') {
      process.stderr.write(`Invalid --diff-format "${diffFormat}". Use pseudo|unified.\n`);
      return 2;
    }
    const noAutoRegen = flagBool(args, 'no-auto-regenerate');
    const written = writeAdoptionPatch({
      projectRoot: cwd,
      plan: adoption,
      format: diffFormat,
      noAutoRegenerate: noAutoRegen,
    });
    // Record the adoption checkpoint so the diff/status flow can
    // tell whether anything drifted since the last write.
    try {
      const diff = buildOnboardAdoptionDiff(inspection);
      const canonical = renderOnboardAdoptionDiff(diff, 'json');
      const { targets, drafts } = onboardCheckpointArtifacts(diff);
      recordAdoptionCheckpoint({
        projectRoot: cwd,
        kind: 'onboard',
        command: 'shrk onboard adopt --write-patch',
        diffHash: hashDiffBody(canonical),
        targets,
        drafts,
      });
    } catch {
      // Best-effort — never block --write-patch on checkpoint write failure.
    }
    if (wantJson) {
      process.stdout.write(
        asJson({
          mode: 'write-patch',
          format: written.format,
          outDir: written.outDir,
          files: written.files.map((f) => ({ path: f.path, bytes: f.bytes })),
          targets: written.targets,
          summary: adoption.summary,
          statePath: written.statePath,
          archived: written.archived,
          wasStale: written.wasStale,
        }) + '\n',
      );
      return 0;
    }
    process.stdout.write(header(`Onboarding adoption — patch written (${written.format})`));
    process.stdout.write(kv('outDir', written.outDir) + '\n');
    for (const f of written.files) process.stdout.write(`  + ${f.path} (${f.bytes} bytes)\n`);
    if (written.wasStale && written.archived.length > 0) {
      process.stdout.write(`\n! Previous patch was stale. Archived ${written.archived.length} file(s):\n`);
      for (const a of written.archived) process.stdout.write(`  • ${a}\n`);
    } else if (written.wasStale && noAutoRegen) {
      process.stdout.write('\n! Previous patch was stale, but --no-auto-regenerate kept it.\n');
    }
    if (written.format === 'unified') {
      process.stdout.write('\nTargets:\n');
      for (const t of written.targets) {
        const tag = t.existed ? 'append' : 'create';
        process.stdout.write(`  • ${tag.padEnd(7)} ${t.relativePath}${t.beforeHash ? '  hash=' + t.beforeHash.slice(0, 12) : ''}\n`);
      }
    }
    process.stdout.write(
      `\nReview the patch before applying:\n  git apply ${written.outDir}/adopt.patch\n`,
    );
    process.stdout.write(`Status:\n  shrk onboard adopt status\n`);
    return 0;
  }

  if (wantJson) {
    process.stdout.write(
      asJson({
        mode: dryRun ? 'dry-run' : 'preview',
        confidence: adoption.confidence,
        included: adoption.included,
        excluded: adoption.excluded,
        summary: adoption.summary,
        items: adoption.items,
      }) + '\n',
    );
    return 0;
  }

  process.stdout.write(header('Onboarding adoption (dry-run)'));
  printAdoptionSummary(adoption);
  process.stdout.write(
    '\nDry-run only. Re-run with `--write-patch` to write a pseudo-patch under sharkcraft/onboarding/adoption/.\n',
  );
  return 0;
}

function outputAdoptionReview(args: ParsedArgs, adoption: IAdoptionPlan): number {
  // If a previously-written summary exists, validate target hashes so we can
  // warn when target files changed between plan-time and review-time.
  const cwd = resolveCwd(args);
  const summaryPath = nodePath.join(cwd, 'sharkcraft', 'onboarding', 'adoption', 'adopt-summary.json');
  let targets: IAdoptionPatchTarget[] = [];
  let changedTargets: IAdoptionPatchTarget[] = [];
  if (existsSync(summaryPath)) {
    try {
      const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as {
        targets?: IAdoptionPatchTarget[];
      };
      if (Array.isArray(summary.targets)) {
        targets = summary.targets;
        const v = validatePatchTargets(cwd, targets);
        changedTargets = [...v.changed];
      }
    } catch {
      // Ignore — review still works without target validation.
    }
  }
  if (flagBool(args, 'json')) {
    process.stdout.write(
      asJson({
        confidence: adoption.confidence,
        summary: adoption.summary,
        byCategory: adoption.byCategory,
        patchTargets: targets,
        changedTargets,
      }) + '\n',
    );
    return 0;
  }
  process.stdout.write(header('Onboarding adoption — review'));
  printAdoptionSummary(adoption);
  if (changedTargets.length > 0) {
    process.stdout.write('\n! Target files changed since the patch was written:\n');
    for (const t of changedTargets) {
      process.stdout.write(`   • ${t.relativePath}  (was hash=${t.beforeHash?.slice(0, 12) ?? '?'})\n`);
    }
    process.stdout.write(
      '   Re-run `shrk onboard adopt --write-patch --diff-format unified` to regenerate.\n',
    );
  }
  for (const cat of Object.values(AdoptionCategory)) {
    const items = adoption.byCategory[cat];
    if (items.length === 0) continue;
    process.stdout.write(`\n## ${cat}\n`);
    for (const it of items) {
      process.stdout.write(
        `  • ${it.kind.padEnd(13)} ${it.id.padEnd(30)} ${it.title}\n`,
      );
      process.stdout.write(`      reason: ${it.reason}\n`);
    }
  }
  return 0;
}

function printAdoptionSummary(adoption: IAdoptionPlan): void {
  process.stdout.write(kv('confidence', adoption.confidence) + '\n');
  process.stdout.write(
    kv('included', adoption.included.length ? adoption.included.join(',') : '(none)') + '\n',
  );
  if (adoption.excluded.length > 0) {
    process.stdout.write(kv('excluded', adoption.excluded.join(',')) + '\n');
  }
  process.stdout.write('\nCategory counts:\n');
  for (const cat of Object.values(AdoptionCategory)) {
    process.stdout.write(`  ${cat.padEnd(20)} ${adoption.summary[cat]}\n`);
  }
}

// ─── shrk onboard adopt status / regenerate / merge-preview / report / check ─

async function runAdoptStatus(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const state = readAdoptionState(cwd);
  const freshness = computeAdoptionFreshness(cwd, state);
  const adoptionDir = nodePath.join(cwd, 'sharkcraft', 'onboarding', 'adoption');
  const patchExists = existsSync(nodePath.join(adoptionDir, 'adopt.patch'));
  const summaryExists = existsSync(nodePath.join(adoptionDir, 'adopt-summary.json'));
  const stateExists = state !== null;
  // Checkpoint evaluation; optional --max-age-days.
  const checkpointRead = readAdoptionCheckpoint(cwd, 'onboard');
  let checkpointEval: ReturnType<typeof evaluateAdoptionCheckpoint> | null = null;
  if (checkpointRead.checkpoint) {
    const inspection = await inspectSharkcraft({ cwd });
    const diff = buildOnboardAdoptionDiff(inspection);
    const canonical = renderOnboardAdoptionDiff(diff, 'json');
    const maxAgeDaysRaw = flagNumber(args, 'max-age-days');
    checkpointEval = evaluateAdoptionCheckpoint(
      cwd,
      checkpointRead.checkpoint,
      hashDiffBody(canonical),
      maxAgeDaysRaw !== undefined ? { maxAgeDays: maxAgeDaysRaw } : {},
    );
  }

  let nextCommand = 'shrk onboard adopt review';
  if (!stateExists) {
    nextCommand = 'shrk onboard --write-drafts && shrk onboard adopt --write-patch';
  } else if (freshness.status !== AdoptionFreshnessStatus.Fresh) {
    nextCommand = 'shrk onboard adopt regenerate';
  } else if (patchExists) {
    nextCommand = 'shrk onboard adopt check';
  }

  if (flagBool(args, 'json')) {
    process.stdout.write(
      asJson({
        projectRoot: cwd,
        patchExists,
        summaryExists,
        stateExists,
        freshness,
        categories: state?.categories ?? null,
        nextCommand,
        checkpoint: checkpointRead.checkpoint,
        checkpointStatus: checkpointEval?.status ?? AdoptionCheckpointStatus.Missing,
        checkpointReasons: checkpointEval?.reasons ?? ['no checkpoint'],
      }) + '\n',
    );
    return 0;
  }
  process.stdout.write(header('Onboarding adoption — status'));
  process.stdout.write(kv('project root', cwd) + '\n');
  process.stdout.write(kv('patch.exists', patchExists ? 'yes' : 'no') + '\n');
  process.stdout.write(kv('summary.exists', summaryExists ? 'yes' : 'no') + '\n');
  process.stdout.write(kv('state.exists', stateExists ? 'yes' : 'no') + '\n');
  process.stdout.write(kv('freshness', freshness.status) + '\n');
  if (checkpointRead.checkpoint && checkpointEval) {
    process.stdout.write(kv('checkpoint', checkpointEval.status) + '\n');
    for (const r of checkpointEval.reasons) process.stdout.write(`    - ${r}\n`);
  } else {
    process.stdout.write(kv('checkpoint', 'missing') + '\n');
  }
  if (freshness.staleReasons.length > 0) {
    process.stdout.write('\nStale reasons:\n');
    for (const r of freshness.staleReasons) process.stdout.write(`  - ${r}\n`);
  }
  if (state) {
    process.stdout.write('\nCategory counts:\n');
    for (const cat of Object.values(AdoptionCategory)) {
      const ids = state.categories[cat] ?? [];
      process.stdout.write(`  ${cat.padEnd(20)} ${ids.length}\n`);
    }
  }
  process.stdout.write(`\nNext:\n  $ ${nextCommand}\n`);
  if (!stateExists) {
    process.stdout.write('\nTo create an adoption state:\n');
    process.stdout.write('  $ shrk onboard --write-drafts\n');
    process.stdout.write('  $ shrk onboard adopt --write-patch\n');
  }
  return 0;
}

async function runAdoptRegenerate(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const inspection = await inspectSharkcraft({ cwd });
  const plan = buildOnboardingPlan(inspection, {});
  const adoption = buildOnboardingAdoptionPlan({ inspection, plan });
  const force = flagBool(args, 'force');
  const wantJson = flagBool(args, 'json');
  const diffFormat = (flagString(args, 'diff-format') ?? 'unified') as 'pseudo' | 'unified';
  if (diffFormat !== 'pseudo' && diffFormat !== 'unified') {
    process.stderr.write(`Invalid --diff-format "${diffFormat}". Use pseudo|unified.\n`);
    return 2;
  }
  // Archive current outputs unless --force (which still archives — --force
  // only overrides "refuse to regenerate" semantics for callers who script it).
  void force;
  const archived = archivePreviousAdoptionOutputs(cwd);
  const written = writeAdoptionPatch({
    projectRoot: cwd,
    plan: adoption,
    format: diffFormat,
    noAutoRegenerate: true, // we already archived above
  });

  if (wantJson) {
    process.stdout.write(
      asJson({
        mode: 'regenerate',
        archived: archived.archived,
        historyDir: archived.historyDir,
        outDir: written.outDir,
        statePath: written.statePath,
        files: written.files.map((f) => ({ path: f.path, bytes: f.bytes })),
        targets: written.targets,
        summary: adoption.summary,
      }) + '\n',
    );
    return 0;
  }
  process.stdout.write(header('Onboarding adoption — regenerated'));
  if (archived.archived.length > 0) {
    process.stdout.write('Archived previous outputs:\n');
    for (const a of archived.archived) process.stdout.write(`  • ${a}\n`);
  }
  process.stdout.write('\nWrote new outputs:\n');
  for (const f of written.files) process.stdout.write(`  + ${f.path} (${f.bytes} bytes)\n`);
  process.stdout.write(`\nNext:\n  $ shrk onboard adopt status\n`);
  return 0;
}

async function runAdoptMergePreview(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const inspection = await inspectSharkcraft({ cwd });
  const plan = buildOnboardingPlan(inspection, {});
  const adoption = buildOnboardingAdoptionPlan({ inspection, plan });
  const preview = buildAdoptionMergePreview({ projectRoot: cwd, plan: adoption });
  const wantJson = flagBool(args, 'json');
  const format = (flagString(args, 'format') ?? (wantJson ? 'json' : 'text')) as
    | 'text'
    | 'markdown'
    | 'html'
    | 'json';
  if (wantJson || format === 'json') {
    process.stdout.write(asJson(preview) + '\n');
    return 0;
  }
  if (format === 'markdown') {
    process.stdout.write(renderAdoptionMergePreviewMarkdown(preview));
    return 0;
  }
  if (format === 'html') {
    process.stdout.write(renderAdoptionMergePreviewHtml(preview));
    return 0;
  }
  process.stdout.write(renderAdoptionMergePreviewText(preview));
  return 0;
}

async function runAdoptReport(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const inspection = await inspectSharkcraft({ cwd });
  const plan = buildOnboardingPlan(inspection, {});
  const adoption = buildOnboardingAdoptionPlan({ inspection, plan });
  const state = readAdoptionState(cwd);
  const report = buildAdoptionReport({ projectRoot: cwd, plan: adoption, state });
  const wantJson = flagBool(args, 'json');
  const format = (flagString(args, 'format') ?? (wantJson ? 'json' : 'text')) as
    | 'text'
    | 'markdown'
    | 'html'
    | 'json';
  let body: string;
  if (wantJson || format === 'json') body = renderAdoptionReportJson(report);
  else if (format === 'markdown') body = renderAdoptionReportMarkdown(report);
  else if (format === 'html') body = renderAdoptionReportHtml(report);
  else body = renderAdoptionReportText(report);

  const outputPath = flagString(args, 'output');
  if (outputPath) {
    const abs = nodePath.isAbsolute(outputPath) ? outputPath : nodePath.resolve(cwd, outputPath);
    writeFileSync(abs, body, 'utf8');
    if (!wantJson) process.stdout.write(`Wrote adoption report to ${abs}\n`);
    else process.stdout.write(asJson({ wrote: abs, bytes: Buffer.byteLength(body) }) + '\n');
    return 0;
  }
  process.stdout.write(body);
  return 0;
}

function onboardCheckpointArtifacts(diff: IOnboardAdoptionDiff): {
  targets: string[];
  drafts: string[];
} {
  const targets = [
    'sharkcraft/rules.ts',
    'sharkcraft/paths.ts',
    'sharkcraft/pipelines.ts',
    'sharkcraft/sharkcraft.config.ts',
    'sharkcraft/templates.ts',
    'sharkcraft/boundaries.ts',
  ];
  const drafts = [
    'sharkcraft/onboarding/inferred-rules.draft.ts',
    'sharkcraft/onboarding/inferred-paths.draft.ts',
    'sharkcraft/onboarding/inferred-pipelines.draft.ts',
    'sharkcraft/onboarding/inferred-templates.draft.ts',
    'sharkcraft/onboarding/inferred-boundaries.draft.ts',
    'sharkcraft/onboarding/onboarding-report.md',
  ];
  void diff;
  return { targets, drafts };
}

async function runAdoptDiff(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const formatRaw = (flagString(args, 'format') ?? 'text') as OnboardAdoptionDiffFormat;
  const valid = new Set<OnboardAdoptionDiffFormat>(['text', 'markdown', 'html', 'json']);
  if (!valid.has(formatRaw)) {
    process.stderr.write(`Unknown --format "${formatRaw}". Use text|markdown|html|json.\n`);
    return 2;
  }
  const confidenceFlag = flagString(args, 'confidence') ?? 'high';
  if (!CONFIDENCE_VALUES.has(confidenceFlag)) {
    process.stderr.write(`Invalid --confidence: "${confidenceFlag}". Use high|medium|low.\n`);
    return 2;
  }
  const include = parseKindList(flagList(args, 'include'));
  const exclude = parseKindList(flagList(args, 'exclude'));
  const inspection = await inspectSharkcraft({ cwd });
  const diff = buildOnboardAdoptionDiff(inspection, {
    confidence: confidenceFlag as 'high' | 'medium' | 'low',
    ...(include.length > 0 ? { include } : {}),
    ...(exclude.length > 0 ? { exclude } : {}),
  });
  process.stdout.write(renderOnboardAdoptionDiff(diff, formatRaw));
  if (flagBool(args, 'record-checkpoint')) {
    const canonical = renderOnboardAdoptionDiff(diff, 'json');
    const { targets, drafts } = onboardCheckpointArtifacts(diff);
    const checkpoint = recordAdoptionCheckpoint({
      projectRoot: cwd,
      kind: 'onboard',
      command: 'shrk onboard adopt diff --record-checkpoint',
      diffHash: hashDiffBody(canonical),
      targets,
      drafts,
    });
    process.stdout.write(
      `\nRecorded checkpoint (diff hash ${checkpoint.diffHash.slice(0, 12)}…) at sharkcraft/onboarding/adoption/adoption-checkpoint.json\n`,
    );
  }
  return 0;
}

function runAdoptCheck(args: ParsedArgs): number {
  const cwd = resolveCwd(args);
  const result = buildAdoptionCheck({ projectRoot: cwd });
  if (flagBool(args, 'json')) {
    process.stdout.write(asJson(result) + '\n');
    return result.canApply === AdoptionCheckResult.CanApply ? 0 : 1;
  }
  process.stdout.write(header('Onboarding adoption — check'));
  process.stdout.write(kv('canApply', result.canApply) + '\n');
  process.stdout.write(kv('patchFormat', result.patchFormat) + '\n');
  if (result.patchPath) process.stdout.write(kv('patchPath', result.patchPath) + '\n');
  process.stdout.write('\nChecks:\n');
  for (const c of result.checks) {
    const tag =
      c.severity === 'error' ? 'ERR ' : c.severity === 'warning' ? 'WARN' : 'INFO';
    process.stdout.write(`  ${tag}  ${c.id.padEnd(28)} ${c.message}\n`);
  }
  if (result.warnings.length > 0) {
    process.stdout.write('\nWarnings:\n');
    for (const w of result.warnings) process.stdout.write(`  - ${w}\n`);
  }
  process.stdout.write(`\nNext:\n  $ ${result.nextCommand}\n`);
  return result.canApply === AdoptionCheckResult.CanApply ? 0 : 1;
}
