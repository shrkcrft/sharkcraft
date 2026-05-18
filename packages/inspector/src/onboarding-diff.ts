import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import type { IOnboardingPlan } from './onboarding.ts';

export type DiffStatus = 'already-covered' | 'missing' | 'conflicting' | 'low-confidence-only';

export interface IDiffEntry {
  id: string;
  status: DiffStatus;
  /** Short description of what this entry would add. */
  summary: string;
  /** Optional manual merge hint (e.g. file to edit). */
  mergeHint?: string;
}

export interface IDiffCategory {
  /** Category name shown in the report. */
  name: string;
  entries: readonly IDiffEntry[];
  counts: {
    alreadyCovered: number;
    missing: number;
    conflicting: number;
    lowConfidenceOnly: number;
  };
}

export interface IOnboardingDiff {
  rules: IDiffCategory;
  paths: IDiffCategory;
  templates: IDiffCategory;
  pipelines: IDiffCategory;
  boundaries: IDiffCategory;
  verificationCommands: IDiffCategory;
  /** Suggested manual steps the user can run to adopt the missing entries. */
  manualMergeSteps: readonly string[];
}

/**
 * Compare the inferred plan against the live SharkCraft configuration.
 * Does NOT mutate anything. The output is intended for the `--diff` CLI flag.
 */
export function buildOnboardingDiff(
  inspection: ISharkcraftInspection,
  plan: IOnboardingPlan,
): IOnboardingDiff {
  // ── Rules ─────────────────────────────────────────────────────────────
  const liveRuleIds = new Set(inspection.ruleService.list().map((r) => r.id));
  const rulesEntries: IDiffEntry[] = [];
  for (const r of plan.inferredRules) {
    if (liveRuleIds.has(r.id)) {
      rulesEntries.push({
        id: r.id,
        status: 'already-covered',
        summary: `Rule ${r.id} already present in sharkcraft/rules.ts.`,
      });
    } else {
      rulesEntries.push({
        id: r.id,
        status: 'missing',
        summary: `${r.priority} priority — ${r.title}`,
        mergeHint: 'Copy keepers from sharkcraft/onboarding/inferred-rules.draft.ts into sharkcraft/rules.ts.',
      });
    }
  }

  // ── Paths ─────────────────────────────────────────────────────────────
  const livePathIds = new Set(inspection.pathService.list().map((p) => p.id));
  const pathsEntries: IDiffEntry[] = [];
  for (const p of plan.inferredPathConventions) {
    if (livePathIds.has(p.id)) {
      pathsEntries.push({
        id: p.id,
        status: 'already-covered',
        summary: `Path convention ${p.id} already present.`,
      });
    } else {
      pathsEntries.push({
        id: p.id,
        status: 'missing',
        summary: p.title,
        mergeHint: 'Add to sharkcraft/paths.ts from the draft.',
      });
    }
  }

  // ── Templates ─────────────────────────────────────────────────────────
  const liveTemplateIds = new Set(
    inspection.templateRegistry.list().map((t) => t.id),
  );
  const templatesEntries: IDiffEntry[] = [];
  for (const t of plan.inferredTemplateCandidates) {
    // High-confidence templates with scaffolds are "missing" candidates.
    // Low-confidence templates without scaffolds are flagged as such.
    const live = liveTemplateIds.has(t.id) || liveTemplateIds.has(t.scaffold?.id ?? '');
    if (live) {
      templatesEntries.push({
        id: t.id,
        status: 'already-covered',
        summary: `Template ${t.id} already registered.`,
      });
    } else if (t.confidence === 'low' && !t.scaffold) {
      templatesEntries.push({
        id: t.id,
        status: 'low-confidence-only',
        summary: `${t.name} — only ${t.reason}; not promoted.`,
        mergeHint: 'Add another sample file or scaffold manually before promoting.',
      });
    } else {
      templatesEntries.push({
        id: t.id,
        status: 'missing',
        summary: t.scaffold
          ? `${t.name} scaffold available in inferred-templates.draft.ts (${t.confidence} confidence).`
          : `${t.name} candidate — fill in body before adopting.`,
        mergeHint: t.scaffold
          ? 'Move scaffold.content into sharkcraft/templates.ts via defineTemplate().'
          : 'Re-run `shrk onboard --write-drafts --scaffold-templates` to draft the body.',
      });
    }
  }

  // ── Pipelines ─────────────────────────────────────────────────────────
  const livePipelineIds = new Set(
    inspection.pipelineRegistry.list().map((p) => p.id),
  );
  const pipelinesEntries: IDiffEntry[] = [];
  for (const p of plan.inferredPipelines) {
    if (livePipelineIds.has(p.id)) {
      pipelinesEntries.push({
        id: p.id,
        status: 'already-covered',
        summary: `Pipeline ${p.id} already present.`,
      });
    } else {
      pipelinesEntries.push({
        id: p.id,
        status: 'missing',
        summary: p.title,
        mergeHint: 'Add to sharkcraft/pipelines.ts via definePipeline().',
      });
    }
  }

  // ── Boundary rules ────────────────────────────────────────────────────
  const liveBoundaryIds = new Set(
    inspection.boundaryRegistry.list().map((b) => b.id),
  );
  const boundariesEntries: IDiffEntry[] = [];
  for (const b of plan.inferredBoundaryRules) {
    if (liveBoundaryIds.has(b.id)) {
      boundariesEntries.push({
        id: b.id,
        status: 'already-covered',
        summary: `Boundary rule ${b.id} already registered.`,
      });
    } else {
      boundariesEntries.push({
        id: b.id,
        status: 'missing',
        summary: b.title,
        mergeHint: 'Add the rule to sharkcraft/boundaries.ts (or your pack) and register via boundaryFiles.',
      });
    }
  }

  // ── Verification commands ─────────────────────────────────────────────
  const liveVerificationIds = collectLiveVerificationIds(inspection);
  const verificationEntries: IDiffEntry[] = [];
  for (const v of plan.inferredVerificationCommands) {
    if (liveVerificationIds.has(v.id)) {
      verificationEntries.push({
        id: v.id,
        status: 'already-covered',
        summary: `Verification "${v.id}" already configured.`,
      });
    } else {
      verificationEntries.push({
        id: v.id,
        status: 'missing',
        summary: `${v.label} (${v.command})`,
        mergeHint: 'Add to sharkcraft.config.ts verificationCommands[] to make it trusted for `apply --validate`.',
      });
    }
  }

  const manualMergeSteps = buildManualMergeSteps([
    { name: 'rules', entries: rulesEntries },
    { name: 'paths', entries: pathsEntries },
    { name: 'templates', entries: templatesEntries },
    { name: 'pipelines', entries: pipelinesEntries },
    { name: 'boundaries', entries: boundariesEntries },
    { name: 'verification commands', entries: verificationEntries },
  ]);

  return {
    rules: toCategory('Rules', rulesEntries),
    paths: toCategory('Path conventions', pathsEntries),
    templates: toCategory('Templates', templatesEntries),
    pipelines: toCategory('Pipelines', pipelinesEntries),
    boundaries: toCategory('Boundary rules', boundariesEntries),
    verificationCommands: toCategory(
      'Verification commands',
      verificationEntries,
    ),
    manualMergeSteps,
  };
}

function toCategory(name: string, entries: readonly IDiffEntry[]): IDiffCategory {
  const counts = {
    alreadyCovered: 0,
    missing: 0,
    conflicting: 0,
    lowConfidenceOnly: 0,
  };
  for (const e of entries) {
    if (e.status === 'already-covered') counts.alreadyCovered += 1;
    else if (e.status === 'missing') counts.missing += 1;
    else if (e.status === 'conflicting') counts.conflicting += 1;
    else if (e.status === 'low-confidence-only') counts.lowConfidenceOnly += 1;
  }
  return { name, entries, counts };
}

function collectLiveVerificationIds(
  inspection: ISharkcraftInspection,
): Set<string> {
  const out = new Set<string>();
  const cfg = inspection.config as
    | { verificationCommands?: ReadonlyArray<{ id?: string }> }
    | null;
  for (const vc of cfg?.verificationCommands ?? []) {
    if (typeof vc?.id === 'string') out.add(vc.id);
  }
  return out;
}

function buildManualMergeSteps(
  categories: { name: string; entries: readonly IDiffEntry[] }[],
): string[] {
  const out: string[] = [];
  for (const c of categories) {
    const missing = c.entries.filter((e) => e.status === 'missing').length;
    if (missing > 0) {
      out.push(
        `Review ${missing} missing ${c.name} entr${missing === 1 ? 'y' : 'ies'} in the draft and copy keepers into the live config.`,
      );
    }
  }
  if (out.length === 0) {
    out.push('No missing entries — the live config already covers the inferred plan.');
  }
  return out;
}

export function renderOnboardingDiff(diff: IOnboardingDiff): string {
  const out: string[] = [];
  out.push('# SharkCraft onboarding diff');
  out.push('');
  out.push(
    'Compares the inferred plan against the live SharkCraft config. Nothing is changed.',
  );
  out.push('');
  for (const cat of [
    diff.rules,
    diff.paths,
    diff.templates,
    diff.pipelines,
    diff.boundaries,
    diff.verificationCommands,
  ]) {
    out.push(`## ${cat.name}`);
    out.push('');
    out.push(
      `- already covered: ${cat.counts.alreadyCovered}` +
        `, missing: ${cat.counts.missing}` +
        `, low-confidence only: ${cat.counts.lowConfidenceOnly}` +
        `, conflicting: ${cat.counts.conflicting}`,
    );
    out.push('');
    if (cat.entries.length === 0) {
      out.push('_No entries._');
      out.push('');
      continue;
    }
    for (const e of cat.entries) {
      out.push(`- **${e.id}** — ${e.status}`);
      out.push(`  - ${e.summary}`);
      if (e.mergeHint) out.push(`  - hint: ${e.mergeHint}`);
    }
    out.push('');
  }
  out.push('## Suggested manual merge steps');
  out.push('');
  for (const s of diff.manualMergeSteps) out.push(`- ${s}`);
  out.push('');
  return out.join('\n');
}
