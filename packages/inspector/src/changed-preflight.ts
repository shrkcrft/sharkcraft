/**
 * Changed-only preflight planner.
 *
 * Given a workspace + a changed-file set, decide which read-only gates a
 * preflight run should execute. The output is pure data (a list of
 * `IPreflightGate` rows tagged `run / skip / recommend`) plus an
 * `IPreflightVerdict`. Actual execution lives in the CLI command — this
 * module never spawns processes.
 *
 * Gates are selected from changed-file shape, not from configuration. The
 * planner is intentionally conservative: a gate's `skip` decision is always
 * accompanied by a reason so the operator can see what was elided.
 */
import * as nodePath from 'node:path';

export const CHANGED_PREFLIGHT_SCHEMA = 'sharkcraft.changed-preflight/v1';

export enum PreflightProfile {
  Quick = 'quick',
  Standard = 'standard',
  Strict = 'strict',
}

export enum PreflightAction {
  Run = 'run',
  Skip = 'skip',
  Recommend = 'recommend',
}

export interface IPreflightGate {
  readonly id: string;
  readonly title: string;
  readonly command: string;
  readonly action: PreflightAction;
  readonly reason: string;
  /** When `run`, whether the operator may pass `--canFail`-style continue flags. */
  readonly canFail: boolean;
}

export interface IPreflightVerdict {
  readonly action: 'ok' | 'attention';
  readonly summary: string;
}

export interface IChangedPreflightPlan {
  readonly schema: typeof CHANGED_PREFLIGHT_SCHEMA;
  readonly profile: PreflightProfile;
  readonly changedFiles: ReadonlyArray<string>;
  readonly classifications: IChangedFilesClassification;
  readonly gates: ReadonlyArray<IPreflightGate>;
  readonly verdict: IPreflightVerdict;
  readonly explanations: ReadonlyArray<string>;
}

export interface IChangedFilesClassification {
  readonly anyEngineSource: boolean;
  readonly anyPackages: boolean;
  readonly anyTests: boolean;
  readonly anySharkcraftAssets: boolean;
  readonly anyKnowledgeRefs: boolean;
  readonly anyPackContrib: boolean;
  readonly anyTemplatesOrPacks: boolean;
  readonly anyCliCatalog: boolean;
  readonly anyMcpOrTools: boolean;
  readonly anySafetyAreas: boolean;
  readonly anyConfigOrDocs: boolean;
}

function classifyChangedFiles(files: ReadonlyArray<string>): IChangedFilesClassification {
  const norm = files.map((f) => f.replace(/\\/g, '/'));
  const match = (re: RegExp): boolean => norm.some((p) => re.test(p));
  const anyEngineSource = match(/^packages\/[^/]+\/src\//);
  const anyPackages = match(/^packages\//);
  const anyTests = match(/__tests__\/|\.test\.ts$|e2e\//);
  const anySharkcraftAssets = match(/^sharkcraft\//);
  const anyKnowledgeRefs =
    match(/^sharkcraft\/knowledge\.ts$/) || match(/^sharkcraft\/knowledge\//);
  const anyPackContrib =
    match(/^packages\/[^/]+\/dist\/manifest\.json$/) ||
    match(/^packages\/[^/]+\/package\.json$/) ||
    match(/^packages\/[^/]+\/src\/assets\//);
  const anyTemplatesOrPacks =
    match(/^sharkcraft\/templates\.ts$/) ||
    anyPackContrib ||
    match(/^sharkcraft\/scaffold-patterns\.ts$/);
  const anyCliCatalog =
    match(/^packages\/cli\/src\/commands\//) ||
    match(/^packages\/cli\/src\/main\.ts$/) ||
    match(/^packages\/cli\/src\/command-/);
  const anyMcpOrTools = match(/^packages\/mcp-server\//);
  const anySafetyAreas =
    anyMcpOrTools ||
    match(/^packages\/.*safety/) ||
    match(/^packages\/generator\//) ||
    match(/^packages\/cli\/src\/commands\/apply\.command\.ts$/) ||
    match(/^packages\/cli\/src\/commands\/contract.*\.ts$/);
  const anyConfigOrDocs = match(/^docs\//) || match(/^CHANGELOG\.md$/);

  return {
    anyEngineSource,
    anyPackages,
    anyTests,
    anySharkcraftAssets,
    anyKnowledgeRefs,
    anyPackContrib,
    anyTemplatesOrPacks,
    anyCliCatalog,
    anyMcpOrTools,
    anySafetyAreas,
    anyConfigOrDocs,
  };
}

/**
 * Build a preflight plan from the changed-file set and profile.
 *
 * The planner does NOT execute anything; it returns the gate list. CLI
 * callers decide whether to spawn them.
 */
export function planChangedPreflight(options: {
  readonly projectRoot: string;
  readonly changedFiles: ReadonlyArray<string>;
  readonly profile?: PreflightProfile;
}): IChangedPreflightPlan {
  const profile = options.profile ?? PreflightProfile.Standard;
  const cls = classifyChangedFiles(options.changedFiles);
  const explanations: string[] = [];

  const gates: IPreflightGate[] = [];

  // 1) Boundary check — needed when engine src changed.
  if (cls.anyEngineSource) {
    gates.push({
      id: 'boundaries',
      title: 'Layer boundaries (changed-only)',
      command: 'shrk check boundaries --changed-only --json',
      action: PreflightAction.Run,
      reason: 'engine source files changed',
      canFail: false,
    });
  } else {
    gates.push({
      id: 'boundaries',
      title: 'Layer boundaries (changed-only)',
      command: 'shrk check boundaries --changed-only',
      action: PreflightAction.Skip,
      reason: 'no engine src changed',
      canFail: true,
    });
  }

  // 2) Import hygiene — needed when engine src changed.
  if (cls.anyEngineSource) {
    gates.push({
      id: 'imports',
      title: 'Import hygiene (changed-only)',
      command: 'shrk check imports --changed-only --json',
      action: PreflightAction.Run,
      reason: 'engine source files changed',
      canFail: false,
    });
  } else {
    gates.push({
      id: 'imports',
      title: 'Import hygiene (changed-only)',
      command: 'shrk check imports --changed-only',
      action: PreflightAction.Skip,
      reason: 'no engine src changed',
      canFail: true,
    });
  }

  // 3) Knowledge stale check.
  if (cls.anyKnowledgeRefs || cls.anyEngineSource) {
    gates.push({
      id: 'knowledge-stale',
      title: 'Knowledge stale check',
      command: 'shrk knowledge stale-check --ci',
      action: PreflightAction.Run,
      reason: 'knowledge or referenced source changed',
      canFail: true,
    });
  } else {
    gates.push({
      id: 'knowledge-stale',
      title: 'Knowledge stale check',
      command: 'shrk knowledge stale-check',
      action: PreflightAction.Skip,
      reason: 'no knowledge or source changes',
      canFail: true,
    });
  }

  // 4) Template drift.
  if (cls.anyTemplatesOrPacks) {
    gates.push({
      id: 'templates-drift',
      title: 'Template drift',
      command: 'shrk templates drift --json',
      action: PreflightAction.Run,
      reason: 'templates or pack contributions changed',
      canFail: true,
    });
  } else {
    gates.push({
      id: 'templates-drift',
      title: 'Template drift',
      command: 'shrk templates drift',
      action: PreflightAction.Skip,
      reason: 'no template or pack contribution changes',
      canFail: true,
    });
  }

  // 5) Self-config doctor.
  if (cls.anySharkcraftAssets || cls.anyPackContrib) {
    gates.push({
      id: 'self-config-doctor',
      title: 'Self-config doctor v2',
      command: 'shrk self-config doctor --strict',
      action: PreflightAction.Run,
      reason: 'sharkcraft/ assets or pack contributions changed',
      canFail: false,
    });
  } else {
    gates.push({
      id: 'self-config-doctor',
      title: 'Self-config doctor v2',
      command: 'shrk self-config doctor',
      action: PreflightAction.Skip,
      reason: 'no self-config changes',
      canFail: true,
    });
  }

  // 6) Pack signature status — when any pack files changed.
  if (cls.anyPackContrib) {
    gates.push({
      id: 'packs-signature',
      title: 'Pack signature freshness',
      command: 'shrk packs signature-status --format json',
      action: PreflightAction.Run,
      reason: 'pack contributions changed — re-check signatures',
      canFail: true,
    });
  } else {
    gates.push({
      id: 'packs-signature',
      title: 'Pack signature freshness',
      command: 'shrk packs signature-status',
      action: PreflightAction.Skip,
      reason: 'no pack contribution changes',
      canFail: true,
    });
  }

  // 7) Commands doctor — when CLI/catalog changed.
  if (cls.anyCliCatalog) {
    gates.push({
      id: 'commands-doctor',
      title: 'CLI commands doctor',
      command: 'shrk commands doctor --json',
      action: PreflightAction.Run,
      reason: 'CLI / catalog files changed',
      canFail: false,
    });
  } else {
    gates.push({
      id: 'commands-doctor',
      title: 'CLI commands doctor',
      command: 'shrk commands doctor',
      action: PreflightAction.Skip,
      reason: 'no CLI / catalog changes',
      canFail: true,
    });
  }

  // 8) Safety audit (deep) — only on strict profile or safety-area changes.
  if (cls.anySafetyAreas || profile === PreflightProfile.Strict) {
    gates.push({
      id: 'safety-audit-deep',
      title: 'Safety audit (deep)',
      command: 'shrk safety audit --deep --json',
      action: PreflightAction.Run,
      reason:
        cls.anySafetyAreas
          ? 'MCP / generator / contract / safety files changed'
          : 'strict profile selected',
      canFail: false,
    });
  } else {
    gates.push({
      id: 'safety-audit-deep',
      title: 'Safety audit (deep)',
      command: 'shrk safety audit --deep',
      action: PreflightAction.Recommend,
      reason: 'not strict mode and no safety-area changes — recommended only',
      canFail: true,
    });
  }

  // 9) Tests — only recommended unless strict profile.
  if (profile === PreflightProfile.Strict && cls.anyEngineSource) {
    gates.push({
      id: 'tests',
      title: 'Bun test suite (focused subset where possible)',
      command: 'bun test',
      action: PreflightAction.Run,
      reason: 'strict profile + engine src changed',
      canFail: false,
    });
  } else if (cls.anyEngineSource || cls.anyTests) {
    gates.push({
      id: 'tests',
      title: 'Bun test suite',
      command: 'bun test',
      action: PreflightAction.Recommend,
      reason: 'engine src or tests changed; full suite not auto-run',
      canFail: true,
    });
  } else {
    gates.push({
      id: 'tests',
      title: 'Bun test suite',
      command: 'bun test',
      action: PreflightAction.Skip,
      reason: 'no engine src or test changes',
      canFail: true,
    });
  }

  // 10) Typecheck — always recommended on the quick profile; run on standard+.
  if (cls.anyEngineSource) {
    if (profile === PreflightProfile.Quick) {
      gates.push({
        id: 'typecheck',
        title: 'TypeScript --noEmit',
        command: 'bun x tsc -p tsconfig.base.json --noEmit',
        action: PreflightAction.Recommend,
        reason: 'engine src changed; not auto-run on quick profile',
        canFail: true,
      });
    } else {
      gates.push({
        id: 'typecheck',
        title: 'TypeScript --noEmit',
        command: 'bun x tsc -p tsconfig.base.json --noEmit',
        action: PreflightAction.Run,
        reason: 'engine src changed',
        canFail: false,
      });
    }
  } else {
    gates.push({
      id: 'typecheck',
      title: 'TypeScript --noEmit',
      command: 'bun x tsc -p tsconfig.base.json --noEmit',
      action: PreflightAction.Skip,
      reason: 'no engine src changed',
      canFail: true,
    });
  }

  // Profile-specific tweaks.
  if (profile === PreflightProfile.Quick) {
    // Quick: drop "Recommend" entries to "Skip" so the operator has a tight loop.
    explanations.push(
      'quick profile: gates flagged Recommend are not surfaced as actionable; pass --profile standard for the fuller loop.',
    );
  } else if (profile === PreflightProfile.Strict) {
    explanations.push('strict profile: tests + safety audit run on engine-affecting changes.');
  } else {
    explanations.push('standard profile: type / boundary / hygiene / self-config gates run; tests recommended.');
  }

  const wouldRun = gates.filter((g) => g.action === PreflightAction.Run);
  const wouldSkip = gates.filter((g) => g.action === PreflightAction.Skip);
  const recommended = gates.filter((g) => g.action === PreflightAction.Recommend);
  const verdict: IPreflightVerdict = {
    action: wouldRun.length > 0 ? 'attention' : 'ok',
    summary: `would run ${wouldRun.length}, skip ${wouldSkip.length}, recommend ${recommended.length}`,
  };

  void nodePath;
  return {
    schema: CHANGED_PREFLIGHT_SCHEMA,
    profile,
    changedFiles: options.changedFiles,
    classifications: cls,
    gates,
    verdict,
    explanations,
  };
}

export function renderChangedPreflightText(plan: IChangedPreflightPlan): string {
  const lines: string[] = [];
  lines.push('=== Changed-only preflight plan ===');
  lines.push(`  profile        ${plan.profile}`);
  lines.push(`  changed files  ${plan.changedFiles.length}`);
  lines.push(`  verdict        ${plan.verdict.action} (${plan.verdict.summary})`);
  lines.push('');
  for (const g of plan.gates) {
    lines.push(`  [${g.action.padEnd(9)}] ${g.id.padEnd(22)} ${g.command}`);
    lines.push(`              reason: ${g.reason}`);
  }
  if (plan.explanations.length > 0) {
    lines.push('');
    lines.push('Notes:');
    for (const n of plan.explanations) lines.push(`  • ${n}`);
  }
  return lines.join('\n') + '\n';
}
