import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  applyIngestPlan,
  buildContradictionReport,
  buildGeneratedCodeReport,
  buildIngestAdoptionPlan,
  buildIngestApplyPlan,
  buildPolyglotBoundaryReport,
  buildRepositoryKnowledgeModel,
  buildStabilityMap,
  inspectSharkcraft,
  IngestAdoptionStatus,
  IngestDepth,
  IngestSection,
  loadIngestApplyPlan,
  renderContradictionReportHtml,
  renderContradictionReportJson,
  renderContradictionReportMarkdown,
  renderContradictionReportText,
  renderGeneratedCodeReportJson,
  renderGeneratedCodeReportMarkdown,
  renderGeneratedCodeReportText,
  renderIngestAdoptionPatch,
  renderIngestAdoptionPlanMarkdown,
  renderIngestApplyReviewMarkdown,
  renderPolyglotBoundaryReportJson,
  renderPolyglotBoundaryReportMarkdown,
  renderPolyglotBoundaryReportText,
  renderRepositoryKnowledgeModelHtml,
  renderRepositoryKnowledgeModelJson,
  renderRepositoryKnowledgeModelMarkdown,
  renderRepositoryKnowledgeModelText,
  renderStabilityMapJson,
  renderStabilityMapMarkdown,
  renderStabilityMapText,
  saveIngestApplyPlan,
  signIngestApplyPlan,
  writeIngestAdoption,
  writeIngestDrafts,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  flagList,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';

type IngestFormat = 'text' | 'markdown' | 'html' | 'json';

const INGEST_BASE = nodePath.join('sharkcraft', 'ingestion');

export const ingestCommand: ICommandHandler = {
  name: 'ingest',
  description:
    'Deeply ingest a repository into a SharkCraft repository knowledge model. Dry-run by default; writes drafts under sharkcraft/ingestion/. `repository` (default sub-verb) builds the knowledge model; `status` / `report` / `diff` / `adopt` / `clean` / `refresh` manage the lifecycle.',
  usage:
    'shrk [--cwd <dir>] ingest [repository|refresh|status|report|adopt|diff|clean] [options]',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0] ?? 'repository';
    const rest = { ...args, positional: args.positional.slice(1) };
    switch (sub) {
      case 'repository':
        return runRepository(rest);
      case 'refresh':
        return runRefresh(rest);
      case 'status':
        return runStatus(rest);
      case 'report':
        return runReport(rest);
      case 'adopt':
        return runAdopt(rest);
      case 'diff':
        return runDiff(rest);
      case 'clean':
        return runClean(rest);
      default:
        return runRepository(args);
    }
  },
};

async function buildModel(args: ParsedArgs, cwd: string): Promise<{
  inspection: Awaited<ReturnType<typeof inspectSharkcraft>>;
  model: Awaited<ReturnType<typeof buildRepositoryKnowledgeModel>>;
}> {
  const depthRaw = (flagString(args, 'depth') ?? 'standard').toLowerCase();
  const depthMap: Record<string, IngestDepth> = {
    shallow: IngestDepth.Shallow,
    standard: IngestDepth.Standard,
    deep: IngestDepth.Deep,
    extreme: IngestDepth.Extreme,
  };
  const depth: IngestDepth = depthMap[depthRaw] ?? IngestDepth.Standard;
  const include = flagList(args, 'include').map(parseSection).filter(Boolean) as IngestSection[];
  const exclude = flagList(args, 'exclude').map(parseSection).filter(Boolean) as IngestSection[];
  const forcedPresets = flagList(args, 'preset');
  const task = flagString(args, 'task');
  const docsFirst = flagBool(args, 'docs-first');

  const inspection = await inspectSharkcraft({ cwd });
  const model = await buildRepositoryKnowledgeModel({
    inspection,
    depth,
    selectedSections: include.length > 0 ? include : undefined,
    excludedSections: exclude.length > 0 ? exclude : undefined,
    forcedPresetIds: forcedPresets,
    ...(task ? { task } : {}),
    docsFirst: docsFirst || undefined,
  });
  return { inspection, model };
}

async function runRepository(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const writeDrafts = flagBool(args, 'write-drafts');
  const adopt = flagBool(args, 'adopt');
  const json = flagBool(args, 'json');
  const format = parseFormat(flagString(args, 'format'));
  const output = flagString(args, 'output');
  const profile = flagString(args, 'profile');

  const { model } = await buildModel(args, cwd);

  let writtenDrafts: ReturnType<typeof writeIngestDrafts> | undefined;
  if (writeDrafts) {
    writtenDrafts = writeIngestDrafts(model, { projectRoot: cwd });
  }

  let adoption: ReturnType<typeof buildIngestAdoptionPlan> | undefined;
  let writtenAdoption: ReturnType<typeof writeIngestAdoption> | undefined;
  if (adopt) {
    adoption = buildIngestAdoptionPlan({ model });
    writtenAdoption = writeIngestAdoption({ plan: adoption });
  }

  const payload = {
    mode: writeDrafts ? (adopt ? 'write-drafts+adopt' : 'write-drafts') : (adopt ? 'adopt-only' : 'dry-run'),
    profile,
    sections: model.selectedSections,
    presets: model.presets.map((p) => ({
      id: p.preset.id,
      score: p.score,
      confidence: p.confidence,
      reasons: p.reasons,
    })),
    transformationalIntents: model.transformationalIntents,
    confidence: model.confidence.overall,
    contradictions: model.contradictions.findings.length,
    riskAreas: model.riskAreas.length,
    generatedRoots: model.generatedVsHandwritten.generatedRoots.length,
    stabilityAreas: model.stableExperimentalDeprecated.areas.length,
    written: writtenDrafts
      ? {
          outDir: writtenDrafts.outDir,
          files: writtenDrafts.files.map((f) => ({ path: f.path, bytes: f.bytes })),
        }
      : undefined,
    adoption: adoption
      ? {
          counts: adoption.counts,
          reviewRequired: adoption.reviewRequired,
          adoptionOutDir: writtenAdoption?.outDir,
        }
      : undefined,
  };

  if (json || format === 'json') {
    const body = format === 'json'
      ? renderRepositoryKnowledgeModelJson(model)
      : asJson(payload);
    if (output) writeOutput(cwd, output, body);
    else process.stdout.write(body + '\n');
    return 0;
  }

  if (format === 'markdown') {
    const body = renderRepositoryKnowledgeModelMarkdown(model);
    if (output) writeOutput(cwd, output, body);
    else process.stdout.write(body + '\n');
    return 0;
  }
  if (format === 'html') {
    const body = renderRepositoryKnowledgeModelHtml(model);
    if (output) writeOutput(cwd, output, body);
    else process.stdout.write(body + '\n');
    return 0;
  }

  // Human-readable summary.
  process.stdout.write(header('SharkCraft ingest'));
  process.stdout.write(kv('mode', payload.mode) + '\n');
  process.stdout.write(kv('depth', model.depth) + '\n');
  process.stdout.write(kv('project', model.repositoryOverview.projectName) + '\n');
  process.stdout.write(kv('confidence', `${model.confidence.overall}/100`) + '\n');
  process.stdout.write(kv('contradictions', model.contradictions.findings.length) + '\n');
  process.stdout.write(kv('risk areas', model.riskAreas.length) + '\n');
  process.stdout.write(kv('generated roots', model.generatedVsHandwritten.generatedRoots.length) + '\n');
  process.stdout.write(kv('stability areas', model.stableExperimentalDeprecated.areas.length) + '\n');
  process.stdout.write('\n');
  process.stdout.write(renderRepositoryKnowledgeModelText(model));
  process.stdout.write('\n');
  if (writtenDrafts) {
    process.stdout.write(`\nWrote ${writtenDrafts.files.length} draft files under ${writtenDrafts.outDir}\n`);
  }
  if (writtenAdoption) {
    process.stdout.write(`\nWrote adoption plan under ${writtenAdoption.outDir} (review required: ${adoption?.reviewRequired ? 'yes' : 'no'})\n`);
  }
  if (model.transformationalIntents.length > 0) {
    process.stdout.write('\nTransformational intents:\n');
    for (const t of model.transformationalIntents) process.stdout.write(`  - ${t}\n`);
  }
  process.stdout.write('\nNext steps:\n');
  process.stdout.write('  • shrk ingest report --format markdown\n');
  process.stdout.write('  • shrk ingest diff\n');
  if (!writeDrafts) process.stdout.write('  • Re-run with --write-drafts to materialise drafts under sharkcraft/ingestion/\n');
  if (!adopt) process.stdout.write('  • Re-run with --adopt to produce an adoption patch under sharkcraft/ingestion/adoption/\n');
  return 0;
}

async function runRefresh(args: ParsedArgs): Promise<number> {
  // Same as repository but always reads the cache fresh; alias for now.
  return runRepository(args);
}

async function runStatus(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const json = flagBool(args, 'json');
  const ingestDir = nodePath.join(cwd, INGEST_BASE);
  const modelPath = nodePath.join(ingestDir, 'repository-knowledge-model.json');
  const adoptionPath = nodePath.join(ingestDir, 'adoption', 'ingest-adoption-state.json');
  const status = {
    ingestDirExists: existsSync(ingestDir),
    modelExists: existsSync(modelPath),
    adoptionExists: existsSync(adoptionPath),
    modelPath,
    adoptionPath,
    files: existsSync(ingestDir) ? listFilesRecursive(ingestDir).map((f) => nodePath.relative(cwd, f)) : [],
  };
  if (json) {
    process.stdout.write(asJson(status) + '\n');
    return 0;
  }
  process.stdout.write(header('SharkCraft ingest status'));
  process.stdout.write(kv('ingest dir', status.ingestDirExists ? 'present' : 'missing') + '\n');
  process.stdout.write(kv('model', status.modelExists ? 'present' : 'missing') + '\n');
  process.stdout.write(kv('adoption', status.adoptionExists ? 'present' : 'missing') + '\n');
  if (status.files.length > 0) {
    process.stdout.write(`\nFiles (${status.files.length}):\n`);
    for (const f of status.files.slice(0, 30)) process.stdout.write(`  - ${f}\n`);
    if (status.files.length > 30) process.stdout.write(`  ... ${status.files.length - 30} more\n`);
  }
  return 0;
}

async function runReport(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const format = parseFormat(flagString(args, 'format'));
  const modelPath = nodePath.join(cwd, INGEST_BASE, 'repository-knowledge-model.json');
  if (!existsSync(modelPath)) {
    process.stderr.write(`No saved model — run \`shrk ingest repository --write-drafts\` first.\n`);
    return 1;
  }
  const body = readFileSync(modelPath, 'utf8');
  if (format === 'json') {
    process.stdout.write(body);
    return 0;
  }
  // Rebuild a renderable model from the JSON shape.
  const model = JSON.parse(body) as Parameters<typeof renderRepositoryKnowledgeModelMarkdown>[0];
  if (format === 'markdown') process.stdout.write(renderRepositoryKnowledgeModelMarkdown(model) + '\n');
  else if (format === 'html') process.stdout.write(renderRepositoryKnowledgeModelHtml(model) + '\n');
  else process.stdout.write(renderRepositoryKnowledgeModelText(model) + '\n');
  return 0;
}

async function runAdopt(args: ParsedArgs): Promise<number> {
  // `ingest adopt plan|review|apply` removed; use `onboard adopt`.
  const sub = args.positional[0];
  if (sub === 'plan' || sub === 'review' || sub === 'apply') {
    process.stderr.write(
      '`ingest adopt ' + sub + '` was removed. Use `shrk onboard adopt` (the canonical adoption surface).\n',
    );
    return 2;
  }

  const cwd = resolveCwd(args);
  const json = flagBool(args, 'json');
  const writePatch = flagBool(args, 'write-patch');
  const { model } = await buildModel(args, cwd);
  const plan = buildIngestAdoptionPlan({ model });
  let written: ReturnType<typeof writeIngestAdoption> | undefined;
  if (writePatch) written = writeIngestAdoption({ plan });

  if (json) {
    process.stdout.write(asJson({
      plan: {
        counts: plan.counts,
        reviewRequired: plan.reviewRequired,
      },
      written: written?.outDir,
    }) + '\n');
    return 0;
  }
  process.stdout.write(header('Ingest adopt'));
  process.stdout.write(kv('review required', plan.reviewRequired ? 'yes' : 'no') + '\n');
  process.stdout.write(`\n${renderIngestAdoptionPlanMarkdown(plan)}\n`);
  if (written) process.stdout.write(`\nWrote adoption files to ${written.outDir}\n`);
  return 0;
}

async function runAdoptPlan(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const includeFlag = flagList(args, 'include');
  const outputFlag = flagString(args, 'output');
  const includeManualReview = flagBool(args, 'include-manual-review');
  const includeBody = flagBool(args, 'include-body');
  const { model } = await buildModel(args, cwd);
  const adoption = buildIngestAdoptionPlan({ model });
  const include = includeFlag.length > 0
    ? includeFlag.map((s) => s as IngestAdoptionStatus)
    : [IngestAdoptionStatus.SafeAppend];
  const built = buildIngestApplyPlan({
    plan: adoption,
    include,
    includeManualReview,
    ...(includeBody ? { includeBody: true } : {}),
    note: 'Generated by `shrk ingest adopt plan`.',
  });
  const secret = process.env.SHARKCRAFT_PLAN_SECRET;
  const finalPlan = secret ? signIngestApplyPlan(built.plan, secret) : built.plan;

  const outFile = outputFlag
    ? (nodePath.isAbsolute(outputFlag) ? outputFlag : nodePath.join(cwd, outputFlag))
    : nodePath.join(cwd, INGEST_BASE, 'adoption', 'ingest-adopt-plan.json');
  saveIngestApplyPlan(finalPlan, outFile);
  process.stdout.write(`Wrote ${outFile}\n`);
  process.stdout.write(`  changes: ${finalPlan.expectedChanges.length}\n`);
  process.stdout.write(`  signed:  ${finalPlan.signature ? 'yes' : 'no — set SHARKCRAFT_PLAN_SECRET to sign'}\n`);
  process.stdout.write(`  skipped: ${built.skipped.length}\n`);
  if (built.bodyStatuses && built.bodyStatuses.length > 0) {
    const m = built.bodyStatuses.filter((b) => b.status === 'materialised').length;
    const s = built.bodyStatuses.filter((b) => b.status === 'stubbed').length;
    const sk = built.bodyStatuses.filter((b) => b.status === 'skipped').length;
    const c = built.bodyStatuses.filter((b) => b.status === 'conflict').length;
    process.stdout.write(`  bodies:  ${m} materialised, ${s} stubbed, ${sk} skipped, ${c} conflict\n`);
  }
  process.stdout.write(`\nNext: shrk ingest adopt review ${outFile}\n`);
  return 0;
}

async function runAdoptReview(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const planFile = args.positional[0] ?? nodePath.join(cwd, INGEST_BASE, 'adoption', 'ingest-adopt-plan.json');
  const plan = loadIngestApplyPlan(nodePath.isAbsolute(planFile) ? planFile : nodePath.join(cwd, planFile));
  if (!plan) {
    process.stderr.write(`Plan not found or invalid: ${planFile}\n`);
    return 1;
  }
  process.stdout.write(renderIngestApplyReviewMarkdown(plan) + '\n');
  return 0;
}

async function runAdoptApply(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const verifySignature = flagBool(args, 'verify-signature');
  const planFile = args.positional[0] ?? nodePath.join(cwd, INGEST_BASE, 'adoption', 'ingest-adopt-plan.json');
  const planAbs = nodePath.isAbsolute(planFile) ? planFile : nodePath.join(cwd, planFile);
  const plan = loadIngestApplyPlan(planAbs);
  if (!plan) {
    process.stderr.write(`Plan not found or invalid: ${planFile}\n`);
    return 1;
  }
  const secret = process.env.SHARKCRAFT_PLAN_SECRET;
  if (verifySignature && !secret) {
    process.stderr.write('--verify-signature requested but SHARKCRAFT_PLAN_SECRET is not set.\n');
    return 1;
  }
  // Rebuild the bodies from the adoption state — keeps `apply` deterministic.
  const { model } = await buildModel(args, cwd);
  const adoption = buildIngestAdoptionPlan({ model });
  const include = plan.expectedChanges.length > 0 ? [IngestAdoptionStatus.SafeAppend] : [IngestAdoptionStatus.SafeAppend];
  const built = buildIngestApplyPlan({ plan: adoption, include });
  const result = applyIngestPlan({
    plan,
    files: built.files,
    requireSignature: verifySignature,
    ...(secret ? { secret } : {}),
  });
  process.stdout.write(`Applied ${result.applied.length} change(s).\n`);
  for (const a of result.applied) process.stdout.write(`  - wrote ${a.path} (+${a.bytesWritten}B)\n`);
  if (result.skipped.length > 0) {
    process.stdout.write(`\nSkipped:\n`);
    for (const s of result.skipped) process.stdout.write(`  - ${s.path}: ${s.reason}\n`);
  }
  return 0;
}

async function runDiff(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const format = parseFormat(flagString(args, 'format'));
  const json = flagBool(args, 'json');
  const { model } = await buildModel(args, cwd);
  const plan = buildIngestAdoptionPlan({ model });
  if (json) {
    process.stdout.write(asJson({ counts: plan.counts, entries: plan.entries }) + '\n');
    return 0;
  }
  const body = format === 'markdown' ? renderIngestAdoptionPlanMarkdown(plan) : renderIngestAdoptionPatch(plan);
  process.stdout.write(body + '\n');
  return 0;
}

async function runClean(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const write = flagBool(args, 'write');
  const dryRun = flagBool(args, 'dry-run') || !write;
  const ingestDir = nodePath.join(cwd, INGEST_BASE);
  if (!existsSync(ingestDir)) {
    process.stdout.write('Nothing to clean — sharkcraft/ingestion/ does not exist.\n');
    return 0;
  }
  const files = listFilesRecursive(ingestDir);
  if (dryRun) {
    process.stdout.write(`Would remove ${files.length} files from ${ingestDir}\n`);
    for (const f of files.slice(0, 30)) process.stdout.write(`  - ${nodePath.relative(cwd, f)}\n`);
    if (files.length > 30) process.stdout.write(`  ... ${files.length - 30} more\n`);
    process.stdout.write('\nRe-run with --write to actually delete.\n');
    return 0;
  }
  rmSync(ingestDir, { recursive: true, force: true });
  process.stdout.write(`Removed ${ingestDir}\n`);
  return 0;
}

function parseFormat(raw: string | undefined): IngestFormat {
  switch ((raw ?? 'text').toLowerCase()) {
    case 'markdown':
    case 'md':
      return 'markdown';
    case 'html':
      return 'html';
    case 'json':
      return 'json';
    default:
      return 'text';
  }
}

function parseSection(raw: string): IngestSection | undefined {
  for (const s of Object.values(IngestSection)) {
    if (s === raw) return s;
  }
  return undefined;
}

function writeOutput(cwd: string, relOrAbs: string, body: string): void {
  const full = nodePath.isAbsolute(relOrAbs) ? relOrAbs : nodePath.join(cwd, relOrAbs);
  const dir = nodePath.dirname(full);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(full, body, 'utf8');
  process.stderr.write(`wrote ${full}\n`);
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  const visit = (d: string): void => {
    let entries: string[];
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      const full = nodePath.join(d, e);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) visit(full);
      else out.push(full);
    }
  };
  visit(dir);
  return out;
}

// Companion top-level commands that share the same backbone.

export const contradictionsCommand: ICommandHandler = {
  name: 'contradictions',
  description: 'Detect contradictions between docs/configs and the actual repo (missing paths, deprecated CLI usage, missing commands). Read-only.',
  usage: 'shrk [--cwd <dir>] contradictions [--format text|markdown|html|json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const format = parseFormat(flagString(args, 'format'));
    const inspection = await inspectSharkcraft({ cwd });
    const report = buildContradictionReport({ inspection });
    if (format === 'json') process.stdout.write(renderContradictionReportJson(report) + '\n');
    else if (format === 'markdown') process.stdout.write(renderContradictionReportMarkdown(report) + '\n');
    else if (format === 'html') process.stdout.write(renderContradictionReportHtml(report) + '\n');
    else process.stdout.write(renderContradictionReportText(report) + '\n');
    return 0;
  },
};

export const generatedCommand: ICommandHandler = {
  name: 'generated',
  description: 'Generated-code classifier. Subcommands: `report` (default), `protect --write-drafts`. Read-only by default.',
  usage: 'shrk [--cwd <dir>] generated [report|protect] [--format text|markdown|json] [--write-drafts]',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0] === 'protect' ? 'protect' : 'report';
    const rest = { ...args, positional: args.positional.slice(args.positional[0] === 'report' || args.positional[0] === 'protect' ? 1 : 0) };
    const cwd = resolveCwd(rest);
    const format = parseFormat(flagString(rest, 'format'));
    const inspection = await inspectSharkcraft({ cwd });
    const report = buildGeneratedCodeReport({ inspection });
    if (sub === 'protect') {
      const writeDrafts = flagBool(rest, 'write-drafts');
      const outDir = nodePath.join(cwd, INGEST_BASE);
      if (writeDrafts) {
        if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
        const target = nodePath.join(outDir, 'GENERATED_PROTECT.md');
        writeFileSync(target, renderGeneratedCodeReportMarkdown(report), 'utf8');
        process.stdout.write(`Wrote ${target}\n`);
        return 0;
      }
      process.stdout.write(renderGeneratedCodeReportMarkdown(report) + '\n');
      process.stdout.write('\nRe-run with --write-drafts to save the recommended protect rules under sharkcraft/ingestion/.\n');
      return 0;
    }
    if (format === 'json') process.stdout.write(renderGeneratedCodeReportJson(report) + '\n');
    else if (format === 'markdown') process.stdout.write(renderGeneratedCodeReportMarkdown(report) + '\n');
    else process.stdout.write(renderGeneratedCodeReportText(report) + '\n');
    return 0;
  },
};

export const stabilityCommand: ICommandHandler = {
  name: 'stability',
  description: 'Stability classification (stable/experimental/deprecated/legacy/generated/internal/public-api/high-risk). Read-only.',
  usage: 'shrk [--cwd <dir>] stability [map|area <id>] [--format text|markdown|json]',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    const cwd = resolveCwd(args);
    const format = parseFormat(flagString(args, 'format'));
    const inspection = await inspectSharkcraft({ cwd });
    const generated = buildGeneratedCodeReport({ inspection });
    const map = buildStabilityMap({
      inspection,
      generatedRoots: generated.generatedRoots.map((r) => r.path),
    });
    if (sub === 'area') {
      const id = args.positional[1];
      if (!id) {
        process.stderr.write('Usage: shrk stability area <id>\n');
        return 1;
      }
      const area = map.areas.find((a) => a.id === id || a.path === id);
      if (!area) {
        process.stderr.write(`No stability area found for "${id}".\n`);
        return 1;
      }
      if (format === 'json') process.stdout.write(asJson(area) + '\n');
      else process.stdout.write(`${area.kind} (${area.confidence})\n  path: ${area.path}\n  signals: ${area.signals.join(', ')}\n` + (area.note ? `  note: ${area.note}\n` : ''));
      return 0;
    }
    if (format === 'json') process.stdout.write(renderStabilityMapJson(map) + '\n');
    else if (format === 'markdown') process.stdout.write(renderStabilityMapMarkdown(map) + '\n');
    else process.stdout.write(renderStabilityMapText(map) + '\n');
    return 0;
  },
};

void parseFormat;
