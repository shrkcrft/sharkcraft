import {
  DevSessionPhase,
  DevSessionPlanStatus,
  type IDevSessionLoad,
  type IDevSessionState,
} from './dev-session.ts';

export interface IRenderDevSessionReportOptions {
  /** Computed-next-action hint to append. Optional. */
  nextActionLine?: string;
}

/**
 * Render a human-readable audit-trail report for a dev session. Pure: takes
 * the loaded session view + optional next-action hint, returns Markdown.
 */
export function renderDevSessionFinalReport(
  load: IDevSessionLoad,
  options: IRenderDevSessionReportOptions = {},
): string {
  const state = load.state;
  const task = load.task || state?.task || '(unknown task)';
  const lines: string[] = [];
  lines.push(`# Dev session: ${load.id}`);
  lines.push('');
  lines.push(`**Task:** ${task}`);
  if (state) {
    lines.push('');
    lines.push(`- Phase: \`${state.phase}\``);
    lines.push(`- Created: ${state.createdAt}`);
    lines.push(`- Updated: ${state.updatedAt}`);
    lines.push(`- Project root: \`${state.projectRoot}\``);
    if (state.briefFile) {
      lines.push(`- Agent brief: \`${state.briefFile}\``);
    }
  } else {
    lines.push('');
    lines.push('_Legacy session (no `session.json`); details are limited to on-disk artifacts._');
  }
  lines.push('');

  // Timeline.
  lines.push('## Timeline');
  lines.push('');
  if (state) {
    lines.push(`- ${state.createdAt} — session started`);
    for (const p of state.plans) {
      const verb = p.status === DevSessionPlanStatus.Intent ? 'intent created' : 'plan saved';
      lines.push(`- ${p.createdAt} — ${verb}: \`${p.file}\` (template \`${p.templateId}\`)`);
    }
    for (const a of state.appliedPlans) {
      lines.push(`- ${a.appliedAt} — applied plan \`${a.file}\``);
    }
    for (const v of state.validations) {
      lines.push(
        `- ${v.finishedAt} — validation ${v.passed ? 'passed' : 'FAILED'} (${v.commandsRun.length} command(s))`,
      );
    }
    if (state.phase === DevSessionPhase.Completed) {
      lines.push(`- ${state.updatedAt} — session marked complete`);
    }
  } else {
    lines.push('- _No session.json — timeline reconstructed from filesystem only._');
    for (const p of load.plansOnDisk) lines.push(`- plan on disk: \`${p}\``);
    for (const r of load.reportsOnDisk) lines.push(`- report on disk: \`${r}\``);
  }
  lines.push('');

  // Task packet summary.
  lines.push('## Task packet summary');
  lines.push('');
  if (load.packet) {
    const packet = load.packet;
    lines.push(`- Recommended pipelines: ${formatList(packet.recommendedPipelines.map((p) => p.pipelineId))}`);
    lines.push(`- Top templates: ${formatList(packet.relevantTemplates.slice(0, 5).map((t) => t.id))}`);
    lines.push(`- Top rules: ${formatList(packet.relevantRules.slice(0, 5).map((r) => r.id))}`);
    if (packet.suggestedGen) {
      lines.push(`- Suggested template: \`${packet.suggestedGen.templateId}\``);
    }
    if (packet.forbiddenActions.length) {
      lines.push(`- Forbidden actions: ${formatList(packet.forbiddenActions)}`);
    }
    if (packet.verificationCommands.length) {
      lines.push('- Verification commands:');
      for (const c of packet.verificationCommands) lines.push(`  - \`${c}\``);
    }
  } else {
    lines.push('_No task-packet.json captured for this session._');
  }
  lines.push('');

  // Selected pipeline + templates.
  if (state) {
    lines.push('## Selected pipeline & templates');
    lines.push('');
    lines.push(`- Pipeline: ${state.selectedPipeline ? '`' + state.selectedPipeline + '`' : '_(none selected)_'}`);
    lines.push(`- Templates: ${formatList(state.selectedTemplates)}`);
    lines.push('');
  }

  // Plans.
  lines.push('## Generated plans');
  lines.push('');
  if (state && state.plans.length > 0) {
    for (const p of state.plans) {
      const sig = p.signed ? ' [signed]' : '';
      lines.push(`- **${p.name}** — \`${p.templateId}\` → \`plans/${p.file}\`${sig} (status: ${p.status})`);
      if (p.missingVariables.length > 0) {
        lines.push(`  - missing variables: ${p.missingVariables.join(', ')}`);
      }
      if (p.reviewReportFile) {
        lines.push(`  - review: \`reports/${p.reviewReportFile}\``);
      }
    }
  } else if (load.plansOnDisk.length > 0 || load.intentFiles.length > 0) {
    for (const f of load.plansOnDisk) lines.push(`- \`plans/${f}\``);
    for (const f of load.intentFiles) lines.push(`- \`plans/${f}\` (intent)`);
  } else {
    lines.push('_No plans saved._');
  }
  lines.push('');

  // Plan reviews.
  lines.push('## Plan reviews');
  lines.push('');
  const reviewFiles = load.reportsOnDisk.filter((r) => r.startsWith('plan-review-'));
  if (reviewFiles.length > 0) {
    for (const r of reviewFiles) lines.push(`- \`reports/${r}\``);
  } else {
    lines.push('_No plan reviews captured._');
  }
  lines.push('');

  // Applied plans.
  lines.push('## Applied plans');
  lines.push('');
  if (state && state.appliedPlans.length > 0) {
    for (const a of state.appliedPlans) {
      lines.push(`- \`plans/${a.file}\` — applied ${a.appliedAt}${a.note ? ' (' + a.note + ')' : ''}`);
    }
  } else {
    lines.push('_No applied plans recorded (apply is the explicit human step)._');
  }
  lines.push('');

  // Validation results.
  lines.push('## Validation results');
  lines.push('');
  if (state && state.validations.length > 0) {
    for (const v of state.validations) {
      lines.push(`### ${v.finishedAt} — ${v.passed ? 'PASSED' : 'FAILED'}`);
      lines.push('');
      lines.push(`- Report: \`reports/${v.reportFile}\``);
      lines.push(`- Boundary violations: ${v.boundaryViolations}`);
      lines.push(`- Warnings: ${v.warnings}`);
      for (const c of v.commandsRun) {
        lines.push(`- ${c.passed ? '✓' : '✗'} \`${c.command}\`${c.note ? ' — ' + c.note : ''}`);
      }
      lines.push('');
    }
  } else {
    lines.push('_No validations run._');
    lines.push('');
  }

  // Remaining risks.
  lines.push('## Remaining risks');
  lines.push('');
  const risks: string[] = [];
  if (state) {
    const lastValidation = state.validations[state.validations.length - 1];
    if (lastValidation && !lastValidation.passed) {
      risks.push('Last validation failed — review report before shipping.');
    }
    if (state.plans.some((p) => p.missingVariables.length > 0)) {
      risks.push('One or more plans have unresolved variables (intent only).');
    }
    if (state.warnings.length > 0) {
      for (const w of state.warnings) risks.push(w);
    }
    if (
      state.plans.length > 0 &&
      state.appliedPlans.length === 0 &&
      state.phase !== DevSessionPhase.Completed
    ) {
      risks.push('Plans saved but not applied — apply is the explicit human step.');
    }
  }
  if (risks.length === 0) risks.push('_No risks flagged by deterministic checks._');
  for (const r of risks) lines.push(`- ${r}`);
  lines.push('');

  // Next suggested actions.
  lines.push('## Next suggested actions');
  lines.push('');
  if (options.nextActionLine) {
    lines.push(`- ${options.nextActionLine}`);
  } else if (state?.nextAction) {
    lines.push(`- ${state.nextAction}`);
  } else {
    lines.push('_None._');
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(
    '_This is a deterministic audit trail produced by `shrk dev report`. ' +
      'No AI is involved in producing it; every line maps to a file in this session directory._',
  );
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

function formatList(items: readonly string[]): string {
  if (items.length === 0) return '_(none)_';
  return items.map((i) => '`' + i + '`').join(', ');
}
