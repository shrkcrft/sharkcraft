export const DEMO_SCRIPT_SCHEMA = 'sharkcraft.demo-script/v1';

export enum DemoScenario {
  UnconfiguredRepo = 'unconfigured-repo',
  PrReview = 'pr-review',
  Governance = 'governance',
}

export interface IDemoScriptStep {
  title: string;
  commands: readonly string[];
  notes?: string;
  /** True when the step has potential side-effects beyond .sharkcraft. */
  destructive?: boolean;
}

export interface IDemoScript {
  schema: typeof DEMO_SCRIPT_SCHEMA;
  scenario: DemoScenario;
  title: string;
  description: string;
  steps: readonly IDemoScriptStep[];
}

const SCRIPTS: Record<DemoScenario, IDemoScript> = {
  [DemoScenario.UnconfiguredRepo]: {
    schema: DEMO_SCRIPT_SCHEMA,
    scenario: DemoScenario.UnconfiguredRepo,
    title: 'Onboard an unconfigured repo end-to-end',
    description:
      'Walks SharkCraft from "no sharkcraft/ folder" through inferred drafts, adoption, brief, dev session, and the report site.',
    steps: [
      {
        title: 'Inspect the repo',
        commands: ['shrk doctor', 'shrk inspect --json'],
      },
      {
        title: 'Run onboarding (dry-run by default)',
        commands: ['shrk onboard', 'shrk onboard adopt'],
      },
      {
        title: 'Materialise advisory drafts',
        commands: ['shrk onboard --write-drafts'],
        notes: 'Writes only under sharkcraft/onboarding/ — never overwrites live config.',
      },
      {
        title: 'Infer constructs from the codebase',
        commands: ['shrk constructs infer', 'shrk constructs infer --write-drafts'],
      },
      {
        title: 'Build a construct adoption plan',
        commands: ['shrk constructs adopt', 'shrk constructs adopt --write-patch'],
        notes: 'Writes only under sharkcraft/construct-drafts/adoption/.',
      },
      {
        title: 'Render an agent brief',
        commands: [
          'shrk brief "explore the codebase" --mode full --output .sharkcraft/briefs/onboard.md',
        ],
      },
      {
        title: 'Start a dev session',
        commands: ['shrk dev start "explore the codebase" --brief'],
        notes: 'Session metadata only — no source writes.',
      },
      {
        title: 'Generate a static report site',
        commands: ['shrk report site --output .sharkcraft/reports/site --manifest'],
      },
    ],
  },
  [DemoScenario.PrReview]: {
    schema: DEMO_SCRIPT_SCHEMA,
    scenario: DemoScenario.PrReview,
    title: 'PR review with impact, policy, and review packet',
    description:
      'Run the review surface on a feature branch: impact, review packet, and a self-contained HTML.',
    steps: [
      {
        title: 'Compute impact since main',
        commands: [
          'shrk impact --since origin/main --format html --output .sharkcraft/reports/impact.html',
          'shrk impact --since origin/main --format json > .sharkcraft/reports/impact.json',
        ],
      },
      {
        title: 'Build the review packet (v3)',
        commands: [
          'shrk review packet --v3 --since origin/main --json > /tmp/review.json',
          'shrk review render-comment /tmp/review.json --output .sharkcraft/reports/review.md',
        ],
      },
      {
        title: 'Run policy on the diff',
        commands: [
          'shrk policy run --json > .sharkcraft/reports/policy.json',
          'shrk policy snapshot --all --gate || true',
        ],
        notes: '|| true keeps the demo running even if snapshots drift.',
      },
      {
        title: 'Generate a portable static site',
        commands: [
          'shrk report site --review /tmp/review.json --impact .sharkcraft/reports/impact.json --output .sharkcraft/reports/site',
        ],
      },
    ],
  },
  [DemoScenario.Governance]: {
    schema: DEMO_SCRIPT_SCHEMA,
    scenario: DemoScenario.Governance,
    title: 'Governance loop',
    description:
      'Quality gate, policy snapshots, cross-bundle replay, baseline history, command safety matrix.',
    steps: [
      {
        title: 'Run the quality gate',
        commands: ['shrk quality --strict --ci'],
      },
      {
        title: 'Run the policy engine + snapshots',
        commands: [
          'shrk policy run --json > .sharkcraft/reports/policy.json',
          'shrk policy snapshot --all --gate',
        ],
      },
      {
        title: 'Replay every bundle',
        commands: ['shrk bundle replay --all --report --html'],
      },
      {
        title: 'Compare quality baselines',
        commands: [
          'shrk quality baseline history',
          'shrk quality baseline diff latest previous --json',
        ],
      },
      {
        title: 'Print the command safety matrix',
        commands: ['shrk commands matrix --format markdown > .sharkcraft/reports/command-matrix.md'],
      },
    ],
  },
};

export function listDemoScenarios(): readonly DemoScenario[] {
  return Object.values(DemoScenario);
}

export function getDemoScript(scenario: DemoScenario): IDemoScript {
  return SCRIPTS[scenario];
}

export function renderDemoScriptShell(script: IDemoScript): string {
  const lines: string[] = [];
  lines.push('#!/usr/bin/env bash');
  lines.push(`# SharkCraft demo — ${script.title}`);
  lines.push(`# Scenario: ${script.scenario}`);
  lines.push('# This script is never executed by SharkCraft. Review and run manually.');
  lines.push('# Re-run with --output to save it as a runnable script.');
  lines.push('set -euo pipefail');
  lines.push('');
  let i = 1;
  for (const step of script.steps) {
    lines.push(`# Step ${i}: ${step.title}`);
    if (step.notes) lines.push(`# ${step.notes}`);
    if (step.destructive) lines.push('# ⚠ destructive — review before running.');
    for (const c of step.commands) {
      lines.push(`${c}`);
    }
    lines.push('');
    i += 1;
  }
  lines.push('echo "Demo complete."');
  return lines.join('\n') + '\n';
}
