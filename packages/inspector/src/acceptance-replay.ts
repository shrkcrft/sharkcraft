/**
 * Acceptance-command replay.
 *
 * Given a change set, decides which previous validation commands (the
 * read-only acceptance gates from the dev-cycle / preflight planners +
 * the changes-summary suggestions) should be re-run, and *why*. No
 * shell execution — purely a structured "punch list".
 *
 * Reads:
 *   - the changes-summary report,
 *   - the dev-cycle preflight gate plan (static gate set).
 *
 * Output: `sharkcraft.acceptance-replay/v1`.
 */

import { ChangeArea, type IChangesSummaryReport } from './changes-summary.ts';

export const ACCEPTANCE_REPLAY_SCHEMA = 'sharkcraft.acceptance-replay/v1';

export enum ReplayProfile {
  ChangedOnly = 'changed-only',
  Standard = 'standard',
  Strict = 'strict',
}

export enum ReplayReason {
  Cli = 'cli-touched',
  Mcp = 'mcp-tool-touched',
  Safety = 'safety-relevant-touched',
  PackAsset = 'pack-asset-touched',
  Schema = 'schema-or-schema-like-touched',
  Boundaries = 'boundary-or-config-touched',
  Inspector = 'inspector-touched',
  Generator = 'generator-or-apply-touched',
  Docs = 'docs-only-touched',
  AlwaysOn = 'baseline-gate',
}

export interface IReplayCommand {
  readonly command: string;
  readonly reasons: ReadonlyArray<ReplayReason>;
  readonly expectedExitCode: number;
  readonly category: 'baseline' | 'gate' | 'suggested';
  readonly safety: 'read-only' | 'runs-shell';
}

export interface IAcceptanceReplayReport {
  readonly schema: typeof ACCEPTANCE_REPLAY_SCHEMA;
  readonly generatedAt: string;
  readonly profile: ReplayProfile;
  readonly roundLabel?: string;
  readonly source: IChangesSummaryReport['source'];
  readonly ref?: string;
  readonly totalChangedFiles: number;
  readonly commands: ReadonlyArray<IReplayCommand>;
  readonly skipped: ReadonlyArray<{ command: string; reason: string }>;
}

interface IGateDefinition {
  command: string;
  category: 'baseline' | 'gate';
  reason: ReplayReason;
  /** Predicate over the changes-summary report. */
  trigger: (r: IChangesSummaryReport) => boolean;
}

const BASELINE_GATES: ReadonlyArray<IGateDefinition> = [
  {
    command: 'bun x tsc -p tsconfig.base.json --noEmit',
    category: 'baseline',
    reason: ReplayReason.AlwaysOn,
    trigger: () => true,
  },
  {
    command: 'bun test',
    category: 'baseline',
    reason: ReplayReason.AlwaysOn,
    trigger: () => true,
  },
  {
    command: 'shrk doctor',
    category: 'baseline',
    reason: ReplayReason.AlwaysOn,
    trigger: () => true,
  },
];

const CONDITIONAL_GATES: ReadonlyArray<IGateDefinition> = [
  {
    command: 'shrk commands doctor',
    category: 'gate',
    reason: ReplayReason.Cli,
    trigger: (r) => r.touchedCommands.length > 0,
  },
  {
    command: 'shrk commands ux-check',
    category: 'gate',
    reason: ReplayReason.Cli,
    trigger: (r) => r.touchedCommands.length > 0,
  },
  {
    command: 'shrk safety audit --deep',
    category: 'gate',
    reason: ReplayReason.Safety,
    trigger: (r) => r.touchedMcpTools.length > 0 || r.safetyRelevantFiles.length > 0,
  },
  {
    command: 'shrk check boundaries --changed-only',
    category: 'gate',
    reason: ReplayReason.Boundaries,
    trigger: (r) =>
      r.files.some(
        (f) => f.area === ChangeArea.Boundaries || f.path.endsWith('tsconfig.base.json'),
      ) ||
      r.files.some((f) => f.path.startsWith('packages/')),
  },
  {
    command: 'shrk packs signature-status',
    category: 'gate',
    reason: ReplayReason.PackAsset,
    trigger: (r) => r.touchedPackAssets.length > 0,
  },
  {
    command: 'shrk packs doctor --require-signatures',
    category: 'gate',
    reason: ReplayReason.PackAsset,
    trigger: (r) => r.touchedPackAssets.length > 0,
  },
  {
    command: 'shrk self-config doctor',
    category: 'gate',
    reason: ReplayReason.Inspector,
    trigger: (r) =>
      r.files.some(
        (f) =>
          f.area === ChangeArea.Inspector ||
          f.area === ChangeArea.Sharkcraft ||
          f.path.startsWith('sharkcraft/'),
      ),
  },
  {
    command: 'shrk product check',
    category: 'gate',
    reason: ReplayReason.Inspector,
    trigger: (r) => r.files.some((f) => f.area === ChangeArea.Inspector),
  },
  {
    command: 'shrk schemas inventory --multi-version-only',
    category: 'gate',
    reason: ReplayReason.Schema,
    trigger: (r) => r.touchedSchemas.length > 0,
  },
  {
    command: 'bun run release:preflight',
    category: 'gate',
    reason: ReplayReason.Generator,
    trigger: (r) =>
      r.files.some(
        (f) =>
          f.area === ChangeArea.Generator ||
          f.path.startsWith('packages/cli/src/commands/apply.command') ||
          f.path.startsWith('scripts/release'),
      ),
  },
];

export interface IBuildAcceptanceReplayInput {
  readonly summary: IChangesSummaryReport;
  readonly profile?: ReplayProfile;
  readonly roundLabel?: string;
}

export function buildAcceptanceReplay(
  input: IBuildAcceptanceReplayInput,
): IAcceptanceReplayReport {
  const profile = input.profile ?? ReplayProfile.ChangedOnly;
  const summary = input.summary;
  const commands: IReplayCommand[] = [];
  const skipped: Array<{ command: string; reason: string }> = [];

  // Baselines — always on, but in changed-only mode if zero files we skip
  // type/test gates (purely a UX courtesy).
  for (const g of BASELINE_GATES) {
    if (profile === ReplayProfile.ChangedOnly && summary.totalFiles === 0 && g.command !== 'shrk doctor') {
      skipped.push({ command: g.command, reason: 'no changed files; baseline skipped under changed-only profile' });
      continue;
    }
    commands.push({
      command: g.command,
      reasons: [g.reason],
      expectedExitCode: 0,
      category: g.category,
      safety: g.command.startsWith('bun ') ? 'runs-shell' : 'read-only',
    });
  }

  // Conditional gates — only when the change set demands.
  for (const g of CONDITIONAL_GATES) {
    const fired = g.trigger(summary);
    if (fired) {
      commands.push({
        command: g.command,
        reasons: [g.reason],
        expectedExitCode: 0,
        category: g.category,
        safety: g.command.startsWith('bun ') ? 'runs-shell' : 'read-only',
      });
    } else if (profile === ReplayProfile.Strict) {
      // Strict profile runs everything regardless.
      commands.push({
        command: g.command,
        reasons: [ReplayReason.AlwaysOn],
        expectedExitCode: 0,
        category: g.category,
        safety: g.command.startsWith('bun ') ? 'runs-shell' : 'read-only',
      });
    } else if (profile === ReplayProfile.Standard) {
      // Standard profile reports the skip with explicit reason.
      skipped.push({
        command: g.command,
        reason: `not triggered by change set (reason=${g.reason})`,
      });
    }
  }

  // Bring in changes-summary suggested commands as 'suggested' category,
  // dedup against gates already added.
  const known = new Set(commands.map((c) => c.command));
  for (const s of summary.suggestedValidationCommands) {
    if (known.has(s)) continue;
    commands.push({
      command: s,
      reasons: [ReplayReason.AlwaysOn],
      expectedExitCode: 0,
      category: 'suggested',
      safety: s.startsWith('bun ') ? 'runs-shell' : 'read-only',
    });
  }

  return {
    schema: ACCEPTANCE_REPLAY_SCHEMA,
    generatedAt: new Date().toISOString(),
    profile,
    ...(input.roundLabel ? { roundLabel: input.roundLabel } : summary.roundLabel ? { roundLabel: summary.roundLabel } : {}),
    source: summary.source,
    ...(summary.ref ? { ref: summary.ref } : {}),
    totalChangedFiles: summary.totalFiles,
    commands,
    skipped,
  };
}

export function renderAcceptanceReplayText(report: IAcceptanceReplayReport): string {
  const lines: string[] = [];
  lines.push(
    `=== Acceptance replay (profile=${report.profile}${report.roundLabel ? `, round=${report.roundLabel}` : ''}${report.ref ? `, since=${report.ref}` : ''}) ===`,
  );
  lines.push(`  changed files: ${report.totalChangedFiles}`);
  lines.push(`  commands:      ${report.commands.length}`);
  if (report.skipped.length > 0) lines.push(`  skipped:       ${report.skipped.length}`);
  for (const c of report.commands) {
    const tag = c.category.padEnd(9);
    lines.push(`  [${tag}] $ ${c.command}`);
    lines.push(`            reasons: ${c.reasons.join(', ')}`);
  }
  if (report.skipped.length > 0) {
    lines.push('\nSkipped:');
    for (const s of report.skipped) lines.push(`  • ${s.command}  — ${s.reason}`);
  }
  return lines.join('\n') + '\n';
}

export function renderAcceptanceReplayMarkdown(report: IAcceptanceReplayReport): string {
  const lines: string[] = [];
  lines.push('# Acceptance replay');
  lines.push('');
  lines.push(`- profile: \`${report.profile}\``);
  if (report.roundLabel) lines.push(`- round: \`${report.roundLabel}\``);
  if (report.ref) lines.push(`- ref: \`${report.ref}\``);
  lines.push(`- changed files: ${report.totalChangedFiles}`);
  lines.push('');
  lines.push('## Commands to re-run');
  for (const c of report.commands) {
    lines.push(`- \`${c.command}\`  _(${c.category}, ${c.reasons.join(', ')})_`);
  }
  if (report.skipped.length > 0) {
    lines.push('');
    lines.push('## Skipped');
    for (const s of report.skipped) lines.push(`- \`${s.command}\` — ${s.reason}`);
  }
  return lines.join('\n') + '\n';
}
