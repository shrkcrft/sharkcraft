import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  buildBundleDiffFromIds,
  buildPlanDependencyGraph,
  buildTaskPacket,
  createFeatureBundleState,
  decomposeTask,
  inspectSharkcraft,
  listFeatureBundles,
  markBundlePlanApplied,
  readFeatureBundle,
  recomputeBundleStatus,
  recordBundleReport,
  recordBundleValidation,
  renderBundleDiff,
  renderBundleValidationHtml,
  renderGraphDot,
  renderGraphMermaid,
  renderGraphText,
  renderBundleReplayWorkflow,
  replayAllBundles,
  replayBundle,
  renderBundleReplayBatchHtml,
  setBundleDependencies,
  type BundleDiffFormat,
  type BundleReplaySchedule,
  setBundleNextAction,
  upsertBundlePlan,
  writeFeatureBundle,
  getBundleDir,
  buildAreaMap,
  BundleReplayStatus,
  type IFeatureBundle,
  type IFeatureBundlePlan,
} from '@shrkcrft/inspector';
import {
  buildSavedPlan,
  generate,
  OverwriteStrategy,
  savePlanToFile,
} from '@shrkcrft/generator';
import {
  flagBool,
  flagString,
  flagList,
  flagVars,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';

const SUBCOMMANDS = new Set([
  'create',
  'list',
  'show',
  'status',
  'next',
  'report',
  'review',
  'commands',
  'plan',
  'graph',
  'apply-plan',
  'apply-assist',
  'validate',
  'decompose',
  'record-apply',
  'replay',
  'diff',
]);

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function nowSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function bundleCreate(args: ParsedArgs): Promise<number> {
  const task = args.positional.join(' ').trim();
  if (!task) {
    process.stderr.write('Usage: shrk bundle create "<task>"\n');
    return 2;
  }
  const cwd = resolveCwd(args);
  const inspection = await inspectSharkcraft({ cwd });
  const packet = buildTaskPacket(inspection, task, { maxTokens: 3500 });
  const decomposition = decomposeTask(inspection, task);
  const id = `${nowSlug()}-${slugify(task)}`;
  const sessionId = flagString(args, 'session');
  const state = createFeatureBundleState({
    id,
    task,
    projectRoot: cwd,
    packet,
    decomposition,
    ...(sessionId ? { sessionId } : {}),
  });
  const final = writeFeatureBundle(cwd, state);
  // Write companion files
  const dir = getBundleDir(cwd, id);
  writeFileSync(nodePath.join(dir, 'task.md'), `# ${task}\n`, 'utf8');
  writeFileSync(nodePath.join(dir, 'decomposition.json'), JSON.stringify(decomposition, null, 2) + '\n', 'utf8');
  writeFileSync(nodePath.join(dir, 'task-packet.json'), JSON.stringify(packet, null, 2) + '\n', 'utf8');
  writeFileSync(
    nodePath.join(dir, 'commands.sh'),
    [
      '#!/usr/bin/env bash',
      '# Suggested commands. Review before running.',
      ...packet.recommendedCliCommands,
    ].join('\n') + '\n',
    'utf8',
  );

  if (flagBool(args, 'json')) {
    process.stdout.write(asJson({ id, dir, task, status: final.status, nextAction: final.nextAction }) + '\n');
    return 0;
  }
  process.stdout.write(header(`Bundle created: ${id}`));
  process.stdout.write(kv('task', task) + '\n');
  process.stdout.write(kv('dir', dir) + '\n');
  process.stdout.write(kv('risk', final.riskLevel) + '\n');
  process.stdout.write(`Next: ${final.nextAction}\n`);
  return 0;
}

async function bundleList(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const all = listFeatureBundles(cwd);
  if (flagBool(args, 'json')) {
    process.stdout.write(asJson(all.map((b) => ({
      id: b.id,
      task: b.task,
      status: b.status,
      risk: b.riskLevel,
      plans: b.plans.length,
    }))) + '\n');
    return 0;
  }
  for (const b of all) {
    process.stdout.write(`${b.id}  [${b.status}]  ${b.plans.length} plans  ${b.task}\n`);
  }
  return 0;
}

function loadOrFail(cwd: string, id: string | undefined): IFeatureBundle | number {
  if (!id) {
    process.stderr.write('Usage: shrk bundle <subcommand> <bundleId>\n');
    return 2;
  }
  const b = readFeatureBundle(cwd, id);
  if (!b) {
    process.stderr.write(`No bundle "${id}".\n`);
    return 1;
  }
  return b;
}

async function bundleShow(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const bundle = loadOrFail(cwd, args.positional[0]);
  if (typeof bundle === 'number') return bundle;
  if (flagBool(args, 'json')) {
    process.stdout.write(asJson(bundle) + '\n');
    return 0;
  }
  process.stdout.write(header(`Bundle: ${bundle.id}`));
  process.stdout.write(kv('task', bundle.task) + '\n');
  process.stdout.write(kv('status', bundle.status) + '\n');
  process.stdout.write(kv('risk', bundle.riskLevel) + '\n');
  process.stdout.write(kv('plans', String(bundle.plans.length)) + '\n');
  process.stdout.write(kv('validations', String(bundle.validations.length)) + '\n');
  process.stdout.write(`Next: ${bundle.nextAction ?? '(none)'}\n`);
  return 0;
}

async function bundleStatus(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const bundle = loadOrFail(cwd, args.positional[0]);
  if (typeof bundle === 'number') return bundle;
  const summary = computeBundleStatusSummary(cwd, bundle);
  if (flagBool(args, 'json')) {
    process.stdout.write(asJson(summary) + '\n');
    return 0;
  }
  process.stdout.write(header(`Bundle status: ${bundle.id}`));
  process.stdout.write(kv('task', bundle.task) + '\n');
  process.stdout.write(kv('status', summary.status) + '\n');
  process.stdout.write(kv('risk', bundle.riskLevel) + '\n');
  process.stdout.write(kv('plans applied', `${summary.appliedPlans}/${summary.totalPlans}`) + '\n');
  process.stdout.write(kv('plans unapplied', String(summary.unappliedPlans.length)) + '\n');
  process.stdout.write(kv('intents', String(summary.intentPlans.length)) + '\n');
  process.stdout.write(kv('validations', `${summary.validationsPassed}/${summary.validationsTotal}`) + '\n');
  process.stdout.write(kv('audit entries', String(summary.auditEntries)) + '\n');
  process.stdout.write(`\nPlan groups (${summary.planGroups.length}):\n`);
  for (const g of summary.planGroups) {
    process.stdout.write(`  ${g.id}: ${g.planNames.join(', ')}\n`);
  }
  if (summary.dependencies.length > 0) {
    process.stdout.write('\nDependencies:\n');
    for (const d of summary.dependencies.slice(0, 10)) {
      process.stdout.write(`  ${d.from} → ${d.to}  (${d.reason})\n`);
    }
  }
  process.stdout.write(`\nNext: ${summary.nextSafeAction}\n`);
  return 0;
}

interface IBundleStatusSummary {
  id: string;
  task: string;
  status: string;
  riskLevel: string;
  totalPlans: number;
  appliedPlans: number;
  unappliedPlans: readonly string[];
  intentPlans: readonly string[];
  planGroups: readonly { id: string; planNames: readonly string[] }[];
  dependencies: readonly { from: string; to: string; reason: string }[];
  validationsTotal: number;
  validationsPassed: number;
  auditEntries: number;
  nextSafeAction: string;
}

function computeBundleStatusSummary(cwd: string, bundle: IFeatureBundle): IBundleStatusSummary {
  const applied = bundle.plans.filter((p) => p.status === 'applied').map((p) => p.name);
  const intents = bundle.plans.filter((p) => p.status === 'intent').map((p) => p.name);
  const unapplied = bundle.plans
    .filter((p) => p.status !== 'applied' && p.status !== 'intent')
    .map((p) => p.name);
  // Audit log line count, if present.
  let auditEntries = 0;
  try {
    const auditFile = nodePath.join(getBundleDir(cwd, bundle.id), 'reports', 'apply-audit.log');
    if (existsSync(auditFile)) {
      auditEntries = readFileSync(auditFile, 'utf8').split('\n').filter((l) => l.length > 0).length;
    }
  } catch {
    /* ignore */
  }
  const validationsPassed = bundle.validations.filter((v) => v.passed).length;
  const nextSafeAction = computeNextSafeAction(bundle, applied, intents, unapplied);
  return {
    id: bundle.id,
    task: bundle.task,
    status: bundle.status,
    riskLevel: bundle.riskLevel,
    totalPlans: bundle.plans.length,
    appliedPlans: applied.length,
    unappliedPlans: unapplied,
    intentPlans: intents,
    planGroups: bundle.planGroups,
    dependencies: bundle.dependencies,
    validationsTotal: bundle.validations.length,
    validationsPassed,
    auditEntries,
    nextSafeAction,
  };
}

function computeNextSafeAction(
  bundle: IFeatureBundle,
  applied: readonly string[],
  intents: readonly string[],
  unapplied: readonly string[],
): string {
  if (bundle.plans.length === 0) {
    return `shrk bundle plan ${bundle.id} --all-suggested`;
  }
  if (intents.length > 0) {
    return `shrk bundle plan ${bundle.id} --template <id> --var k=v  # fill missing vars`;
  }
  if (unapplied.length === 0) {
    if (bundle.validations.length === 0) {
      return `shrk bundle validate ${bundle.id} --all-verifications --report`;
    }
    return `shrk bundle report ${bundle.id}`;
  }
  // Find the next-unblocked plan: a plan whose dependencies are all applied.
  const appliedSet = new Set(applied);
  const blockedBy = new Map<string, Set<string>>();
  for (const e of bundle.dependencies) {
    const s = blockedBy.get(e.to) ?? new Set<string>();
    s.add(e.from);
    blockedBy.set(e.to, s);
  }
  for (const name of unapplied) {
    const deps = blockedBy.get(name);
    if (!deps || [...deps].every((d) => appliedSet.has(d))) {
      const plan = bundle.plans.find((p) => p.name === name);
      if (!plan) continue;
      return `shrk apply .sharkcraft/bundles/${bundle.id}/plans/${plan.file} --verify-signature && shrk bundle record-apply ${bundle.id} ${name}`;
    }
  }
  return `shrk bundle apply-assist ${bundle.id}  # some plans blocked by deps`;
}

async function bundleReport(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const bundle = loadOrFail(cwd, args.positional[0]);
  if (typeof bundle === 'number') return bundle;
  const summary = computeBundleStatusSummary(cwd, bundle);
  const lines: string[] = [];
  lines.push(`# Bundle final report: ${bundle.id}`);
  lines.push('');
  lines.push(`**Task:** ${bundle.task}`);
  lines.push(`**Status:** ${bundle.status}`);
  lines.push(`**Risk:** ${bundle.riskLevel}`);
  lines.push(`**Created:** ${bundle.createdAt}`);
  lines.push(`**Updated:** ${bundle.updatedAt}`);
  lines.push('');
  lines.push(`## Plan groups (${bundle.planGroups.length})`);
  for (const g of bundle.planGroups) {
    lines.push(`- \`${g.id}\`: ${g.planNames.join(', ')}`);
  }
  if (bundle.dependencies.length > 0) {
    lines.push('');
    lines.push(`## Dependencies (${bundle.dependencies.length})`);
    for (const d of bundle.dependencies) lines.push(`- \`${d.from}\` → \`${d.to}\` _(${d.reason})_`);
  }
  lines.push('');
  lines.push(`## Plans (${bundle.plans.length})`);
  for (const p of bundle.plans) {
    lines.push(`- \`${p.name}\` (${p.templateId}) — **${p.status}**`);
    if (p.expectedTargets.length > 0) {
      for (const t of p.expectedTargets.slice(0, 5)) lines.push(`  - target: \`${t}\``);
    }
  }
  if (bundle.validations.length > 0) {
    lines.push('');
    lines.push(`## Validations (${bundle.validations.length})`);
    for (const v of bundle.validations) {
      lines.push(`- ${v.startedAt}: **${v.passed ? 'passed' : 'failed'}** — ${v.boundaryViolations} violations, ${v.warnings} warnings`);
      for (const c of v.commandsRun) {
        lines.push(`  - ${c.passed ? 'OK' : 'FAIL'} ${c.command}: ${c.note ?? ''}`);
      }
    }
  }
  lines.push('');
  lines.push(`## Audit`);
  lines.push(`- Plans applied: ${summary.appliedPlans}/${summary.totalPlans}`);
  lines.push(`- Apply audit entries: ${summary.auditEntries}`);
  lines.push('');
  lines.push(`## Next safe action`);
  lines.push('```');
  lines.push(summary.nextSafeAction);
  lines.push('```');

  const out = lines.join('\n') + '\n';
  const file = nodePath.join(getBundleDir(cwd, bundle.id), 'reports', 'final-report.md');
  mkdirSync(nodePath.dirname(file), { recursive: true });
  writeFileSync(file, out, 'utf8');
  const updated = recordBundleReport(bundle, 'reports/final-report.md');
  writeFeatureBundle(cwd, updated);
  if (flagBool(args, 'json')) {
    process.stdout.write(asJson({ id: bundle.id, file, summary }) + '\n');
    return 0;
  }
  process.stdout.write(out);
  return 0;
}

async function bundleCommands(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const bundle = loadOrFail(cwd, args.positional[0]);
  if (typeof bundle === 'number') return bundle;
  for (const c of bundle.commandHints) process.stdout.write(`${c}\n`);
  return 0;
}

async function bundlePlan(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const bundle = loadOrFail(cwd, args.positional[0]);
  if (typeof bundle === 'number') return bundle;
  const inspection = await inspectSharkcraft({ cwd });
  const explicitTemplate = flagString(args, 'template');
  const explicitName = flagString(args, 'name');
  const variables = flagVars(args);
  const allSuggested = flagBool(args, 'all-suggested');
  const fromPipeline = flagBool(args, 'from-pipeline');

  type Target = { templateId: string; planName: string; userName?: string; variables: Record<string, string> };
  const targets: Target[] = [];

  // Determine targets.
  if (explicitTemplate) {
    const planName = explicitName ?? explicitTemplate.replace(/[^a-z0-9]+/gi, '-');
    const t: Target = { templateId: explicitTemplate, planName, variables: { ...variables } };
    if (explicitName) t.userName = explicitName;
    targets.push(t);
  } else if (allSuggested || fromPipeline) {
    const packetFile = nodePath.join(getBundleDir(cwd, bundle.id), 'task-packet.json');
    let candidateIds: string[] = [];
    if (existsSync(packetFile)) {
      try {
        const packet = JSON.parse(readFileSync(packetFile, 'utf8')) as {
          relevantTemplates?: readonly { id: string }[];
        };
        candidateIds = (packet.relevantTemplates ?? []).map((t) => t.id);
      } catch {
        /* ignore */
      }
    }
    for (const id of candidateIds.slice(0, 4)) {
      targets.push({
        templateId: id,
        planName: id.replace(/[^a-z0-9]+/gi, '-'),
        variables: {},
      });
    }
  }

  if (targets.length === 0) {
    process.stderr.write(
      `No templates targeted. Use --template <id> or --all-suggested.\n`,
    );
    return 1;
  }

  const dir = getBundleDir(cwd, bundle.id);
  const plansDir = nodePath.join(dir, 'plans');
  const reviewsDir = nodePath.join(dir, 'reviews');
  mkdirSync(plansDir, { recursive: true });
  mkdirSync(reviewsDir, { recursive: true });

  const results: Array<Record<string, unknown>> = [];
  let updated = bundle;

  for (const target of targets) {
    const template = inspection.templateRegistry.get(target.templateId);
    if (!template) {
      results.push({ templateId: target.templateId, status: 'unknown-template' });
      continue;
    }
    const r = generate(template, {
      templateId: template.id,
      ...(target.userName ? { name: target.userName } : {}),
      variables: target.variables,
      projectRoot: cwd,
      overwriteStrategy: OverwriteStrategy.Never,
      write: false,
    });
    if (!r.ok) {
      results.push({ templateId: target.templateId, status: 'gen-error', message: r.error.message });
      continue;
    }
    const plan = r.value.plan;
    const missing = plan.warnings
      .map((w) => /Variable\s+'(\w+)'/.exec(w)?.[1])
      .filter((m): m is string => Boolean(m));

    if (missing.length > 0 || plan.changes.length === 0) {
      const intentFile = `${target.planName}.intent.md`;
      writeFileSync(
        nodePath.join(plansDir, intentFile),
        `# Plan intent for ${target.templateId}\n\nMissing variables: ${missing.join(', ')}\n`,
        'utf8',
      );
      const entry: IFeatureBundlePlan = {
        name: target.planName,
        templateId: target.templateId,
        generatedName: target.planName,
        variables: target.variables,
        missingVariables: missing,
        file: intentFile,
        status: 'intent',
        expectedTargets: [],
      };
      updated = upsertBundlePlan(updated, entry);
      results.push({ templateId: target.templateId, status: 'intent', file: `plans/${intentFile}` });
      continue;
    }
    const saved = buildSavedPlan({
      templateId: template.id,
      name: target.planName,
      variables: target.variables,
      projectRoot: cwd,
      plan,
    });
    const planFile = `${target.planName}.json`;
    const planFullPath = nodePath.join(plansDir, planFile);
    const sr = savePlanToFile(saved, planFullPath);
    if (!sr.ok) {
      results.push({ templateId: target.templateId, status: 'save-error', message: sr.error.message });
      continue;
    }
    const expectedTargets = plan.changes.map((c) => c.relativePath);
    const entry: IFeatureBundlePlan = {
      name: target.planName,
      templateId: target.templateId,
      generatedName: target.planName,
      variables: target.variables,
      missingVariables: [],
      file: planFile,
      status: 'reviewed',
      expectedTargets,
    };
    updated = upsertBundlePlan(updated, entry);
    results.push({ templateId: target.templateId, status: 'saved', file: `plans/${planFile}` });
  }

  updated = recomputeBundleStatus(updated);
  // Persist graph-derived dependencies so MCP / read-only consumers see the
  // order without rebuilding the graph from the registries.
  const graph = buildPlanDependencyGraph(inspection, updated);
  updated = setBundleDependencies(
    updated,
    graph.edges.map((e) => ({ from: e.from, to: e.to, reason: e.reason })),
    graph.order,
  );
  const nextAction =
    updated.plans.length > 0
      ? `shrk bundle apply-assist ${bundle.id}`
      : `shrk bundle plan ${bundle.id}`;
  updated = setBundleNextAction(updated, nextAction);
  writeFeatureBundle(cwd, updated);

  if (flagBool(args, 'json')) {
    process.stdout.write(asJson({ id: bundle.id, plans: results }) + '\n');
    return 0;
  }
  process.stdout.write(header(`Bundle plan: ${bundle.id}`));
  for (const r of results) {
    process.stdout.write(`  ${String(r.status).padEnd(14)} ${r.file ?? r.templateId}\n`);
  }
  return 0;
}

async function bundleGraph(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const bundle = loadOrFail(cwd, args.positional[0]);
  if (typeof bundle === 'number') return bundle;
  const inspection = await inspectSharkcraft({ cwd });
  const graph = buildPlanDependencyGraph(inspection, bundle);
  const fmt = flagString(args, 'format') ?? (flagBool(args, 'json') ? 'json' : 'text');
  if (fmt === 'json') {
    process.stdout.write(asJson(graph) + '\n');
  } else if (fmt === 'dot') {
    process.stdout.write(renderGraphDot(graph));
  } else if (fmt === 'mermaid') {
    process.stdout.write(renderGraphMermaid(graph));
  } else {
    process.stdout.write(renderGraphText(graph));
  }
  return 0;
}

async function bundleApplyAssist(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const bundle = loadOrFail(cwd, args.positional[0]);
  if (typeof bundle === 'number') return bundle;
  const inspection = await inspectSharkcraft({ cwd });
  const graph = buildPlanDependencyGraph(inspection, bundle);
  const ordered = graph.order;
  const resume = flagBool(args, 'resume');
  // Group plans into waves using bundle.planGroups when present, else the
  // topological order is a single group.
  const groups: { id: string; planNames: readonly string[] }[] =
    bundle.planGroups.length > 0
      ? [...bundle.planGroups]
      : [{ id: 'group-1', planNames: ordered }];

  const appliedSet = new Set(bundle.plans.filter((p) => p.status === 'applied').map((p) => p.name));
  const skipped: string[] = [];
  const commands: string[] = [];
  for (const planName of ordered) {
    const p = bundle.plans.find((x) => x.name === planName);
    if (!p) continue;
    if (p.status === 'intent') continue;
    if (resume && appliedSet.has(planName)) {
      skipped.push(planName);
      continue;
    }
    commands.push(`shrk apply .sharkcraft/bundles/${bundle.id}/plans/${p.file} --verify-signature`);
  }

  const validateAfterGroup = flagBool(args, 'validate-after-group');
  const validateFinal = flagBool(args, 'validate-final');
  const outputFlag = flagString(args, 'output');
  const fmt = flagString(args, 'format') ?? (flagBool(args, 'json') ? 'json' : 'markdown');
  if (fmt === 'json') {
    process.stdout.write(asJson({
      id: bundle.id,
      order: ordered,
      commands,
      planGroups: groups,
      validateAfterGroup,
      validateFinal,
      resume,
      skipped,
    }) + '\n');
    return 0;
  }

  if (fmt === 'shell' || flagBool(args, 'write-script') || outputFlag) {
    const out = buildApplyAssistScript(bundle, groups, ordered, {
      validateAfterGroup,
      validateFinal,
      resume,
    });
    const destPath = outputFlag
      ? (nodePath.isAbsolute(outputFlag) ? outputFlag : nodePath.join(cwd, outputFlag))
      : nodePath.join(getBundleDir(cwd, bundle.id), 'reports', 'apply-assist.sh');
    if (flagBool(args, 'write-script') || outputFlag) {
      mkdirSync(nodePath.dirname(destPath), { recursive: true });
      writeFileSync(destPath, out, { mode: 0o755 });
      const rel = nodePath.relative(getBundleDir(cwd, bundle.id), destPath);
      if (!rel.startsWith('..')) {
        const updated = recordBundleReport(bundle, rel);
        writeFeatureBundle(cwd, updated);
      }
      process.stdout.write(`Wrote ${destPath}\n`);
      return 0;
    }
    process.stdout.write(out);
    return 0;
  }

  // Markdown (default).
  process.stdout.write(`# Apply-assist for ${bundle.id}\n\n`);
  if (resume) {
    process.stdout.write(`Resume mode: ${skipped.length} plan(s) already applied — skipping.\n`);
    if (skipped.length > 0) process.stdout.write(`  Skipped: ${skipped.join(', ')}\n`);
    process.stdout.write('\n');
  }
  process.stdout.write(`Order:\n`);
  for (const g of groups) {
    process.stdout.write(`- ${g.id}: ${g.planNames.join(', ')}\n`);
  }
  process.stdout.write(`\nCommands (run yourself — no auto-apply):\n\n`);
  for (const c of commands) process.stdout.write(`\`\`\`\n${c}\n\`\`\`\n\n`);
  if (commands.length === 0 && resume) {
    process.stdout.write('All plans already applied — nothing to resume.\n');
  }
  process.stdout.write(`After each plan, run:\n\`\`\`\nshrk check boundaries\nbun test\n\`\`\`\n`);
  return 0;
}

function buildApplyAssistScript(
  bundle: IFeatureBundle,
  groups: readonly { id: string; planNames: readonly string[] }[],
  topoOrder: readonly string[],
  opts: { validateAfterGroup: boolean; validateFinal: boolean; resume?: boolean },
): string {
  const lines: string[] = [];
  lines.push('#!/usr/bin/env bash');
  lines.push(`# apply-assist v2 — bundle ${bundle.id}`);
  lines.push('# - applies plans in dependency order, respecting plan groups');
  lines.push('# - stops on the first failure (set -euo pipefail)');
  lines.push('# - calls `shrk bundle record-apply` after each successful apply');
  if (opts.resume) lines.push('# - resume mode: skips plans already marked applied');
  if (opts.validateAfterGroup) lines.push('# - runs `shrk bundle validate --boundaries` after each group');
  if (opts.validateFinal) lines.push('# - runs `shrk bundle validate --all-verifications --report` at the end');
  lines.push('# - logs every command + outcome to reports/apply-assist.log');
  lines.push('set -euo pipefail');
  lines.push(`BUNDLE_ID=${shellEscape(bundle.id)}`);
  lines.push(`BUNDLE_DIR=".sharkcraft/bundles/$BUNDLE_ID"`);
  lines.push('LOG_FILE="$BUNDLE_DIR/reports/apply-assist.log"');
  lines.push('mkdir -p "$BUNDLE_DIR/reports"');
  lines.push('log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$LOG_FILE"; }');
  lines.push('phase() { echo; echo "=== $* ==="; log "PHASE $*"; }');

  // Helper to find the plan file for a given plan name.
  const planFileByName = new Map<string, string>();
  for (const p of bundle.plans) planFileByName.set(p.name, p.file);

  const isApplied = (name: string): boolean =>
    bundle.plans.find((x) => x.name === name)?.status === 'applied';
  const isIntent = (name: string): boolean =>
    bundle.plans.find((x) => x.name === name)?.status === 'intent';
  let groupIndex = 0;
  for (const g of groups) {
    groupIndex += 1;
    const applicable = g.planNames.filter(
      (n) => !isIntent(n) && !isApplied(n) && planFileByName.has(n),
    );
    // Re-order applicable using the topological sort within the group.
    applicable.sort(
      (a, b) => topoOrder.indexOf(a) - topoOrder.indexOf(b),
    );
    if (applicable.length === 0) {
      lines.push('');
      lines.push(`phase "Group ${groupIndex} (${g.id}) — nothing to do"`);
      continue;
    }
    lines.push('');
    lines.push(`phase "Group ${groupIndex} (${g.id}) — ${applicable.length} plan(s)"`);
    for (const name of applicable) {
      const planFile = planFileByName.get(name)!;
      const cmd = `shrk apply $BUNDLE_DIR/plans/${shellEscape(planFile)} --verify-signature`;
      lines.push(`log "About to apply: ${shellEscape(name)} ($cmd)"`);
      lines.push(`echo "About to apply plan: ${shellEscape(name)}"`);
      lines.push(`echo "Command: ${cmd}"`);
      lines.push('read -p "Continue? (yes/no) " ans');
      lines.push('if [ "$ans" != "yes" ]; then log "SKIPPED ${name}"; echo "Skipped."; exit 1; fi');
      lines.push(`echo "+ ${cmd}"`);
      lines.push(`${cmd} 2>&1 | tee -a "$LOG_FILE"`);
      lines.push(`shrk bundle record-apply $BUNDLE_ID ${shellEscape(name)} --note "via apply-assist.sh"`);
      lines.push(`log "APPLIED ${shellEscape(name)}"`);
    }
    if (opts.validateAfterGroup) {
      lines.push('');
      lines.push(`phase "Validate after group ${groupIndex}"`);
      lines.push(`shrk bundle validate $BUNDLE_ID --boundaries 2>&1 | tee -a "$LOG_FILE"`);
    }
  }
  if (opts.validateFinal) {
    lines.push('');
    lines.push('phase "Final validation"');
    lines.push(`shrk bundle validate $BUNDLE_ID --all-verifications --report 2>&1 | tee -a "$LOG_FILE"`);
  }
  lines.push('');
  lines.push('log "Apply-assist completed cleanly."');
  lines.push('echo "Done."');
  return lines.join('\n') + '\n';
}

function shellEscape(s: string): string {
  // Conservative: wrap in single quotes and escape embedded single quotes.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function bundleValidate(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const bundle = loadOrFail(cwd, args.positional[0]);
  if (typeof bundle === 'number') return bundle;
  const inspection = await inspectSharkcraft({ cwd });
  const all = flagBool(args, 'all-verifications');
  const strict = flagBool(args, 'strict');
  const runBoundaries = flagBool(args, 'boundaries') || all;
  const runDrift = flagBool(args, 'drift') || all;
  const runCoverage = flagBool(args, 'coverage') || all;
  const runAgent = flagBool(args, 'agent-tests') || all;
  const runContext = flagBool(args, 'context-tests') || all;
  const runTestImpact = flagBool(args, 'test-impact') || all;
  const verificationId = flagString(args, 'verification');

  const startedAt = new Date().toISOString();
  const commandsRun: { command: string; passed: boolean; note?: string }[] = [];
  let boundaryViolations = 0;
  let warnings = 0;

  if (runBoundaries) {
    try {
      const { evaluateBoundaries, loadTsconfigPaths, scanImports } = await import('@shrkcrft/boundaries');
      const scan = scanImports({ projectRoot: cwd });
      const tsconfigPaths = loadTsconfigPaths(cwd);
      const evalResult = evaluateBoundaries(scan, inspection.boundaryRegistry.list(), {
        ...(tsconfigPaths.aliases.size > 0 ? { tsconfigPaths } : {}),
      });
      boundaryViolations = evalResult.violations.length;
      const fail = strict ? boundaryViolations > 0 : evalResult.counts.error > 0;
      commandsRun.push({
        command: 'boundaries',
        passed: !fail,
        note: `${boundaryViolations} violations (${evalResult.counts.error}err / ${evalResult.counts.warning}warn)`,
      });
      warnings += evalResult.counts.warning;
    } catch (e) {
      commandsRun.push({ command: 'boundaries', passed: false, note: (e as Error).message });
    }
  }

  if (runDrift) {
    try {
      const { buildDriftReport } = await import('@shrkcrft/inspector');
      const drift = buildDriftReport(inspection);
      const fail = drift.counts.error > 0 || (strict && drift.counts.warning > 0);
      commandsRun.push({
        command: 'drift',
        passed: !fail,
        note: `${drift.counts.error}err / ${drift.counts.warning}warn / ${drift.counts.info}info`,
      });
      warnings += drift.counts.warning;
    } catch (e) {
      commandsRun.push({ command: 'drift', passed: false, note: (e as Error).message });
    }
  }

  if (runCoverage) {
    try {
      const { buildCoverageReport } = await import('@shrkcrft/inspector');
      const cov = buildCoverageReport(inspection);
      const gaps = cov.categories.filter((c) => c.score < 80).length;
      const fail = strict && gaps > 0;
      commandsRun.push({
        command: 'coverage',
        passed: !fail,
        note: `overall=${cov.overall}  gaps<80%=${gaps}`,
      });
    } catch (e) {
      commandsRun.push({ command: 'coverage', passed: false, note: (e as Error).message });
    }
  }

  if (runAgent) {
    try {
      const { loadAgentContractTests, runAgentContractTest } = await import('@shrkcrft/inspector');
      const tests = await loadAgentContractTests(inspection);
      const results = tests.map((t) => runAgentContractTest(inspection, t));
      const failed = results.filter((r) => !r.passed).length;
      commandsRun.push({
        command: 'agent-tests',
        passed: failed === 0,
        note: `${results.length - failed}/${results.length} passed`,
      });
    } catch (e) {
      commandsRun.push({ command: 'agent-tests', passed: false, note: (e as Error).message });
    }
  }

  if (runContext) {
    try {
      const { loadContextTests, runContextTest } = await import('@shrkcrft/inspector');
      const tests = await loadContextTests(inspection);
      const results = tests.map((t) => runContextTest(inspection, t));
      const failed = results.filter((r) => !r.passed).length;
      commandsRun.push({
        command: 'context-tests',
        passed: failed === 0,
        note: `${results.length - failed}/${results.length} passed`,
      });
    } catch (e) {
      commandsRun.push({ command: 'context-tests', passed: false, note: (e as Error).message });
    }
  }

  if (runTestImpact) {
    try {
      const { analyzeTestImpact } = await import('@shrkcrft/inspector');
      const files = bundle.plans.flatMap((p) => p.expectedTargets);
      const ti = analyzeTestImpact(inspection, { files });
      // Only fail under --strict when there are missing tests.
      const fail = strict && ti.missingTestFiles.length > 0;
      commandsRun.push({
        command: 'test-impact',
        passed: !fail,
        note: `likely=${ti.likelyTestFiles.length} missing=${ti.missingTestFiles.length} confidence=${ti.confidence}%`,
      });
    } catch (e) {
      commandsRun.push({ command: 'test-impact', passed: false, note: (e as Error).message });
    }
  }

  // Optional explicit verification command from sharkcraft.config (cli-only allow-list).
  if (verificationId) {
    const cfg = inspection.config as { verificationCommands?: readonly { id: string; command: string }[] } | null;
    const entry = cfg?.verificationCommands?.find((v) => v.id === verificationId);
    if (!entry) {
      commandsRun.push({
        command: `verification:${verificationId}`,
        passed: false,
        note: 'not present in sharkcraft.config.ts verificationCommands[]',
      });
    } else {
      commandsRun.push({
        command: `verification:${verificationId}`,
        passed: true,
        note: 'documented (human must run)',
      });
    }
  }

  const finishedAt = new Date().toISOString();
  const passed = commandsRun.every((c) => c.passed);
  const reportFile = `reports/validate-${nowSlug()}.json`;
  const fullPath = nodePath.join(getBundleDir(cwd, bundle.id), reportFile);
  mkdirSync(nodePath.dirname(fullPath), { recursive: true });
  const validation = {
    startedAt,
    finishedAt,
    passed,
    warnings,
    commandsRun,
    boundaryViolations,
    reportFile,
  };
  writeFileSync(fullPath, JSON.stringify(validation, null, 2) + '\n', 'utf8');
  let updated = recordBundleValidation(bundle, validation);
  updated = recomputeBundleStatus(updated);

  // --report: write Markdown + JSON summary into reports/, plus optional HTML.
  const wantReport = flagBool(args, 'report');
  const wantHtml = flagBool(args, 'html');
  if (wantReport || wantHtml) {
    const slug = nowSlug();
    if (wantReport) {
      const md = [
        `# Bundle validation report: ${bundle.id}`,
        '',
        `**Task:** ${bundle.task}`,
        `**Status:** ${updated.status}`,
        `**Started:** ${startedAt}`,
        `**Finished:** ${finishedAt}`,
        `**Passed:** ${passed}`,
        `**Warnings:** ${warnings}`,
        '',
        `## Gate matrix`,
        '| Gate | Result | Note |',
        '| --- | --- | --- |',
        ...commandsRun.map((c) => `| \`${c.command}\` | ${c.passed ? '✅ OK' : '❌ FAIL'} | ${c.note ?? ''} |`),
        '',
        `## Plans (${updated.plans.length})`,
        ...updated.plans.map((p) => `- \`${p.name}\` (${p.templateId}) — **${p.status}**`),
        '',
        `## Affected files`,
        ...(updated.affectedFiles.length === 0
          ? ['(none tracked)']
          : updated.affectedFiles.map((f) => `- \`${f}\``)),
      ].join('\n') + '\n';
      const mdFile = `reports/validate-${slug}.md`;
      writeFileSync(nodePath.join(getBundleDir(cwd, bundle.id), mdFile), md, 'utf8');
      updated = recordBundleReport(updated, mdFile);
      const jsonFile = `reports/validate-${slug}.json`;
      writeFileSync(
        nodePath.join(getBundleDir(cwd, bundle.id), jsonFile),
        JSON.stringify({ bundle: { id: updated.id, task: updated.task, status: updated.status }, validation }, null, 2) + '\n',
        'utf8',
      );
      updated = recordBundleReport(updated, jsonFile);
    }
    if (wantHtml) {
      const html = renderBundleValidationHtml(updated, validation);
      const htmlFile = `reports/validate-${slug}.html`;
      writeFileSync(nodePath.join(getBundleDir(cwd, bundle.id), htmlFile), html, 'utf8');
      updated = recordBundleReport(updated, htmlFile);
    }
  }

  writeFeatureBundle(cwd, updated);

  if (flagBool(args, 'json')) {
    process.stdout.write(asJson(validation) + '\n');
    return passed ? 0 : 1;
  }
  process.stdout.write(`validation ${passed ? 'passed' : 'failed'} (${commandsRun.length} command(s))\n`);
  for (const c of commandsRun) {
    process.stdout.write(`  ${c.passed ? 'OK ' : 'FAIL'} ${c.command.padEnd(16)} ${c.note ?? ''}\n`);
  }
  return passed ? 0 : 1;
}

async function bundleDecompose(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const bundle = loadOrFail(cwd, args.positional[0]);
  if (typeof bundle === 'number') return bundle;
  const inspection = await inspectSharkcraft({ cwd });
  const d = decomposeTask(inspection, bundle.task);
  if (flagBool(args, 'json')) {
    process.stdout.write(asJson(d) + '\n');
    return 0;
  }
  process.stdout.write(`task: ${d.task}\nverb: ${d.verb}\nsubtasks:\n`);
  for (const s of d.subtasks) process.stdout.write(`  - ${s.id} (${s.riskLevel}): ${s.title}\n`);
  return 0;
}

export const bundleCommand: ICommandHandler = {
  name: 'bundle',
  description: 'Feature workflow bundles (multi-plan, dep graph, apply assist, validate).',
  usage:
    'shrk bundle create|list|show|status|report|commands|plan|graph|apply-assist|validate|replay|decompose|record-apply|next|review [...args]',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    const rest = args.positional.slice(1);
    if (!sub || !SUBCOMMANDS.has(sub)) {
      process.stderr.write(`Usage: ${this.usage}\n`);
      return 2;
    }
    const subArgs: ParsedArgs = { ...args, positional: rest };
    switch (sub) {
      case 'create': return bundleCreate(subArgs);
      case 'list': return bundleList(subArgs);
      case 'show': return bundleShow(subArgs);
      case 'status': return bundleStatus(subArgs);
      case 'report': return bundleReport(subArgs);
      case 'commands': return bundleCommands(subArgs);
      case 'plan': return bundlePlan(subArgs);
      case 'graph': return bundleGraph(subArgs);
      case 'apply-plan':
      case 'apply-assist': return bundleApplyAssist(subArgs);
      case 'validate': return bundleValidate(subArgs);
      case 'decompose': return bundleDecompose(subArgs);
      case 'record-apply': return bundleRecordApply(subArgs);
      case 'replay': return bundleReplay(subArgs);
      case 'next': return bundleNext(subArgs);
      case 'review': return bundleReview(subArgs);
      case 'diff': return bundleDiffCommand(subArgs);
      default: return 2;
    }
  },
};

async function bundleNext(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const bundle = loadOrFail(cwd, args.positional[0]);
  if (typeof bundle === 'number') return bundle;
  const summary = computeBundleStatusSummary(cwd, bundle);
  if (flagBool(args, 'json')) {
    process.stdout.write(asJson({
      id: bundle.id,
      status: summary.status,
      nextSafeAction: summary.nextSafeAction,
      blockedPlans: blockedPlans(bundle, summary),
    }) + '\n');
    return 0;
  }
  process.stdout.write(`${summary.nextSafeAction}\n`);
  return 0;
}

function blockedPlans(
  bundle: IFeatureBundle,
  _summary: IBundleStatusSummary,
): readonly { name: string; blockedBy: readonly string[] }[] {
  const applied = new Set(bundle.plans.filter((p) => p.status === 'applied').map((p) => p.name));
  const out: { name: string; blockedBy: readonly string[] }[] = [];
  const blockedBy = new Map<string, string[]>();
  for (const e of bundle.dependencies) {
    const list = blockedBy.get(e.to) ?? [];
    if (!applied.has(e.from)) list.push(e.from);
    blockedBy.set(e.to, list);
  }
  for (const p of bundle.plans) {
    if (applied.has(p.name)) continue;
    const deps = blockedBy.get(p.name) ?? [];
    if (deps.length > 0) out.push({ name: p.name, blockedBy: deps });
  }
  return out;
}

async function bundleReview(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const bundle = loadOrFail(cwd, args.positional[0]);
  if (typeof bundle === 'number') return bundle;
  const inspection = await inspectSharkcraft({ cwd });
  // Pull boundary suggestions for files the bundle plans expect to touch.
  const expected = bundle.plans.flatMap((p) => p.expectedTargets);
  const review = {
    bundleId: bundle.id,
    task: bundle.task,
    status: bundle.status,
    plans: bundle.plans.map((p) => ({
      name: p.name,
      templateId: p.templateId,
      status: p.status,
      expectedTargets: p.expectedTargets,
    })),
    dependencyOrder: buildPlanDependencyGraph(inspection, bundle).order,
    introducedBoundaryRisks: expected
      .filter((f) => f.includes('/internal/') || f.includes('/private/'))
      .map((f) => ({ file: f, reason: 'targets a path commonly under boundary rules' })),
    missingValidations: bundle.validations.length === 0,
    humanApprovalGates: bundle.plans
      .filter((p) => p.status !== 'applied' && p.status !== 'intent')
      .map((p) => `shrk apply .sharkcraft/bundles/${bundle.id}/plans/${p.file} --verify-signature`),
  };
  if (flagBool(args, 'json')) {
    process.stdout.write(asJson(review) + '\n');
    return 0;
  }
  process.stdout.write(header(`Bundle review: ${bundle.id}`));
  process.stdout.write(kv('task', bundle.task) + '\n');
  process.stdout.write(kv('status', bundle.status) + '\n');
  process.stdout.write(`\nDependency order: ${review.dependencyOrder.join(' → ') || '(empty)'}\n`);
  process.stdout.write(`Plans:\n`);
  for (const p of review.plans) {
    process.stdout.write(`  ${p.status.padEnd(10)} ${p.name} (${p.templateId})\n`);
  }
  if (review.introducedBoundaryRisks.length > 0) {
    process.stdout.write('\nIntroduced boundary risks:\n');
    for (const r of review.introducedBoundaryRisks)
      process.stdout.write(`  - ${r.file}: ${r.reason}\n`);
  }
  if (review.missingValidations) {
    process.stdout.write('\n! No validations have been run yet. Run:\n');
    process.stdout.write(`    shrk bundle validate ${bundle.id} --all-verifications --report\n`);
  }
  if (review.humanApprovalGates.length > 0) {
    process.stdout.write('\nHuman approval gates:\n');
    for (const c of review.humanApprovalGates) process.stdout.write(`  $ ${c}\n`);
  }
  return 0;
}

async function bundleReplay(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  // Sub-form: `shrk bundle replay scaffold github-actions [...]`
  if (args.positional[0] === 'scaffold') {
    return bundleReplayScaffold({ ...args, positional: args.positional.slice(1) });
  }
  const all = flagBool(args, 'all') || args.positional[0] === '--all';
  const strict = flagBool(args, 'strict');
  if (all) {
    const sinceMatch = flagString(args, 'since');
    const batch = replayAllBundles(cwd, {
      strict,
      ...(sinceMatch ? { match: sinceMatch } : {}),
    });
    if (flagBool(args, 'html')) {
      const out =
        flagString(args, 'output') ?? nodePath.join(cwd, '.sharkcraft', 'reports', 'bundle-replay-all.html');
      const abs = nodePath.isAbsolute(out) ? out : nodePath.resolve(cwd, out);
      mkdirSync(nodePath.dirname(abs), { recursive: true });
      writeFileSync(abs, renderBundleReplayBatchHtml(batch), 'utf8');
      if (!flagBool(args, 'json')) process.stdout.write(`Wrote ${abs}\n`);
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(batch) + '\n');
      return batch.tamperedCount + batch.missingCount === 0 ? 0 : 1;
    }
    if (flagBool(args, 'report')) {
      const reportPath = nodePath.join(cwd, '.sharkcraft', 'reports', 'bundle-replay-all.md');
      mkdirSync(nodePath.dirname(reportPath), { recursive: true });
      const lines: string[] = [];
      lines.push('# Bundle replay (all)');
      lines.push('');
      lines.push(
        `Total: ${batch.total} · Clean: ${batch.cleanCount} · Warnings: ${batch.warningsCount} · Tampered: ${batch.tamperedCount} · Missing: ${batch.missingCount}`,
      );
      lines.push('');
      lines.push('| Bundle | Status | Audit | Issues |');
      lines.push('| --- | --- | ---: | ---: |');
      for (const r of batch.reports) {
        const issuesCount = r.planEntries.reduce((acc, p) => acc + p.issues.length, 0) + r.warnings.length;
        lines.push(`| \`${r.bundleId}\` | ${r.status} | ${r.auditEntries} | ${issuesCount} |`);
      }
      if (batch.topIssues.length > 0) {
        lines.push('');
        lines.push('## Top issues');
        for (const i of batch.topIssues) {
          lines.push(`- \`${i.bundleId}\`${i.planName ? ` / \`${i.planName}\`` : ''} — **${i.code}** ${i.message}`);
        }
      }
      writeFileSync(reportPath, lines.join('\n') + '\n', 'utf8');
      process.stdout.write(`Wrote ${reportPath}\n`);
    }
    process.stdout.write(header(`Bundle replay (${batch.total})`));
    process.stdout.write(
      `clean=${batch.cleanCount}  warnings=${batch.warningsCount}  tampered=${batch.tamperedCount}  missing=${batch.missingCount}\n`,
    );
    for (const r of batch.reports) {
      process.stdout.write(`  ${r.status.padEnd(10)} ${r.bundleId}\n`);
    }
    if (batch.topIssues.length > 0) {
      process.stdout.write('\nTop issues:\n');
      for (const i of batch.topIssues) {
        process.stdout.write(`  ${i.bundleId}${i.planName ? `/${i.planName}` : ''}: ${i.code} — ${i.message}\n`);
      }
    }
    return batch.tamperedCount + batch.missingCount === 0 ? 0 : 1;
  }
  const id = args.positional[0];
  if (!id) {
    process.stderr.write('Usage: shrk bundle replay <id> [--strict] [--json]  |  shrk bundle replay --all\n');
    return 2;
  }
  const result = replayBundle(cwd, id, { strict });
  if (flagBool(args, 'json')) {
    process.stdout.write(asJson(result) + '\n');
    return result.status === BundleReplayStatus.Clean || result.status === BundleReplayStatus.Warnings ? 0 : 1;
  }
  process.stdout.write(header(`Bundle replay: ${id}`));
  process.stdout.write(`status: ${result.status}\n`);
  process.stdout.write(`audit entries: ${result.auditEntries}\n`);
  for (const p of result.planEntries) {
    const label = p.applied ? 'applied' : 'unapplied';
    process.stdout.write(`  ${p.planName.padEnd(28)} ${label.padEnd(10)} ${p.currentHash ?? '(no-hash)'}\n`);
    for (const issue of p.issues) process.stdout.write(`    ! ${issue}\n`);
  }
  if (result.warnings.length > 0) {
    process.stdout.write('Warnings:\n');
    for (const w of result.warnings) process.stdout.write(`  - ${w.code}: ${w.message}\n`);
  }
  if (result.recommendedFix) {
    process.stdout.write(`\nFix: ${result.recommendedFix}\n`);
  }
  return result.status === BundleReplayStatus.Clean || result.status === BundleReplayStatus.Warnings ? 0 : 1;
}

async function bundleReplayScaffold(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const target = args.positional[0];
  if (target !== 'github-actions') {
    process.stderr.write(
      'Usage: shrk bundle replay scaffold github-actions [--schedule weekly|daily|manual] [--with-report-site] [--output <path>] [--write] [--force]\n',
    );
    return 2;
  }
  const scheduleRaw = flagString(args, 'schedule') ?? 'weekly';
  const validSchedules = new Set(['weekly', 'daily', 'manual']);
  if (!validSchedules.has(scheduleRaw)) {
    process.stderr.write(`Unknown --schedule "${scheduleRaw}". Use weekly|daily|manual.\n`);
    return 2;
  }
  const schedule = scheduleRaw as BundleReplaySchedule;
  const body = renderBundleReplayWorkflow({
    schedule,
    ...(flagBool(args, 'with-report-site') ? { withReportSite: true } : {}),
  });
  const outputRel =
    flagString(args, 'output') ?? '.github/workflows/sharkcraft-bundle-replay.yml';
  const outputAbs = nodePath.isAbsolute(outputRel) ? outputRel : nodePath.resolve(cwd, outputRel);
  const wantWrite = flagBool(args, 'write');
  const force = flagBool(args, 'force');
  if (!wantWrite) {
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({ mode: 'dry-run', output: outputAbs, bytes: body.length, body }) + '\n',
      );
      return 0;
    }
    process.stdout.write(header(`Bundle-replay CI scaffold (dry-run)`));
    process.stdout.write(`output: ${outputAbs}\n\n${body}`);
    return 0;
  }
  if (existsSync(outputAbs) && !force) {
    process.stderr.write(`Refusing to overwrite ${outputAbs}. Pass --force.\n`);
    return 1;
  }
  mkdirSync(nodePath.dirname(outputAbs), { recursive: true });
  writeFileSync(outputAbs, body, 'utf8');
  if (flagBool(args, 'json'))
    process.stdout.write(asJson({ mode: 'write', output: outputAbs, bytes: body.length }) + '\n');
  else process.stdout.write(`Wrote ${outputAbs}\n`);
  return 0;
}

async function bundleRecordApply(args: ParsedArgs): Promise<number> {
  const id = args.positional[0];
  const planName = args.positional[1];
  if (!id || !planName) {
    process.stderr.write('Usage: shrk bundle record-apply <id> <planName> [--note "<note>"]\n');
    return 2;
  }
  const cwd = resolveCwd(args);
  const bundle = readFeatureBundle(cwd, id);
  if (!bundle) {
    process.stderr.write(`No bundle "${id}".\n`);
    return 1;
  }
  if (!bundle.plans.some((p) => p.name === planName)) {
    process.stderr.write(`No plan "${planName}" in bundle ${id}.\n`);
    return 1;
  }
  const note = flagString(args, 'note');
  let updated = markBundlePlanApplied(bundle, planName, note);

  // Append to the audit log under reports/apply-audit.log
  const auditFile = nodePath.join(getBundleDir(cwd, id), 'reports', 'apply-audit.log');
  mkdirSync(nodePath.dirname(auditFile), { recursive: true });
  const line = `${new Date().toISOString()}  applied  ${planName}${note ? '  ' + note : ''}\n`;
  try {
    const existing = existsSync(auditFile) ? readFileSync(auditFile, 'utf8') : '';
    writeFileSync(auditFile, existing + line, 'utf8');
  } catch {
    writeFileSync(auditFile, line, 'utf8');
  }
  updated = recordBundleReport(updated, 'reports/apply-audit.log');
  updated = recomputeBundleStatus(updated);
  writeFeatureBundle(cwd, updated);
  if (flagBool(args, 'json')) {
    process.stdout.write(asJson({ id, planName, status: 'applied' }) + '\n');
    return 0;
  }
  process.stdout.write(`Recorded apply of ${planName} (bundle ${id}). Status: ${updated.status}\n`);
  return 0;
}

async function bundleDiffCommand(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const aId = args.positional[0];
  const bId = args.positional[1];
  if (!aId || !bId) {
    process.stderr.write('Usage: shrk bundle diff <bundleA> <bundleB> [--format text|markdown|html|json] [--output <path>]\n');
    return 2;
  }
  const formatRaw = (flagString(args, 'format') ?? 'text') as BundleDiffFormat;
  const valid = new Set<BundleDiffFormat>(['text', 'markdown', 'html', 'json']);
  if (!valid.has(formatRaw)) {
    process.stderr.write(`Unknown --format "${formatRaw}". Use text|markdown|html|json.\n`);
    return 2;
  }
  const diff = buildBundleDiffFromIds(cwd, aId, bId);
  if ('error' in diff) {
    process.stderr.write(diff.error + '\n');
    return 1;
  }
  const body = renderBundleDiff(diff, formatRaw);
  const output = flagString(args, 'output');
  if (output) {
    const abs = nodePath.isAbsolute(output) ? output : nodePath.resolve(cwd, output);
    mkdirSync(nodePath.dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf8');
    process.stdout.write(`Wrote ${abs}\n`);
    return 0;
  }
  if (flagBool(args, 'json')) {
    // honour --json as a shortcut for --format json
    process.stdout.write(renderBundleDiff(diff, 'json'));
    return 0;
  }
  process.stdout.write(body);
  return 0;
}

