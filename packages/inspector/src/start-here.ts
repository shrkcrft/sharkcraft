/**
 * `shrk start-here` — the human entry point.
 *
 * SharkCraft ships 200+ commands. New consumers need a 30-second answer to
 * "what should I run first?". This module is the deterministic source of
 * that answer. It does not call any external system, does not read the
 * project state, and never writes — it's a curated list.
 *
 * The same data backs both:
 *  - CLI: `shrk start-here`, `shrk start-here --flow <name>`, `shrk commands primary`
 *  - MCP: `get_start_here`, `get_primary_commands` (read-only)
 */

export const START_HERE_SCHEMA = 'sharkcraft.start-here/v1';
export const PRIMARY_COMMANDS_SCHEMA = 'sharkcraft.primary-commands/v1';

export type StartHereFlow =
  | 'onboard'
  | 'investigate'
  | 'brief'
  | 'dev'
  | 'review'
  | 'governance'
  | 'packs'
  | 'release';

export type SafetyLevel = 'read-only' | 'writes-drafts' | 'writes-source';

export interface IStartHereFlow {
  id: StartHereFlow;
  title: string;
  whenToUse: string;
  /** 3–6 commands max. */
  commands: readonly string[];
  safety: SafetyLevel;
  docsLink: string;
  nextCommand: string;
}

export interface IStartHereReport {
  schema: typeof START_HERE_SCHEMA;
  thirtySecondExplanation: string;
  safetyPledge: readonly string[];
  primaryFlows: readonly IStartHereFlow[];
  optionalFlows: readonly IStartHereFlow[];
  recommendedFirstCommand: string;
}

export interface IPrimaryCommand {
  command: string;
  description: string;
  safety: SafetyLevel;
  docsLink: string;
}

export interface IPrimaryCommandsReport {
  schema: typeof PRIMARY_COMMANDS_SCHEMA;
  primary: readonly IPrimaryCommand[];
}

const FLOWS_PRIMARY: readonly IStartHereFlow[] = [
  {
    id: 'onboard',
    title: 'Onboard an existing repo',
    whenToUse: 'You have a TypeScript / Bun / Node repo and want SharkCraft to understand it.',
    commands: [
      'shrk onboard --dry-run',
      'shrk onboard --write-drafts --scaffold-templates',
      'shrk onboard adopt status',
      'shrk doctor',
    ],
    safety: 'writes-drafts',
    docsLink: 'docs/onboarding.md',
    nextCommand: 'shrk brief "<first task you want the agent to handle>"',
  },
  {
    id: 'investigate',
    title: 'Understand existing code (before you edit)',
    whenToUse:
      'You need to know who calls a symbol, where it is used (file:line), what breaks if you change a file, whether code A is wired to code B, or who implements an interface — use the graph instead of grep.',
    commands: [
      'shrk graph index',
      'shrk graph callers <symbol>',
      'shrk graph path <from> <to>',
      'shrk graph context <file-or-symbol>',
      'shrk graph impact <file-or-symbol> --full',
    ],
    safety: 'read-only',
    docsLink: 'docs/overview.md',
    nextCommand: 'shrk graph callers <symbol>',
  },
  {
    id: 'brief',
    title: 'Prepare an AI agent brief',
    whenToUse: 'You want a deterministic, token-budgeted briefing for an AI coding agent.',
    commands: [
      'shrk brief "<task>"',
      'shrk brief "<task>" --chunk --output-dir .sharkcraft/briefs/<task>',
      'shrk task "<task>" --json',
      'shrk search "<keywords>"',
    ],
    safety: 'read-only',
    docsLink: 'docs/brief.md',
    nextCommand: 'shrk dev start "<task>" --brief',
  },
  {
    id: 'dev',
    title: 'Start a safe dev workflow',
    whenToUse: 'You want a tracked, replayable session with audit trail.',
    commands: [
      'shrk dev start "<task>" --brief',
      'shrk dev status <id>',
      'shrk dev report <id>',
      'shrk handoff --session <id>',
    ],
    safety: 'writes-drafts',
    docsLink: 'docs/dev-workflow.md',
    nextCommand: 'shrk dev report <id>',
  },
  {
    id: 'review',
    title: 'Review a PR / change',
    whenToUse: 'A diff or PR needs a structured, deterministic review packet.',
    commands: [
      'shrk impact --since origin/main',
      'shrk review packet --v3 --since origin/main',
      'shrk review render-comment --format markdown',
      'shrk report site --output .sharkcraft/reports/site',
    ],
    safety: 'read-only',
    docsLink: 'docs/review.md',
    nextCommand: 'shrk report site',
  },
  {
    id: 'governance',
    title: 'Run governance / quality checks',
    whenToUse: 'CI gate, periodic health check, or before a release.',
    commands: [
      'shrk quality',
      'shrk safety audit',
      'shrk commands doctor',
      'shrk runtime doctor',
      'shrk release readiness',
    ],
    safety: 'read-only',
    docsLink: 'docs/governance.md',
    nextCommand: 'shrk release readiness --strict',
  },
];

const FLOWS_OPTIONAL: readonly IStartHereFlow[] = [
  {
    id: 'packs',
    title: 'Build a pack',
    whenToUse: 'You want to ship SharkCraft knowledge for a project family.',
    commands: [
      'shrk packs new <pack-name> --kind architecture --write',
      'shrk packs doctor --release',
      'shrk packs release-check <pack-name>',
      'shrk packs compat <pack-name> --consumer-root <consumer>',
    ],
    safety: 'writes-drafts',
    docsLink: 'docs/pack-authoring.md',
    nextCommand: 'shrk packs sign <pack-name>',
  },
  {
    id: 'release',
    title: 'Prepare a release',
    whenToUse: 'You are about to tag.',
    commands: [
      'shrk release readiness',
      'shrk demo package --validate',
      'shrk release smoke',
      'bun run release:preflight',
      'shrk release readiness --strict --preflight auto',
    ],
    safety: 'read-only',
    docsLink: 'docs/release-readiness.md',
    nextCommand: 'bun run release:preflight',
  },
];

const PRIMARY_COMMANDS: readonly IPrimaryCommand[] = [
  {
    command: 'shrk onboard',
    description: 'Bring SharkCraft into a repo that does not have it yet.',
    safety: 'writes-drafts',
    docsLink: 'docs/onboarding.md',
  },
  {
    command: 'shrk search',
    description: 'Find a knowledge entry / rule / template / path by keyword.',
    safety: 'read-only',
    docsLink: 'docs/search.md',
  },
  {
    command: 'shrk impact',
    description: 'Score the blast radius of the current diff.',
    safety: 'read-only',
    docsLink: 'docs/impact.md',
  },
  {
    command: 'shrk brief',
    description: 'Render a task brief for an AI agent.',
    safety: 'read-only',
    docsLink: 'docs/brief.md',
  },
  {
    command: 'shrk spec create',
    description:
      'Scaffold an intent artifact (spec) for non-trivial features. Spec lives under .sharkcraft/specs/<id>/.',
    safety: 'writes-drafts',
    docsLink: 'docs/spec-driven-development.md',
  },
  {
    command: 'shrk dev start',
    description: 'Begin a tracked, replayable dev session.',
    safety: 'writes-drafts',
    docsLink: 'docs/dev-workflow.md',
  },
  {
    command: 'shrk quality',
    description: 'Run the structural quality checks.',
    safety: 'read-only',
    docsLink: 'docs/quality.md',
  },
  {
    command: 'shrk review packet',
    description: 'Build a deterministic PR review packet.',
    safety: 'read-only',
    docsLink: 'docs/review.md',
  },
  {
    command: 'shrk report site',
    description: 'Render the static, JS-free SharkCraft report site.',
    safety: 'read-only',
    docsLink: 'docs/static-reports.md',
  },
  {
    command: 'shrk release readiness',
    description: 'Aggregate audit for "is this safe to tag?"',
    safety: 'read-only',
    docsLink: 'docs/release-readiness.md',
  },
  {
    command: 'shrk commands',
    description: 'Browse / search the command catalog.',
    safety: 'read-only',
    docsLink: 'docs/command-safety-matrix.md',
  },
  {
    command: 'shrk start-here',
    description: 'This screen — pick a flow and run the next command.',
    safety: 'read-only',
    docsLink: 'docs/start-here.md',
  },
];

export function buildStartHereReport(flow?: StartHereFlow | null): IStartHereReport {
  const primary = flow ? FLOWS_PRIMARY.filter((f) => f.id === flow) : FLOWS_PRIMARY;
  const optional = flow ? FLOWS_OPTIONAL.filter((f) => f.id === flow) : FLOWS_OPTIONAL;
  return {
    schema: START_HERE_SCHEMA,
    thirtySecondExplanation:
      'SharkCraft makes a repository AI-operable without giving AI unsafe write access. The CLI is the only write path. Everything an agent can read is also human-runnable and reproducible.',
    safetyPledge: [
      'MCP tools never write to disk.',
      'The dashboard server is GET/HEAD only.',
      '`shrk gen` is dry-run by default; `apply` requires `--verify-signature`.',
      'Pack-contributed verification commands are not auto-run.',
    ],
    primaryFlows: primary,
    optionalFlows: optional,
    recommendedFirstCommand: 'shrk doctor',
  };
}

export function buildPrimaryCommandsReport(): IPrimaryCommandsReport {
  return { schema: PRIMARY_COMMANDS_SCHEMA, primary: PRIMARY_COMMANDS };
}

export function renderStartHereText(report: IStartHereReport): string {
  const lines: string[] = [];
  lines.push('# SharkCraft — start here');
  lines.push('');
  lines.push(report.thirtySecondExplanation);
  lines.push('');
  lines.push('## Safety pledge');
  for (const p of report.safetyPledge) lines.push(`  - ${p}`);
  lines.push('');
  lines.push('## Primary flows');
  for (const f of report.primaryFlows) {
    lines.push('');
    lines.push(`### ${f.title}  [${f.safety}]`);
    lines.push(`When: ${f.whenToUse}`);
    lines.push('Commands:');
    for (const c of f.commands) lines.push(`  $ ${c}`);
    lines.push(`Docs: ${f.docsLink}`);
    lines.push(`Next: ${f.nextCommand}`);
  }
  if (report.optionalFlows.length > 0) {
    lines.push('');
    lines.push('## Optional flows');
    for (const f of report.optionalFlows) {
      lines.push('');
      lines.push(`### ${f.title}  [${f.safety}]`);
      lines.push(`When: ${f.whenToUse}`);
      lines.push('Commands:');
      for (const c of f.commands) lines.push(`  $ ${c}`);
      lines.push(`Docs: ${f.docsLink}`);
    }
  }
  lines.push('');
  lines.push(`First command to try: $ ${report.recommendedFirstCommand}`);
  return lines.join('\n') + '\n';
}

export function renderPrimaryCommandsText(report: IPrimaryCommandsReport): string {
  const lines: string[] = [];
  lines.push('# Primary SharkCraft commands');
  lines.push('');
  for (const c of report.primary) {
    lines.push(`  $ ${c.command.padEnd(28)}  ${c.description}  [${c.safety}]`);
  }
  return lines.join('\n') + '\n';
}
