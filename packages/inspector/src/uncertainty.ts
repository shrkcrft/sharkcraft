/**
 * Uncertainty reporting.
 *
 * Builds a small `IUncertaintySummary` that `task` / `context` / `brief` /
 * `contract` / `handoff` can surface so the agent does not miss silently.
 *
 * Signals:
 *  - no template matched
 *  - no playbook matched
 *  - no helper matched
 *  - no path convention matched
 *  - weak knowledge matches only
 *  - low ranker confidence
 *  - missing validation command
 *  - missing scaffold coverage axis
 *
 * Pure, deterministic. Schema: sharkcraft.uncertainty/v1.
 */
import type { ITaskPacket } from './task-packet.ts';

export const UNCERTAINTY_SCHEMA = 'sharkcraft.uncertainty/v1';

export enum UncertaintyLevel {
  High = 'high',
  Medium = 'medium',
  Low = 'low',
}

export interface IUncertaintySignal {
  code: string;
  message: string;
}

export interface IUncertaintySummary {
  schema: typeof UNCERTAINTY_SCHEMA;
  confidence: UncertaintyLevel;
  uncertainty: readonly IUncertaintySignal[];
  suggestedCommands: readonly string[];
}

function thresholdForTokens(taskTokens: number): { weakScore: number } {
  // Heuristic: weak token-hit thresholds adapt to task length.
  if (taskTokens >= 6) return { weakScore: 6 };
  if (taskTokens >= 3) return { weakScore: 4 };
  return { weakScore: 3 };
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

export function buildUncertaintySummary(packet: ITaskPacket): IUncertaintySummary {
  const signals: IUncertaintySignal[] = [];
  const task = packet.task;
  const taskTokens = tokenize(task);
  const threshold = thresholdForTokens(taskTokens.length);

  if (packet.relevantTemplates.length === 0) {
    signals.push({
      code: 'no-template-matched',
      message: `No template matched the task — consider adding one.`,
    });
  }
  if (packet.recommendedPipelines.length === 0) {
    signals.push({
      code: 'no-pipeline-matched',
      message: 'No recommended pipeline.',
    });
  }
  if (packet.relevantPaths.length === 0) {
    signals.push({
      code: 'no-path-convention-matched',
      message: 'No path convention matched.',
    });
  }
  if (packet.verificationCommands.length === 0) {
    signals.push({
      code: 'no-validation-command',
      message: 'No verification commands declared on the matching rules.',
    });
  }
  // Weak knowledge matches when ranker scores cluster under the threshold.
  const ranking = packet.rankingReasons;
  if (ranking?.rules && ranking.rules.length > 0) {
    const top = ranking.rules[0]?.score ?? 0;
    if (top < threshold.weakScore) {
      signals.push({
        code: 'weak-knowledge-matches',
        message: `Top knowledge match score is ${top} (< threshold ${threshold.weakScore}).`,
      });
    }
  }
  // Low ranker confidence overall.
  if (packet.relevantTemplates.length === 0 && packet.relevantPaths.length === 0) {
    signals.push({
      code: 'low-ranker-confidence',
      message: 'Both templates and paths missed — the ranker has low confidence.',
    });
  }

  const confidence =
    signals.length === 0
      ? UncertaintyLevel.High
      : signals.length <= 2
        ? UncertaintyLevel.Medium
        : UncertaintyLevel.Low;

  const suggestedCommands = buildSuggestedCommands(task, signals);

  return {
    schema: UNCERTAINTY_SCHEMA,
    confidence,
    uncertainty: signals,
    suggestedCommands,
  };
}

function buildSuggestedCommands(
  task: string,
  signals: readonly IUncertaintySignal[],
): string[] {
  const out: string[] = [];
  if (signals.some((s) => s.code === 'no-template-matched' || s.code === 'no-path-convention-matched')) {
    out.push(`shrk coverage scaffolds --task "${task}"`);
  }
  if (signals.some((s) => s.code === 'weak-knowledge-matches' || s.code === 'low-ranker-confidence')) {
    out.push(`shrk why-not <id> --for-task "${task}"`);
    out.push(`shrk search tuning explain "${task}"`);
    out.push(`shrk search "${task}" --explain`);
  }
  if (signals.some((s) => s.code === 'no-validation-command')) {
    out.push('shrk fix preview --action-hints');
  }
  if (out.length === 0) out.push(`shrk brief "${task}"`);
  return out;
}

export function renderUncertaintyText(summary: IUncertaintySummary): string {
  const lines: string[] = [];
  lines.push(`Confidence: ${summary.confidence}`);
  if (summary.uncertainty.length === 0) {
    lines.push('No uncertainty signals — coverage looks complete.');
    return lines.join('\n');
  }
  lines.push('Uncertainty:');
  for (const s of summary.uncertainty) lines.push(`  - ${s.message}`);
  if (summary.suggestedCommands.length > 0) {
    lines.push('Suggested:');
    for (const c of summary.suggestedCommands) lines.push(`  $ ${c}`);
  }
  return lines.join('\n');
}
