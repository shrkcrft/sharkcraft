import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  archiveDevSession,
  buildAgentBrief,
  buildTaskPacket,
  computeDevNextAction,
  createDevSessionState,
  DevSessionPhase,
  DevSessionPlanStatus,
  DevSessionSignatureStatus,
  diffDevSessions,
  getDevSessionDir,
  inspectSharkcraft,
  isDevSessionActive,
  listDevCleanCandidates,
  listDevSessions,
  listDevSessionsDetailed,
  parseDurationToMs,
  recordAppliedPlan,
  recordReportFile,
  recordValidation,
  recomputePhase,
  renderDevSessionFinalReport,
  renderDevSessionHtml,
  reviewSavedPlan,
  scanDevSession,
  setDevNextAction,
  setDevSessionBriefFile,
  setDevSessionPhase,
  upsertDevPlanEntry,
  writeDevSessionState,
  type IDevSessionLoad,
  type IDevSessionState,
  type ITaskPacket,
} from '@shrkcrft/inspector';
import {
  buildSavedPlan,
  generate,
  OverwriteStrategy,
  PLAN_SECRET_ENV,
  savePlanToFile,
  signPlan,
} from '@shrkcrft/generator';
import {
  flagBool,
  flagList,
  flagString,
  flagVars,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';
import { printError } from '../output/print-error.ts';
import { runValidationLoop } from '../validation/run-validation-loop.ts';

const SUBCOMMANDS = new Set([
  'start',
  'plan',
  'status',
  'next',
  'continue',
  'validate',
  'report',
  'list',
  'mark-applied',
  'mark-validated',
  'diff',
  'archive',
  'clean',
  'open',
  'plans',
  'reports',
  'commands',
  'cycle',
]);

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function loadSessionOrFail(args: ParsedArgs): { load: IDevSessionLoad; cwd: string } | number {
  const id = args.positional[0];
  if (!id) {
    process.stderr.write('Usage: shrk dev <subcommand> <sessionId>\n');
    return 2;
  }
  const cwd = resolveCwd(args);
  const load = scanDevSession(cwd, id);
  if (!load) {
    process.stderr.write(`No session "${id}".\n`);
    return 1;
  }
  return { load, cwd };
}

async function startSession(args: ParsedArgs): Promise<number> {
  const task = args.positional.join(' ').trim();
  if (!task) {
    process.stderr.write('Usage: shrk dev start "<task>"\n');
    return 2;
  }
  const cwd = resolveCwd(args);
  const inspection = await inspectSharkcraft({ cwd });
  const packet = buildTaskPacket(inspection, task, { maxTokens: 3500 });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const id = `${stamp}-${slugify(task)}`;
  const dir = getDevSessionDir(cwd, id);
  mkdirSync(dir, { recursive: true });
  mkdirSync(nodePath.join(dir, 'plans'), { recursive: true });
  mkdirSync(nodePath.join(dir, 'reports'), { recursive: true });

  // Write all the deterministic artifacts the spec asks for.
  writeFileSync(nodePath.join(dir, 'task.md'), `# ${task}\n`, 'utf8');
  writeFileSync(nodePath.join(dir, 'task-packet.json'), JSON.stringify(packet, null, 2) + '\n', 'utf8');
  writeFileSync(
    nodePath.join(dir, 'context.md'),
    `# Context for: ${task}\n\n${packet.context.body}\n`,
    'utf8',
  );
  writeFileSync(
    nodePath.join(dir, 'action-hints.json'),
    JSON.stringify(packet.actionHints, null, 2) + '\n',
    'utf8',
  );

  const pipelineInfo = {
    selected: packet.recommendedPipelines[0] ?? null,
    alternatives: packet.recommendedPipelines.slice(1),
    humanReviewPoints: packet.humanReviewPoints,
  };
  writeFileSync(
    nodePath.join(dir, 'recommended-pipeline.json'),
    JSON.stringify(pipelineInfo, null, 2) + '\n',
    'utf8',
  );

  // Commands script — preserved from `shrk session start` so the two
  // workflows produce a comparable bundle.
  const cmdLines = [
    '#!/usr/bin/env bash',
    '# Commands recommended by SharkCraft for this task.',
    '# Review before running.',
    ...packet.recommendedCliCommands,
    '',
    packet.suggestedGen?.dryRunCommand ?? '',
  ].filter(Boolean);
  writeFileSync(nodePath.join(dir, 'commands.sh'), cmdLines.join('\n') + '\n', 'utf8');

  let state = createDevSessionState({ id, task, projectRoot: cwd, packet });
  // --brief: write brief.md inside the session and record path on the state.
  let briefFile: string | undefined;
  if (flagBool(args, 'brief')) {
    try {
      const brief = await buildAgentBrief(inspection, { task });
      const briefPath = nodePath.join(dir, 'brief.md');
      writeFileSync(briefPath, brief.markdown, 'utf8');
      briefFile = 'brief.md';
      state = setDevSessionBriefFile(state, briefFile);
    } catch (e) {
      state = { ...state, warnings: [...state.warnings, `brief: ${(e as Error).message}`] };
    }
  }
  writeDevSessionState(cwd, state);

  const nextSteps = buildNextStepsMarkdown(id, task, packet, state);
  writeFileSync(nodePath.join(dir, 'next-steps.md'), nextSteps, 'utf8');

  if (flagBool(args, 'json')) {
    const files = [
      'task.md',
      'task-packet.json',
      'context.md',
      'action-hints.json',
      'recommended-pipeline.json',
      'next-steps.md',
      'commands.sh',
      'session.json',
    ];
    if (briefFile) files.push(briefFile);
    process.stdout.write(
      asJson({
        id,
        dir,
        task,
        phase: state.phase,
        selectedPipeline: state.selectedPipeline,
        selectedTemplates: state.selectedTemplates,
        nextAction: state.nextAction,
        briefFile: briefFile ?? null,
        files,
      }) + '\n',
    );
    return 0;
  }

  process.stdout.write(header(`Dev session started: ${id}`));
  process.stdout.write(kv('task', task) + '\n');
  process.stdout.write(kv('dir', dir) + '\n');
  process.stdout.write(
    kv('pipeline', state.selectedPipeline ?? '(none)') + '\n',
  );
  if (state.selectedTemplates.length > 0) {
    process.stdout.write(kv('top templates', state.selectedTemplates.slice(0, 3).join(', ')) + '\n');
  }
  if (packet.relevantRules.length > 0) {
    process.stdout.write(
      kv('top rules', packet.relevantRules.slice(0, 3).map((r) => r.id).join(', ')) + '\n',
    );
  }
  if (packet.verificationCommands.length > 0) {
    process.stdout.write('\nVerification commands:\n');
    for (const c of packet.verificationCommands.slice(0, 5)) {
      process.stdout.write(`  $ ${c}\n`);
    }
  }
  if (packet.forbiddenActions.length > 0) {
    process.stdout.write('\nForbidden actions:\n');
    for (const a of packet.forbiddenActions.slice(0, 5)) {
      process.stdout.write(`  ✗ ${a}\n`);
    }
  }
  process.stdout.write('\nFiles written:\n');
  const filesWritten = [
    'task.md',
    'task-packet.json',
    'context.md',
    'action-hints.json',
    'recommended-pipeline.json',
    'next-steps.md',
    'commands.sh',
    'session.json',
  ];
  if (briefFile) filesWritten.push(briefFile);
  for (const f of filesWritten) {
    process.stdout.write(`  + ${f}\n`);
  }
  if (briefFile) {
    process.stdout.write(`\nBrief: ${briefFile} (--brief was set)\n`);
  } else {
    process.stdout.write(
      `\nTip: run \`shrk brief "${task}" --session ${id} --output .sharkcraft/sessions/${id}/brief.md\` to add a brief.\n`,
    );
  }
  process.stdout.write(`\nNext: ${state.nextAction}\n`);
  return 0;
}

function buildNextStepsMarkdown(
  id: string,
  task: string,
  packet: ITaskPacket,
  state: IDevSessionState,
): string {
  const lines: string[] = [];
  lines.push(`# Next steps for: ${task}`);
  lines.push('');
  lines.push(`Session id: \`${id}\``);
  lines.push(`Phase: \`${state.phase}\``);
  lines.push('');
  lines.push('## Recommended path');
  lines.push('');
  if (packet.suggestedGen) {
    lines.push(`1. Generate plan(s) for template \`${packet.suggestedGen.templateId}\`:`);
    lines.push('   ```');
    lines.push(`   shrk dev plan ${id} --template ${packet.suggestedGen.templateId} --name <name>` +
      (packet.suggestedGen.requiredVariables.length > 0
        ? ' ' + packet.suggestedGen.requiredVariables.map((v) => `--var ${v}=<${v}>`).join(' ')
        : ''));
    lines.push('   ```');
  } else {
    lines.push(`1. No obvious generation template — keep reviewing context:`);
    lines.push('   ```');
    lines.push(`   shrk dev continue ${id}`);
    lines.push('   ```');
  }
  lines.push(`2. After plans are saved + reviewed, apply them (human approval required):`);
  lines.push('   ```');
  lines.push(`   shrk apply .sharkcraft/sessions/${id}/plans/<plan>.json --verify-signature`);
  lines.push('   ```');
  lines.push(`3. Validate the changes:`);
  lines.push('   ```');
  lines.push(`   shrk dev validate ${id}`);
  lines.push('   ```');
  lines.push(`4. Generate the audit-trail report:`);
  lines.push('   ```');
  lines.push(`   shrk dev report ${id}`);
  lines.push('   ```');
  lines.push('');
  if (packet.forbiddenActions.length > 0) {
    lines.push('## Forbidden');
    lines.push('');
    for (const a of packet.forbiddenActions) lines.push(`- ${a}`);
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

interface IPlanTarget {
  templateId: string;
  /** Slug used as the on-disk plan filename. */
  planName: string;
  /** User-provided template name (passed to generator). Undefined ⇒ generator does not auto-fill `name`/`className`/etc. */
  userName?: string;
  variables: Record<string, string>;
}

async function planSession(args: ParsedArgs): Promise<number> {
  const loaded = loadSessionOrFail(args);
  if (typeof loaded === 'number') return loaded;
  const { load, cwd } = loaded;
  if (!load.packet) {
    process.stderr.write(
      `Session ${load.id} has no task-packet.json — cannot plan. Re-run shrk dev start.\n`,
    );
    return 1;
  }
  if (!load.state) {
    process.stderr.write(
      `Session ${load.id} has no session.json (legacy session). ` +
        `Use shrk dev status / shrk session report for legacy sessions.\n`,
    );
    return 1;
  }
  const packet = load.packet;
  let state = load.state;

  const explicitTemplateId = flagString(args, 'template');
  const explicitName = flagString(args, 'name');
  const variables = flagVars(args);
  const wantSign =
    flagBool(args, 'sign') || Boolean(process.env[PLAN_SECRET_ENV]);
  const wantAll = flagBool(args, 'all');
  const wantJson = flagBool(args, 'json');

  // Decide which templates to plan. `planName` is the on-disk filename slug;
  // `userName` is only set when the human actually passed --name (so the
  // generator's auto-filled `name`/`className`/etc. don't mask missing-var
  // intent generation).
  const targets: IPlanTarget[] = [];
  if (explicitTemplateId) {
    const planName = explicitName ?? explicitTemplateId.replace(/[^a-z0-9]+/gi, '-');
    const target: IPlanTarget = {
      templateId: explicitTemplateId,
      planName,
      variables: { ...variables },
    };
    if (explicitName) target.userName = explicitName;
    targets.push(target);
  } else if (wantAll) {
    for (const t of packet.relevantTemplates.slice(0, 3)) {
      targets.push({
        templateId: t.id,
        planName: t.id.replace(/[^a-z0-9]+/gi, '-'),
        variables: {},
      });
    }
  } else if (packet.suggestedGen) {
    const g = packet.suggestedGen;
    const target: IPlanTarget = {
      templateId: g.templateId,
      planName: explicitName ?? g.templateId.replace(/[^a-z0-9]+/gi, '-'),
      variables: { ...variables },
    };
    if (explicitName) target.userName = explicitName;
    targets.push(target);
  } else {
    process.stderr.write(
      `No template suggested for this task and --template was not provided.\n` +
        `Try: shrk dev plan ${load.id} --template <id> --name <name>\n`,
    );
    return 1;
  }

  const inspection = await inspectSharkcraft({ cwd });
  const plansDir = nodePath.join(load.dir, 'plans');
  const reportsDir = nodePath.join(load.dir, 'reports');
  mkdirSync(plansDir, { recursive: true });
  mkdirSync(reportsDir, { recursive: true });

  const results: Array<Record<string, unknown>> = [];

  for (const target of targets) {
    const template = inspection.templateRegistry.get(target.templateId);
    if (!template) {
      results.push({
        templateId: target.templateId,
        status: 'unknown-template',
        message: `Template "${target.templateId}" is not registered in this project.`,
      });
      continue;
    }

    // Generate dry-run plan, save under plans/<planName>.json. We only pass
    // `name` to the generator if the user explicitly supplied --name; otherwise
    // the generator must report `name` as missing (so we write an intent file
    // instead of silently auto-filling).
    const genResult = generate(template, {
      templateId: template.id,
      ...(target.userName ? { name: target.userName } : {}),
      variables: target.variables,
      projectRoot: cwd,
      overwriteStrategy: OverwriteStrategy.Never,
      write: false,
    });
    if (!genResult.ok) {
      results.push({
        templateId: target.templateId,
        status: 'generation-error',
        message: genResult.error.message,
      });
      continue;
    }
    const { plan } = genResult.value;

    // The generator's own validator reports missing-required-variable warnings —
    // trust it (it already accounts for buildNameVariables auto-filling
    // name/pascal/className/etc. from --name).
    const missingFromWarnings = plan.warnings
      .map((w) => /^(\w+):\s+Variable\s+'\w+'\s+is required/.exec(w)?.[1])
      .filter((m): m is string => typeof m === 'string');

    if (missingFromWarnings.length > 0 || plan.changes.length === 0) {
      const missing =
        missingFromWarnings.length > 0
          ? missingFromWarnings
          : (template.variables ?? []).filter((v) => v.required).map((v) => v.name);
      const intentName = `${target.templateId.replace(/[^a-z0-9]+/gi, '-')}.intent.md`;
      const intentBody = buildPlanIntentMarkdown(target, template, missing, load.id);
      writeFileSync(nodePath.join(plansDir, intentName), intentBody, 'utf8');
      state = upsertDevPlanEntry(state, {
        name: intentName.replace(/\.intent\.md$/, ''),
        templateId: target.templateId,
        ...(target.planName ? { generatedName: target.planName } : {}),
        variables: target.variables,
        missingVariables: missing,
        status: DevSessionPlanStatus.Intent,
        file: intentName,
        signed: false,
      });
      results.push({
        templateId: target.templateId,
        status: 'intent',
        file: `plans/${intentName}`,
        missingVariables: missing,
      });
      continue;
    }

    if (plan.hasConflicts) {
      const conflicts = plan.changes
        .filter((c) => String(c.type) === 'conflict')
        .map((c) => c.relativePath);
      results.push({
        templateId: target.templateId,
        status: 'conflicts',
        conflicts,
      });
      continue;
    }
    let saved = buildSavedPlan({
      templateId: template.id,
      ...(target.planName ? { name: target.planName } : {}),
      variables: target.variables,
      projectRoot: cwd,
      plan,
    });
    let signed = false;
    if (wantSign) {
      const r = signPlan(saved);
      if (r.ok) {
        saved = r.value;
        signed = true;
      } else {
        results.push({
          templateId: target.templateId,
          status: 'sign-error',
          message: r.error.message,
        });
        continue;
      }
    }
    const planFile = `${target.planName}.json`;
    const planFullPath = nodePath.join(plansDir, planFile);
    const saveResult = savePlanToFile(saved, planFullPath);
    if (!saveResult.ok) {
      results.push({
        templateId: target.templateId,
        status: 'save-error',
        message: saveResult.error.message,
      });
      continue;
    }

    // Run plan review and store under reports/.
    let reviewJsonName: string | undefined;
    let reviewMdName: string | undefined;
    try {
      const review = reviewSavedPlan(inspection, planFullPath);
      reviewJsonName = `plan-review-${target.planName}.json`;
      writeFileSync(
        nodePath.join(reportsDir, reviewJsonName),
        JSON.stringify(review, null, 2) + '\n',
        'utf8',
      );
      reviewMdName = `plan-review-${target.planName}.md`;
      writeFileSync(nodePath.join(reportsDir, reviewMdName), renderReviewMarkdown(review), 'utf8');
      state = recordReportFile(state, `reports/${reviewJsonName}`);
      state = recordReportFile(state, `reports/${reviewMdName}`);
    } catch (e) {
      results.push({
        templateId: target.templateId,
        status: 'review-error',
        message: (e as Error).message,
      });
      // continue: the plan is still saved, just no review captured.
    }

    state = upsertDevPlanEntry(state, {
      name: target.planName,
      templateId: target.templateId,
      ...(target.planName ? { generatedName: target.planName } : {}),
      variables: target.variables,
      missingVariables: [],
      status: reviewJsonName ? DevSessionPlanStatus.Reviewed : DevSessionPlanStatus.Saved,
      file: planFile,
      signed,
      ...(reviewJsonName ? { reviewReportFile: reviewJsonName } : {}),
      ...(reviewMdName ? { reviewReportMarkdownFile: reviewMdName } : {}),
    });

    results.push({
      templateId: target.templateId,
      status: reviewJsonName ? 'reviewed' : 'saved',
      file: `plans/${planFile}`,
      signed,
      ...(reviewJsonName ? { reviewReportFile: `reports/${reviewJsonName}` } : {}),
    });
  }

  // Update phase + next action.
  const scanAfter = scanDevSession(cwd, load.id)!;
  const newPhase = recomputePhase(state, scanAfter);
  state = setDevSessionPhase(state, newPhase);
  const nextAction = computeDevNextAction({ ...scanAfter, state });
  state = setDevNextAction(state, nextAction.command);
  writeDevSessionState(cwd, state);

  if (wantJson) {
    process.stdout.write(asJson({ id: load.id, plans: results, nextAction: state.nextAction }) + '\n');
    return 0;
  }
  process.stdout.write(header(`Dev plan: ${load.id}`));
  for (const r of results) {
    process.stdout.write(`  ${String(r.status).padEnd(14)} ${r.file ?? r.templateId}\n`);
    if (Array.isArray(r.missingVariables)) {
      process.stdout.write(`    missing: ${(r.missingVariables as string[]).join(', ')}\n`);
    }
    if (r.message) process.stdout.write(`    note: ${r.message}\n`);
    if (r.reviewReportFile) process.stdout.write(`    review: ${r.reviewReportFile}\n`);
  }
  process.stdout.write(`\nPhase: ${state.phase}\n`);
  process.stdout.write(`Next: ${state.nextAction}\n`);
  return 0;
}

function buildPlanIntentMarkdown(
  target: IPlanTarget,
  template: { id: string; name: string; variables?: readonly { name: string; required?: boolean; description?: string }[] },
  missing: readonly string[],
  sessionId: string,
): string {
  const lines: string[] = [];
  lines.push(`# Plan intent: ${template.id}`);
  lines.push('');
  lines.push(`Template: ${template.name}`);
  lines.push('');
  lines.push('## Required variables');
  lines.push('');
  for (const m of missing) {
    const def = (template.variables ?? []).find((v) => v.name === m);
    lines.push(`- \`${m}\`${def?.description ? ` — ${def.description}` : ''}`);
  }
  lines.push('');
  lines.push('## Why these are needed');
  lines.push('');
  lines.push(
    `SharkCraft will not hallucinate variable values. ` +
      `Provide them explicitly so the saved plan is deterministic and signable.`,
  );
  lines.push('');
  lines.push('## Example command');
  lines.push('');
  lines.push('```');
  lines.push(
    `shrk dev plan ${sessionId} --template ${template.id} --name ${target.planName} ` +
      missing.map((m) => `--var ${m}=<value>`).join(' '),
  );
  lines.push('```');
  lines.push('');
  lines.push('## Inspect the template');
  lines.push('');
  lines.push('```');
  lines.push(`shrk templates vars ${template.id}`);
  lines.push('```');
  return lines.join('\n') + '\n';
}

function renderReviewMarkdown(report: {
  source: string;
  templateId?: string;
  files: { type: string; relativePath: string; reason?: string }[];
  signature: string;
  signatureMessage?: string;
  affectedPaths: readonly string[];
  missingTestsHeuristic: readonly string[];
  potentialBoundaryConcerns: readonly { file: string; ruleId: string; severity: string; line: number; importSpecifier: string }[];
  planIntroducedBoundaryConcerns: readonly { file: string; ruleId: string; severity: string; line: number; importSpecifier: string; message: string }[];
  verificationCommands: readonly string[];
  humanApprovalReminder: string;
}): string {
  const lines: string[] = [];
  lines.push(`# Plan review`);
  lines.push('');
  lines.push(`Source: \`${report.source}\``);
  if (report.templateId) lines.push(`Template: \`${report.templateId}\``);
  lines.push(`Signature: \`${report.signature}\`${report.signatureMessage ? ' — ' + report.signatureMessage : ''}`);
  lines.push('');
  lines.push('## Files');
  lines.push('');
  for (const f of report.files) {
    lines.push(`- \`${f.type}\` \`${f.relativePath}\`${f.reason ? ' — ' + f.reason : ''}`);
  }
  lines.push('');
  if (report.affectedPaths.length > 0) {
    lines.push('## Affected path conventions');
    lines.push('');
    for (const p of report.affectedPaths) lines.push(`- \`${p}\``);
    lines.push('');
  }
  if (report.missingTestsHeuristic.length > 0) {
    lines.push('## Missing tests (heuristic)');
    lines.push('');
    for (const m of report.missingTestsHeuristic) lines.push(`- ${m}`);
    lines.push('');
  }
  if (report.planIntroducedBoundaryConcerns.length > 0) {
    lines.push('## Boundary concerns introduced by this plan');
    lines.push('');
    for (const c of report.planIntroducedBoundaryConcerns) {
      lines.push(
        `- **${c.severity.toUpperCase()}** \`${c.file}:${c.line}\` imports \`${c.importSpecifier}\` (rule \`${c.ruleId}\`)`,
      );
      if (c.message) lines.push(`  - ${c.message}`);
    }
    lines.push('');
  }
  if (report.verificationCommands.length > 0) {
    lines.push('## Verification commands');
    lines.push('');
    for (const c of report.verificationCommands) lines.push(`- \`${c}\``);
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  lines.push(report.humanApprovalReminder);
  return lines.join('\n') + '\n';
}

function statusSession(args: ParsedArgs): number {
  const loaded = loadSessionOrFail(args);
  if (typeof loaded === 'number') return loaded;
  const { load } = loaded;
  const state = load.state;
  const next = computeDevNextAction(load);

  if (flagBool(args, 'json')) {
    const summary = {
      id: load.id,
      task: load.task,
      legacy: load.legacy,
      phase: state?.phase ?? null,
      createdAt: state?.createdAt ?? null,
      updatedAt: state?.updatedAt ?? null,
      selectedPipeline: state?.selectedPipeline ?? null,
      selectedTemplates: state?.selectedTemplates ?? [],
      plans: state
        ? state.plans
        : load.plansOnDisk.concat(load.intentFiles).map((f) => ({ file: f, status: 'unknown' })),
      reports: state?.reports ?? load.reportsOnDisk.map((f) => `reports/${f}`),
      validations: state?.validations ?? [],
      appliedPlans: state?.appliedPlans ?? [],
      warnings: state?.warnings ?? [],
      nextAction: next,
    };
    process.stdout.write(asJson(summary) + '\n');
    return 0;
  }

  process.stdout.write(header(`Dev session: ${load.id}`));
  process.stdout.write(kv('task', load.task || '(no task.md)') + '\n');
  if (state) {
    process.stdout.write(kv('phase', state.phase) + '\n');
    process.stdout.write(kv('createdAt', state.createdAt) + '\n');
    process.stdout.write(kv('updatedAt', state.updatedAt) + '\n');
    process.stdout.write(kv('pipeline', state.selectedPipeline ?? '(none)') + '\n');
    if (state.selectedTemplates.length > 0) {
      process.stdout.write(kv('templates', state.selectedTemplates.join(', ')) + '\n');
    }
  } else {
    process.stdout.write(kv('phase', '(legacy — no session.json)') + '\n');
  }

  process.stdout.write('\nPlans:\n');
  if (state && state.plans.length > 0) {
    for (const p of state.plans) {
      process.stdout.write(`  • ${p.name} (${p.status}, template ${p.templateId})${p.signed ? ' [signed]' : ''}\n`);
      if (p.missingVariables.length > 0) {
        process.stdout.write(`      missing: ${p.missingVariables.join(', ')}\n`);
      }
      if (p.reviewReportFile) {
        process.stdout.write(`      review: reports/${p.reviewReportFile}\n`);
      }
    }
  } else if (load.plansOnDisk.length > 0 || load.intentFiles.length > 0) {
    for (const f of load.plansOnDisk) process.stdout.write(`  • plans/${f}\n`);
    for (const f of load.intentFiles) process.stdout.write(`  • plans/${f} (intent)\n`);
  } else {
    process.stdout.write('  (none)\n');
  }

  process.stdout.write('\nValidations:\n');
  if (state && state.validations.length > 0) {
    for (const v of state.validations) {
      process.stdout.write(
        `  • ${v.finishedAt}: ${v.passed ? 'passed' : 'FAILED'} (${v.commandsRun.length} cmd, ${v.boundaryViolations} boundary)\n`,
      );
    }
  } else {
    process.stdout.write('  (not run)\n');
  }

  process.stdout.write('\nApplied plans:\n');
  if (state && state.appliedPlans.length > 0) {
    for (const a of state.appliedPlans) {
      process.stdout.write(`  • plans/${a.file} (applied ${a.appliedAt})\n`);
    }
  } else {
    process.stdout.write('  (none recorded — apply is the explicit human step)\n');
  }

  process.stdout.write('\nNext action:\n');
  process.stdout.write(`  ${next.action}\n`);
  process.stdout.write(`  $ ${next.command}\n`);
  process.stdout.write(`  reason: ${next.reason}\n`);
  if (next.requiresHumanApproval) {
    process.stdout.write(`  ⚠ requires human approval before running\n`);
  }
  return 0;
}

function nextOrContinue(args: ParsedArgs): number {
  const loaded = loadSessionOrFail(args);
  if (typeof loaded === 'number') return loaded;
  const { load, cwd } = loaded;
  const next = computeDevNextAction(load);

  // Persist nextAction in session.json if it changed (no other writes).
  if (load.state && load.state.nextAction !== next.command) {
    const updated = setDevNextAction(load.state, next.command);
    writeDevSessionState(cwd, updated);
  }

  if (flagBool(args, 'json')) {
    process.stdout.write(asJson(next) + '\n');
    return 0;
  }
  process.stdout.write(header(`Next action: ${load.id}`));
  process.stdout.write(`  ${next.action}\n`);
  process.stdout.write(`  $ ${next.command}\n`);
  process.stdout.write(`  reason: ${next.reason}\n`);
  if (next.requiresHumanApproval) {
    process.stdout.write(`  ⚠ requires human approval before running\n`);
  }
  return 0;
}

async function validateSession(args: ParsedArgs): Promise<number> {
  const loaded = loadSessionOrFail(args);
  if (typeof loaded === 'number') return loaded;
  const { load, cwd } = loaded;
  const reportsDir = nodePath.join(load.dir, 'reports');
  mkdirSync(reportsDir, { recursive: true });

  const verificationIds = flagList(args, 'verification');
  const allVerifications = flagBool(args, 'all-verifications');
  const allowPackCommands = flagBool(args, 'allow-pack-commands');
  const wantStrict = flagBool(args, 'strict');
  // flagBool is two-valued (absent → false), so `flagBool(...) !== false` is
  // false when the flag is absent — the opposite of the intended default. Read
  // the raw value: write the report by default, opt out only via --report=false.
  const reportFlag = args.flags.get('report');
  const wantReport = reportFlag !== false && reportFlag !== 'false';
  const wantJson = flagBool(args, 'json');
  const startedAt = new Date().toISOString();
  const reportFileName = `validate-${startedAt.replace(/[:.]/g, '-')}.json`;
  const cmd = flagString(args, 'command');

  if (!wantJson) {
    process.stdout.write(header(`Dev validate: ${load.id}`));
    if (cmd) process.stdout.write(`  command: ${cmd}\n`);
    if (verificationIds.length > 0) {
      process.stdout.write(`  verifications: ${verificationIds.join(', ')}\n`);
    } else if (allVerifications) {
      process.stdout.write(`  verifications: (all configured)\n`);
    }
    if (!allowPackCommands) {
      process.stdout.write(`  pack commands: skipped (pass --allow-pack-commands to opt in)\n`);
    }
    process.stdout.write('\n');
  }

  const result = await runValidationLoop({
    cwd,
    ...(cmd ? { explicitCommand: cmd } : {}),
    verificationIds,
    allVerifications,
    allowPackCommands,
    reportDir: wantReport ? reportsDir : null,
    reportFileName,
    onCommandStart: (label) => {
      if (!wantJson) process.stdout.write(`  → running: ${label}\n`);
    },
  });

  const finishedAt = new Date().toISOString();
  const passedFinal = result.passed && (!wantStrict || result.warnings === 0);

  // Persist into session.json if we have a state object.
  let stateAfter: IDevSessionState | null = load.state;
  if (stateAfter) {
    stateAfter = recordValidation(stateAfter, {
      startedAt,
      finishedAt,
      reportFile: reportFileName,
      passed: passedFinal,
      warnings: result.warnings,
      commandsRun: result.commandsRun.map((c) => {
        const entry: { command: string; passed: boolean; note?: string } = {
          command: c.command,
          passed: c.passed,
        };
        if (c.note !== undefined) entry.note = c.note;
        return entry;
      }),
      boundaryViolations: result.boundaryViolations,
    });
    // If applied plans haven't been tracked explicitly, infer from session
    // plans that the user must have applied something to get to validate.
    if (stateAfter.appliedPlans.length === 0 && stateAfter.plans.length > 0) {
      for (const p of stateAfter.plans.filter((p) => p.status !== DevSessionPlanStatus.Intent)) {
        stateAfter = recordAppliedPlan(stateAfter, {
          file: p.file,
          appliedAt: finishedAt,
          note: 'inferred from dev validate',
        });
      }
    }
    const scanAfter = scanDevSession(cwd, load.id)!;
    const newPhase = passedFinal
      ? DevSessionPhase.Validated
      : recomputePhase(stateAfter, scanAfter);
    stateAfter = setDevSessionPhase(stateAfter, newPhase);
    const next = computeDevNextAction({ ...scanAfter, state: stateAfter });
    stateAfter = setDevNextAction(stateAfter, next.command);
    writeDevSessionState(cwd, stateAfter);
  }

  if (wantJson) {
    process.stdout.write(
      asJson({
        id: load.id,
        passed: passedFinal,
        warnings: result.warnings,
        boundaryViolations: result.boundaryViolations,
        commandsRun: result.commandsRun,
        commandsFailed: result.commandsFailed,
        reportPath: result.reportPath,
        nextAction: stateAfter?.nextAction ?? null,
      }) + '\n',
    );
    return passedFinal ? 0 : 1;
  }

  process.stdout.write(
    `\nValidation: ${result.commandsRun.length} command(s), ${result.commandsFailed.length} failed, ${result.warnings} warning(s)\n`,
  );
  for (const c of result.commandsRun) {
    process.stdout.write(
      `  ${c.passed ? 'OK   ' : 'FAIL '} ${c.command}${c.note ? '  (' + c.note + ')' : ''}\n`,
    );
  }
  if (result.boundaryViolations > 0) {
    process.stdout.write(`  WARN  ${result.boundaryViolations} boundary violation(s)\n`);
  }
  if (result.reportPath) process.stdout.write(`  Report: ${result.reportPath}\n`);
  process.stdout.write(`\nValidation: ${passedFinal ? 'OK ✓' : 'FAILED'}\n`);
  return passedFinal ? 0 : 1;
}

function reportSession(args: ParsedArgs): number {
  const loaded = loadSessionOrFail(args);
  if (typeof loaded === 'number') return loaded;
  const { load, cwd } = loaded;
  const next = computeDevNextAction(load);
  const md = renderDevSessionFinalReport(load, {
    nextActionLine: `${next.action} — \`${next.command}\``,
  });
  const out = nodePath.join(load.dir, 'final-report.md');
  writeFileSync(out, md, 'utf8');
  let htmlOut: string | undefined;
  if (flagBool(args, 'html')) {
    const html = renderDevSessionHtml(load, {
      nextActionLine: `${next.action} — ${next.command}`,
    });
    htmlOut = nodePath.join(load.dir, 'final-report.html');
    writeFileSync(htmlOut, html, 'utf8');
  }

  if (load.state) {
    let state = recordReportFile(load.state, 'final-report.md');
    if (htmlOut) state = recordReportFile(state, 'final-report.html');
    state = setDevSessionPhase(state, DevSessionPhase.Completed);
    state = setDevNextAction(state, `shrk session show ${load.id}`);
    writeDevSessionState(cwd, state);
  }

  if (flagBool(args, 'json')) {
    process.stdout.write(
      asJson({ id: load.id, path: out, ...(htmlOut ? { htmlPath: htmlOut } : {}) }) + '\n',
    );
    return 0;
  }
  process.stdout.write(`Wrote ${out}\n`);
  if (htmlOut) process.stdout.write(`Wrote ${htmlOut}\n`);
  return 0;
}

function listSessionsCmd(args: ParsedArgs): number {
  const cwd = resolveCwd(args);
  const items = listDevSessionsDetailed(cwd);
  if (flagBool(args, 'json')) {
    process.stdout.write(asJson(items) + '\n');
    return 0;
  }
  process.stdout.write(header(`Dev sessions (${items.length})`));
  for (const it of items.slice(0, 20)) {
    const phase = it.phase ?? (it.legacy ? 'legacy' : 'unknown');
    process.stdout.write(`  • ${it.id}  [${phase}]  ${it.task || '(no task)'}\n`);
    if (it.nextAction) process.stdout.write(`      next: ${it.nextAction}\n`);
  }
  if (items.length > 20) process.stdout.write(`  … (${items.length - 20} more)\n`);
  return 0;
}

// ─── Part 3: dev mark-applied / mark-validated ─────────────────────────────

function markApplied(args: ParsedArgs): number {
  const id = args.positional[0];
  const planArg = args.positional[1];
  if (!id || !planArg) {
    process.stderr.write('Usage: shrk dev mark-applied <sessionId> <planPath> [--note "..."]\n');
    return 2;
  }
  const cwd = resolveCwd(args);
  const load = scanDevSession(cwd, id);
  if (!load) {
    process.stderr.write(`No session "${id}".\n`);
    return 1;
  }
  if (!load.state) {
    process.stderr.write(
      `Session ${id} has no session.json (legacy). mark-applied requires a v1 session.\n`,
    );
    return 1;
  }
  // Resolve the plan to a path relative to plans/ within the session.
  const planFile = resolveSessionPlanFile(load, planArg);
  if (!planFile) {
    process.stderr.write(
      `Plan "${planArg}" not found under .sharkcraft/sessions/${id}/plans/.\n`,
    );
    return 1;
  }
  const note = flagString(args, 'note');
  let state: IDevSessionState = recordAppliedPlan(load.state, {
    file: planFile,
    appliedAt: new Date().toISOString(),
    ...(note ? { note } : { note: 'recorded via shrk dev mark-applied' }),
  });
  // Promote plan entry status.
  const planEntry = load.state.plans.find((p) => p.file === planFile);
  if (planEntry) {
    state = upsertDevPlanEntry(state, {
      name: planEntry.name,
      templateId: planEntry.templateId,
      ...(planEntry.generatedName ? { generatedName: planEntry.generatedName } : {}),
      variables: { ...planEntry.variables },
      missingVariables: planEntry.missingVariables,
      status: DevSessionPlanStatus.Applied,
      file: planEntry.file,
      signed: planEntry.signed,
      ...(planEntry.reviewReportFile ? { reviewReportFile: planEntry.reviewReportFile } : {}),
      ...(planEntry.reviewReportMarkdownFile
        ? { reviewReportMarkdownFile: planEntry.reviewReportMarkdownFile }
        : {}),
    });
  }
  const scanAfter = scanDevSession(cwd, id)!;
  state = setDevSessionPhase(state, recomputePhase(state, scanAfter));
  const next = computeDevNextAction({ ...scanAfter, state });
  state = setDevNextAction(state, next.command);
  writeDevSessionState(cwd, state);

  if (flagBool(args, 'json')) {
    process.stdout.write(
      asJson({ id, planFile, phase: state.phase, nextAction: state.nextAction }) + '\n',
    );
    return 0;
  }
  process.stdout.write(`Marked plan applied: ${planFile}\n`);
  process.stdout.write(`Phase: ${state.phase}\n`);
  if (state.nextAction) process.stdout.write(`Next: ${state.nextAction}\n`);
  return 0;
}

function markValidated(args: ParsedArgs): number {
  const id = args.positional[0];
  if (!id) {
    process.stderr.write(
      'Usage: shrk dev mark-validated <sessionId> [--report <path>] [--status passed|failed] [--note "..."]\n',
    );
    return 2;
  }
  const cwd = resolveCwd(args);
  const load = scanDevSession(cwd, id);
  if (!load) {
    process.stderr.write(`No session "${id}".\n`);
    return 1;
  }
  if (!load.state) {
    process.stderr.write(
      `Session ${id} has no session.json (legacy). mark-validated requires a v1 session.\n`,
    );
    return 1;
  }
  const statusFlag = flagString(args, 'status') ?? 'passed';
  const passed = statusFlag === 'passed';
  if (statusFlag !== 'passed' && statusFlag !== 'failed') {
    process.stderr.write(`Unknown --status "${statusFlag}". Use "passed" or "failed".\n`);
    return 2;
  }
  const note = flagString(args, 'note');
  const reportArg = flagString(args, 'report');
  let reportFile = `mark-validated-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  if (reportArg) {
    const reportAbs = nodePath.isAbsolute(reportArg)
      ? reportArg
      : nodePath.resolve(cwd, reportArg);
    if (!existsSync(reportAbs)) {
      process.stderr.write(`--report path not found: ${reportAbs}\n`);
      return 1;
    }
    // Use the basename relative to the reports/ dir if it's already inside; otherwise
    // record the absolute hint as a `note`.
    const reportsDir = nodePath.join(load.dir, 'reports');
    if (reportAbs.startsWith(reportsDir + nodePath.sep) || reportAbs === reportsDir) {
      reportFile = nodePath.basename(reportAbs);
    } else {
      reportFile = nodePath.basename(reportAbs);
    }
  }
  const now = new Date().toISOString();
  let state = recordValidation(load.state, {
    startedAt: now,
    finishedAt: now,
    reportFile,
    passed,
    warnings: 0,
    commandsRun: note ? [{ command: 'manual', passed, note }] : [],
    boundaryViolations: 0,
  });
  if (reportArg) state = recordReportFile(state, `reports/${reportFile}`);
  const scanAfter = scanDevSession(cwd, id)!;
  const newPhase = passed ? DevSessionPhase.Validated : DevSessionPhase.ValidationFailed;
  state = setDevSessionPhase(state, newPhase);
  const next = computeDevNextAction({ ...scanAfter, state });
  state = setDevNextAction(state, next.command);
  writeDevSessionState(cwd, state);

  if (flagBool(args, 'json')) {
    process.stdout.write(
      asJson({ id, status: statusFlag, reportFile, phase: state.phase, nextAction: state.nextAction }) +
        '\n',
    );
    return 0;
  }
  process.stdout.write(`Marked session ${statusFlag}: ${id}\n`);
  process.stdout.write(`Phase: ${state.phase}\n`);
  if (state.nextAction) process.stdout.write(`Next: ${state.nextAction}\n`);
  return 0;
}

function resolveSessionPlanFile(load: IDevSessionLoad, planArg: string): string | null {
  const plansDir = nodePath.join(load.dir, 'plans');
  // First, treat the arg as a basename within plans/.
  const candidates = [planArg, nodePath.basename(planArg)];
  for (const c of candidates) {
    if (existsSync(nodePath.join(plansDir, c))) return c;
  }
  // Else: if the arg is an absolute path inside this session's plans dir, accept.
  const abs = nodePath.isAbsolute(planArg)
    ? planArg
    : nodePath.resolve(process.cwd(), planArg);
  if (abs.startsWith(plansDir + nodePath.sep) && existsSync(abs)) {
    return nodePath.relative(plansDir, abs);
  }
  return null;
}

// ─── Part 4: dev diff ──────────────────────────────────────────────────────

function diffCmd(args: ParsedArgs): number {
  const aId = args.positional[0];
  const bId = args.positional[1];
  if (!aId || !bId) {
    process.stderr.write('Usage: shrk dev diff <sessionA> <sessionB> [--json]\n');
    return 2;
  }
  const cwd = resolveCwd(args);
  const a = scanDevSession(cwd, aId);
  const b = scanDevSession(cwd, bId);
  if (!a) {
    process.stderr.write(`No session "${aId}".\n`);
    return 1;
  }
  if (!b) {
    process.stderr.write(`No session "${bId}".\n`);
    return 1;
  }
  const diff = diffDevSessions(a, b);
  if (flagBool(args, 'json')) {
    process.stdout.write(asJson(diff) + '\n');
    return 0;
  }
  process.stdout.write(header(`Dev diff: ${aId}  ↔  ${bId}`));
  process.stdout.write(
    kv('A task', diff.a.task || '(none)') + '\n' + kv('B task', diff.b.task || '(none)') + '\n',
  );
  process.stdout.write(
    kv('phase', diff.phase.changed ? `${diff.a.phase ?? '-'} → ${diff.b.phase ?? '-'}` : 'same') +
      '\n',
  );
  process.stdout.write(
    kv(
      'pipeline',
      diff.selectedPipeline.changed
        ? `${a.state?.selectedPipeline ?? '-'} → ${b.state?.selectedPipeline ?? '-'}`
        : 'same',
    ) + '\n',
  );
  process.stdout.write(
    kv('validations', `A:${diff.validations.aCount}  B:${diff.validations.bCount}`) + '\n',
  );
  const groups: { label: string; group: { onlyA: readonly string[]; onlyB: readonly string[] } }[] =
    [
      { label: 'Templates (top from packet)', group: diff.topTemplates },
      { label: 'Rules (top from packet)', group: diff.topRules },
      { label: 'Selected templates', group: diff.selectedTemplates },
      { label: 'Plans', group: diff.plans },
      { label: 'Applied plans', group: diff.appliedPlans },
      { label: 'Reports', group: diff.reports },
      { label: 'Forbidden actions', group: diff.forbiddenActions },
      { label: 'Verification commands', group: diff.verificationCommands },
      { label: 'CLI commands', group: diff.cliCommands },
      { label: 'MCP tools', group: diff.mcpTools },
    ];
  for (const { label, group } of groups) {
    if (group.onlyA.length === 0 && group.onlyB.length === 0) continue;
    process.stdout.write(`\n${label}:\n`);
    for (const x of group.onlyA) process.stdout.write(`  - only in A: ${x}\n`);
    for (const x of group.onlyB) process.stdout.write(`  + only in B: ${x}\n`);
  }
  return 0;
}

// ─── Part 5: dev archive / clean ───────────────────────────────────────────

function archiveCmd(args: ParsedArgs): number {
  const id = args.positional[0];
  if (!id) {
    process.stderr.write('Usage: shrk dev archive <sessionId>\n');
    return 2;
  }
  const cwd = resolveCwd(args);
  const result = archiveDevSession(cwd, id);
  if (flagBool(args, 'json')) {
    process.stdout.write(asJson(result) + '\n');
    return result.archived ? 0 : 1;
  }
  if (result.archived) {
    process.stdout.write(`Archived ${id} → ${result.to}\n`);
    return 0;
  }
  process.stderr.write(`Could not archive ${id}: ${result.reason ?? 'unknown'}\n`);
  return 1;
}

function cleanCmd(args: ParsedArgs): number {
  const cwd = resolveCwd(args);
  const olderThan = flagString(args, 'older-than');
  if (!olderThan) {
    process.stderr.write(
      'Usage: shrk dev clean --older-than <duration> [--archive] [--write] [--include-active]\n' +
        '  duration accepts: 30m | 24h | 7d | 2w\n',
    );
    return 2;
  }
  const olderThanMs = parseDurationToMs(olderThan);
  if (olderThanMs === null) {
    process.stderr.write(`Invalid --older-than value: "${olderThan}"\n`);
    return 2;
  }
  const includeActive = flagBool(args, 'include-active');
  const archive = flagBool(args, 'archive');
  const write = flagBool(args, 'write');
  const candidates = listDevCleanCandidates({
    cwd,
    olderThanMs,
    includeActive,
  });
  const eligible = candidates.filter((c) => c.reason === 'eligible' || c.reason === 'legacy session');
  const wantJson = flagBool(args, 'json');

  if (!write) {
    if (wantJson) {
      process.stdout.write(
        asJson({ dryRun: true, archive, candidates, eligible: eligible.map((c) => c.id) }) + '\n',
      );
      return 0;
    }
    process.stdout.write(header('shrk dev clean (dry run)'));
    process.stdout.write(`  olderThan=${olderThan}  archive=${archive}  includeActive=${includeActive}\n\n`);
    for (const c of candidates) {
      process.stdout.write(
        `  ${c.reason === 'eligible' ? 'WILL ' : 'SKIP '} ${c.id}  age=${Math.round(c.ageMs / 86_400_000)}d  phase=${c.phase ?? '-'}${c.active ? '  (active)' : ''}\n`,
      );
    }
    process.stdout.write(`\n${eligible.length} session(s) match. Pass --write to ${archive ? 'archive' : 'delete'} them.\n`);
    return 0;
  }
  // --write: actually perform the action.
  const results: { id: string; action: 'archived' | 'deleted' | 'skipped'; reason?: string }[] = [];
  for (const c of candidates) {
    if (c.reason !== 'eligible' && c.reason !== 'legacy session') {
      results.push({ id: c.id, action: 'skipped', reason: c.reason });
      continue;
    }
    if (archive) {
      const r = archiveDevSession(cwd, c.id);
      results.push(
        r.archived
          ? { id: c.id, action: 'archived' }
          : { id: c.id, action: 'skipped', reason: r.reason ?? 'archive failed' },
      );
      continue;
    }
    // Delete.
    try {
      rmSync(getDevSessionDir(cwd, c.id), { recursive: true, force: true });
      results.push({ id: c.id, action: 'deleted' });
    } catch (e) {
      results.push({ id: c.id, action: 'skipped', reason: (e as Error).message });
    }
  }
  if (wantJson) {
    process.stdout.write(asJson({ results }) + '\n');
    return 0;
  }
  for (const r of results) {
    process.stdout.write(
      `  ${r.action.padEnd(9)} ${r.id}${r.reason ? '  (' + r.reason + ')' : ''}\n`,
    );
  }
  return 0;
}

// ─── Part 6: dev open / plans / reports / commands ─────────────────────────

async function openCmd(args: ParsedArgs): Promise<number> {
  const id = args.positional[0];
  if (!id) {
    process.stderr.write('Usage: shrk dev open <sessionId> [--html] [--serve [--host <addr>] [--port <n>]]\n');
    return 2;
  }
  const cwd = resolveCwd(args);
  const load = scanDevSession(cwd, id);
  if (!load) {
    process.stderr.write(`No session "${id}".\n`);
    return 1;
  }

  // --serve: spin up a tiny local-only HTTP server. Default binds 127.0.0.1.
  if (flagBool(args, 'serve')) {
    return serveSessionHtml(args, load);
  }
  if (flagBool(args, 'html')) {
    const html = renderDevSessionHtml(load, {
      nextActionLine: load.state?.nextAction ?? undefined,
    });
    const out = nodePath.join(load.dir, 'final-report.html');
    writeFileSync(out, html, 'utf8');
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ id, htmlPath: out }) + '\n');
      return 0;
    }
    process.stdout.write(`Wrote ${out}\n`);
    return 0;
  }
  if (flagBool(args, 'json')) {
    process.stdout.write(
      asJson({
        id,
        dir: load.dir,
        files: {
          task: 'task.md',
          packet: 'task-packet.json',
          state: 'session.json',
          plansDir: 'plans/',
          reportsDir: 'reports/',
        },
      }) + '\n',
    );
    return 0;
  }
  process.stdout.write(header(`Dev session: ${id}`));
  process.stdout.write(`  dir:           ${load.dir}\n`);
  process.stdout.write(`  task:          ${nodePath.join(load.dir, 'task.md')}\n`);
  process.stdout.write(`  packet:        ${nodePath.join(load.dir, 'task-packet.json')}\n`);
  process.stdout.write(`  state:         ${nodePath.join(load.dir, 'session.json')}\n`);
  process.stdout.write(`  plans/:        ${nodePath.join(load.dir, 'plans')}\n`);
  process.stdout.write(`  reports/:      ${nodePath.join(load.dir, 'reports')}\n`);
  if (load.state?.nextAction) {
    process.stdout.write(`\n  next:          ${load.state.nextAction}\n`);
  }
  return 0;
}

async function serveSessionHtml(args: ParsedArgs, load: IDevSessionLoad): Promise<number> {
  const { startLiveSessionServer } = await import('../dashboard/live-session-server.ts');
  const host = flagString(args, 'host') ?? '127.0.0.1';
  const port = Number(flagString(args, 'port') ?? '0');
  const live = flagBool(args, 'live');
  const handle = await startLiveSessionServer({
    cwd: resolveCwd(args),
    load,
    host,
    port,
    live,
  });
  process.stdout.write(
    `Serving session ${load.id} at ${handle.url}/${live ? ' (live)' : ''}\n` +
      `(local-only by default; press Ctrl+C to stop)\n`,
  );
  if (flagBool(args, 'open') && process.platform === 'darwin') {
    try {
      spawnSync('open', [`${handle.url}/`]);
    } catch {
      /* ignore */
    }
  }
  return new Promise<number>((resolve) => {
    const shutdown = (): void => {
      handle.close().finally(() => resolve(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

function plansCmd(args: ParsedArgs): number {
  const id = args.positional[0];
  if (!id) {
    process.stderr.write('Usage: shrk dev plans <sessionId>\n');
    return 2;
  }
  const cwd = resolveCwd(args);
  const load = scanDevSession(cwd, id);
  if (!load) {
    process.stderr.write(`No session "${id}".\n`);
    return 1;
  }
  const plansDir = nodePath.join(load.dir, 'plans');
  const items = load.state?.plans ?? [];
  if (flagBool(args, 'json')) {
    process.stdout.write(
      asJson({
        id,
        plansDir,
        plans: items.map((p) => ({
          name: p.name,
          status: p.status,
          file: p.file,
          path: nodePath.join(plansDir, p.file),
          signed: p.signed,
          templateId: p.templateId,
          missingVariables: p.missingVariables,
        })),
        plansOnDisk: load.plansOnDisk,
        intentFiles: load.intentFiles,
      }) + '\n',
    );
    return 0;
  }
  process.stdout.write(header(`Dev plans: ${id}`));
  process.stdout.write(`  plansDir: ${plansDir}\n\n`);
  if (items.length === 0 && load.plansOnDisk.length === 0 && load.intentFiles.length === 0) {
    process.stdout.write('  (no plans)\n');
    return 0;
  }
  for (const p of items) {
    process.stdout.write(`  • ${p.name.padEnd(28)} ${p.status.padEnd(10)} ${p.file}\n`);
    if (p.missingVariables.length > 0) {
      process.stdout.write(`      missing: ${p.missingVariables.join(', ')}\n`);
    }
  }
  for (const f of load.plansOnDisk.filter((f) => !items.some((p) => p.file === f))) {
    process.stdout.write(`  • ${f}  (not tracked in session.json)\n`);
  }
  for (const f of load.intentFiles.filter((f) => !items.some((p) => p.file === f))) {
    process.stdout.write(`  • ${f}  (intent, not tracked)\n`);
  }
  return 0;
}

function reportsCmd(args: ParsedArgs): number {
  const id = args.positional[0];
  if (!id) {
    process.stderr.write('Usage: shrk dev reports <sessionId>\n');
    return 2;
  }
  const cwd = resolveCwd(args);
  const load = scanDevSession(cwd, id);
  if (!load) {
    process.stderr.write(`No session "${id}".\n`);
    return 1;
  }
  const reportsDir = nodePath.join(load.dir, 'reports');
  if (flagBool(args, 'json')) {
    process.stdout.write(
      asJson({
        id,
        reportsDir,
        reportsOnDisk: load.reportsOnDisk,
        trackedReports: load.state?.reports ?? [],
        validations: load.state?.validations ?? [],
      }) + '\n',
    );
    return 0;
  }
  process.stdout.write(header(`Dev reports: ${id}`));
  process.stdout.write(`  reportsDir: ${reportsDir}\n\n`);
  if (load.reportsOnDisk.length === 0) {
    process.stdout.write('  (no reports)\n');
    return 0;
  }
  for (const r of load.reportsOnDisk) process.stdout.write(`  • ${r}\n`);
  return 0;
}

function commandsCmd(args: ParsedArgs): number {
  const id = args.positional[0];
  if (!id) {
    process.stderr.write('Usage: shrk dev commands <sessionId>\n');
    return 2;
  }
  const cwd = resolveCwd(args);
  const load = scanDevSession(cwd, id);
  if (!load) {
    process.stderr.write(`No session "${id}".\n`);
    return 1;
  }
  const plansRel = `.sharkcraft/sessions/${id}/plans`;
  const reportsRel = `.sharkcraft/sessions/${id}/reports`;
  const commands = {
    plan: `shrk dev plan ${id} --template <id> --name <name> [--var k=v ...]`,
    review: `shrk dev plan ${id}  # (re-running plan auto-reviews)`,
    apply: `shrk apply ${plansRel}/<plan>.json --verify-signature`,
    applyWithSession: `shrk apply ${plansRel}/<plan>.json --session ${id} --verify-signature`,
    validate: `shrk dev validate ${id}`,
    validateWithReport: `shrk apply ${plansRel}/<plan>.json --validate --report`,
    report: `shrk dev report ${id}`,
    diff: `shrk dev diff <otherSessionId> ${id}`,
    open: `shrk dev open ${id}`,
    plans: `shrk dev plans ${id}`,
    reports: `shrk dev reports ${id}`,
  };
  if (flagBool(args, 'json')) {
    process.stdout.write(asJson({ id, commands, plansDir: plansRel, reportsDir: reportsRel }) + '\n');
    return 0;
  }
  process.stdout.write(header(`Dev commands: ${id}`));
  for (const [k, v] of Object.entries(commands)) {
    process.stdout.write(`  # ${k}\n`);
    process.stdout.write(`  $ ${v}\n\n`);
  }
  return 0;
}

export const devCommand: ICommandHandler = {
  name: 'dev',
  description:
    'Safe AI-assisted development workflow: task → session → plan → review → apply (CLI) → validate → report. ' +
    'Never auto-applies plans; never runs untrusted pack commands; never writes outside .sharkcraft/sessions/.',
  usage:
    'shrk dev <start|plan|status|next|continue|validate|report|list|mark-applied|mark-validated|diff|archive|clean|open|plans|reports|commands> [args...] [--cwd <dir>] [--json]\n' +
    '  alias: shrk dev "<task>"  →  shrk dev start "<task>"',
  async run(args: ParsedArgs): Promise<number> {
    const first = args.positional[0];

    // If no first arg, print usage.
    if (!first) {
      process.stderr.write(
        'Usage: shrk dev <start|plan|status|next|continue|validate|report|list|mark-applied|mark-validated|diff|archive|clean|open|plans|reports|commands> [args...]\n' +
          '       shrk dev "<task>"  (alias for: shrk dev start "<task>")\n',
      );
      return 2;
    }

    // Recognize known subcommands.
    if (SUBCOMMANDS.has(first)) {
      const sliced = { ...args, positional: args.positional.slice(1) };
      switch (first) {
        case 'start':
          return startSession(sliced);
        case 'plan':
          return planSession(sliced);
        case 'status':
          return statusSession(sliced);
        case 'next':
        case 'continue':
          return nextOrContinue(sliced);
        case 'validate':
          return validateSession(sliced);
        case 'report':
          return reportSession(sliced);
        case 'list':
          return listSessionsCmd(sliced);
        case 'mark-applied':
          return markApplied(sliced);
        case 'mark-validated':
          return markValidated(sliced);
        case 'diff':
          return diffCmd(sliced);
        case 'archive':
          return archiveCmd(sliced);
        case 'clean':
          return cleanCmd(sliced);
        case 'open':
          return openCmd(sliced);
        case 'plans':
          return plansCmd(sliced);
        case 'reports':
          return reportsCmd(sliced);
        case 'commands':
          return commandsCmd(sliced);
        // `dev cycle` removed (subsumed by `dev start`/`dev plan`).
        default:
          break;
      }
    }

    // Alias form: shrk dev "<task>" → shrk dev start "<task>".
    return startSession(args);
  },
};
