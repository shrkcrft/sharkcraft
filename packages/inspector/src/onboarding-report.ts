import type { IOnboardingPlan } from './onboarding.ts';

/**
 * Render an onboarding plan as a Markdown report. The output is intentionally
 * stable and human-readable: it is the artifact a user reads when deciding
 * whether to adopt SharkCraft drafts.
 */
export function renderOnboardingReport(plan: IOnboardingPlan): string {
  const out: string[] = [];
  out.push('# SharkCraft onboarding report');
  out.push('');
  // ── Project summary ────────────────────────────────────────────────────
  out.push('## Project summary');
  out.push('');
  const s = plan.projectSummary;
  out.push(`- Project root: \`${s.projectRoot}\``);
  if (s.projectName) out.push(`- Name: \`${s.projectName}\``);
  if (s.description) out.push(`- Description: ${s.description}`);
  out.push(`- Package manager: \`${s.packageManager}\``);
  out.push(`- SharkCraft folder present: ${s.hasSharkcraftFolder ? 'yes' : 'no'}`);
  if (s.profiles.length) {
    out.push(`- Profiles: ${s.profiles.map((p) => `\`${p}\``).join(', ')}`);
  } else {
    out.push('- Profiles: none detected');
  }
  out.push('');

  // ── AI-readiness ──────────────────────────────────────────────────────
  out.push('## AI-readiness — current vs. expected');
  out.push('');
  out.push(
    `- Current: **${plan.readiness.current}** (score ${plan.readiness.currentScore}/100)`,
  );
  out.push(
    `- Expected after drafts: **${plan.readiness.expected}** (score ~${plan.readiness.expectedScore}/100)`,
  );
  out.push('');
  if (plan.readiness.topImprovements.length) {
    out.push('Top improvements:');
    for (const i of plan.readiness.topImprovements) out.push(`- ${i}`);
    out.push('');
  }

  // ── Recommended presets ───────────────────────────────────────────────
  if (plan.recommendedPresets.length) {
    out.push('## Recommended presets');
    out.push('');
    for (const r of plan.recommendedPresets) {
      out.push(
        `- **${r.preset.id}** (${r.confidence}, score ${r.score}) — ${r.preset.title}`,
      );
      if (r.reasons.length) {
        for (const reason of r.reasons) out.push(`  - ${reason}`);
      }
    }
    out.push('');
  }

  // ── Suggested files ───────────────────────────────────────────────────
  out.push('## Suggested files');
  out.push('');
  out.push('Drafts are written under `sharkcraft/onboarding/` only.');
  out.push('No existing rules.ts / paths.ts / templates.ts is overwritten.');
  out.push('');
  for (const f of plan.suggestedFiles) out.push(`- \`${f}\``);
  out.push('');

  // ── Path conventions ──────────────────────────────────────────────────
  out.push('## Suggested path conventions');
  out.push('');
  if (plan.inferredPathConventions.length === 0) {
    out.push('_No path conventions inferred._');
  } else {
    for (const p of plan.inferredPathConventions) {
      out.push(`- **${p.id}** — ${p.title}`);
      out.push(`  - patterns: ${p.patterns.map((x) => `\`${x}\``).join(', ')}`);
      out.push(`  - reason: ${p.reason}`);
    }
  }
  out.push('');

  // ── Rules ─────────────────────────────────────────────────────────────
  out.push('## Suggested rules');
  out.push('');
  if (plan.inferredRules.length === 0) {
    out.push('_No rules inferred._');
  } else {
    for (const r of plan.inferredRules) {
      out.push(`- **${r.id}** (${r.priority}) — ${r.title}`);
      out.push(`  - reason: ${r.reason}`);
    }
  }
  out.push('');

  // ── Boundary rules ────────────────────────────────────────────────────
  out.push('## Suggested boundary rules');
  out.push('');
  if (plan.inferredBoundaryRules.length === 0) {
    out.push(
      '_No boundary rules inferred — layer structure not clear enough._',
    );
  } else {
    for (const b of plan.inferredBoundaryRules) {
      out.push(`- **${b.id}** (${b.severity}) — ${b.title}`);
      out.push(`  - from: ${b.from.map((x) => `\`${x}\``).join(', ')}`);
      if (b.forbiddenImports?.length) {
        out.push(
          `  - forbids: ${b.forbiddenImports.map((x) => `\`${x}\``).join(', ')}`,
        );
      }
      out.push(`  - fix: ${b.suggestedFix}`);
      out.push(`  - reason: ${b.reason}`);
    }
  }
  out.push('');

  // ── Template candidates ───────────────────────────────────────────────
  out.push('## Suggested templates');
  out.push('');
  if (plan.inferredTemplateCandidates.length === 0) {
    out.push('_No template candidates detected._');
  } else {
    for (const t of plan.inferredTemplateCandidates) {
      out.push(`- **${t.id}** (${t.confidence}) — ${t.name}`);
      out.push(`  - ${t.description}`);
      if (t.targetPathHint) out.push(`  - target: \`${t.targetPathHint}\``);
      if (t.sample) out.push(`  - sample: \`${t.sample}\``);
      out.push(`  - reason: ${t.reason}`);
    }
  }
  out.push('');

  // ── Pipelines ─────────────────────────────────────────────────────────
  out.push('## Suggested pipelines');
  out.push('');
  if (plan.inferredPipelines.length === 0) {
    out.push('_No pipelines inferred._');
  } else {
    for (const p of plan.inferredPipelines) {
      out.push(`- **${p.id}** — ${p.title}`);
      out.push(`  - steps: ${p.steps.map((s) => `\`${s}\``).join(' → ')}`);
      out.push(`  - reason: ${p.reason}`);
    }
  }
  out.push('');

  // ── Verification commands ─────────────────────────────────────────────
  out.push('## Verification commands');
  out.push('');
  if (plan.inferredVerificationCommands.length === 0) {
    out.push(
      '_No verification commands inferred — add scripts to package.json so apply can validate._',
    );
  } else {
    for (const v of plan.inferredVerificationCommands) {
      out.push(`- **${v.id}** — \`${v.command}\``);
      out.push(`  - reason: ${v.reason}`);
    }
  }
  out.push('');

  // ── Existing instruction files ────────────────────────────────────────
  if (plan.detectedInstructionFiles.length) {
    out.push('## Existing instruction files detected');
    out.push('');
    for (const f of plan.detectedInstructionFiles) {
      out.push(`- \`${f.path}\` — import with: \`${f.importCommand}\``);
    }
    out.push('');
  }

  // ── Monorepo summary ──────────────────────────────────────────────────
  if (plan.monorepoSummary) {
    const m = plan.monorepoSummary;
    out.push('## Monorepo summary');
    out.push('');
    out.push(
      `- Apps: ${m.apps.length}, Packages: ${m.packages.length}, Libs: ${m.libs.length}`,
    );
    if (m.workspaces.length > 0) {
      out.push(`- Workspaces: ${m.workspaces.map((w) => `\`${w}\``).join(', ')}`);
    }
    if (m.notes.length) {
      for (const n of m.notes) out.push(`- ${n}`);
    }
    out.push('');
    if (m.apps.length + m.packages.length + m.libs.length > 0) {
      out.push('### Detected workspaces');
      out.push('');
      for (const p of [...m.apps, ...m.packages, ...m.libs]) {
        const scriptList = Object.keys(p.scripts).slice(0, 4).join(', ');
        out.push(
          `- \`${p.path}\`${p.name ? ` (\`${p.name}\`)` : ''}${scriptList ? ` — scripts: ${scriptList}` : ''}`,
        );
      }
      out.push('');
    }
    if (m.rootVerificationCommands.length) {
      out.push('### Root verification commands');
      out.push('');
      for (const c of m.rootVerificationCommands) out.push(`- \`${c}\``);
      out.push('');
    }
    if (m.perPackageVerificationHints.length) {
      out.push('### Per-package verification hints');
      out.push('');
      for (const h of m.perPackageVerificationHints.slice(0, 24)) {
        out.push(`- \`${h.packagePath}\` — \`${h.command}\``);
      }
      if (m.perPackageVerificationHints.length > 24) {
        out.push(
          `- …and ${m.perPackageVerificationHints.length - 24} more.`,
        );
      }
      out.push('');
    }
    if (m.boundaryCandidates.length) {
      out.push('### Boundary candidates (from layout)');
      out.push('');
      for (const b of m.boundaryCandidates) {
        out.push(`- **${b.id}** — ${b.title}`);
        out.push(`  - from: ${b.from.map((x) => `\`${x}\``).join(', ')}`);
        out.push(
          `  - forbids: ${b.forbiddenImports.map((x) => `\`${x}\``).join(', ')}`,
        );
        out.push(`  - reason: ${b.reason}`);
      }
      out.push('');
    }
    if (m.presetRecommendations.length) {
      out.push('### Preset recommendations for monorepo root');
      out.push('');
      for (const p of m.presetRecommendations) out.push(`- \`${p}\``);
      out.push('');
    }
  }

  // ── Risks / warnings ──────────────────────────────────────────────────
  if (plan.risks.length) {
    out.push('## Risks / warnings');
    out.push('');
    for (const r of plan.risks) out.push(`- ${r}`);
    out.push('');
  }

  // ── Next commands ─────────────────────────────────────────────────────
  out.push('## Next commands');
  out.push('');
  for (const c of plan.nextCommands) out.push(`- \`${c}\``);
  out.push('');

  out.push('---');
  out.push('');
  out.push(
    'Drafts are advisory. SharkCraft never overwrites rules.ts / paths.ts / templates.ts — adopt by hand.',
  );
  return out.join('\n');
}
