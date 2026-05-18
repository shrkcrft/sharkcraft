import { appendFileSync } from 'node:fs';
import { LIMITS } from './config/limits.ts';
import { AgentError, ErrorCategory, classify } from './errors.ts';
import { gate, type IIssueEvent } from './gate.ts';
import { sanitize } from './sanitize.ts';
import { collectContext } from './context.ts';
import { postIssueComment } from './github.ts';
import { createRunner } from './runner/factory.ts';
import { AgentMode, type IAgentRunner } from './runner/types.ts';
import {
  buildRunUrl,
  formatTelemetryComment,
  formatTelemetrySummary,
  type ITelemetryRecord,
} from './telemetry.ts';

export interface IOrchestrateOptions {
  runner?: IAgentRunner;
  fetchFn?: typeof fetch;
  collectContextFn?: typeof collectContext;
  writeStepSummaryFn?: (content: string) => void;
}

export type OrchestrateResult =
  | { kind: 'success' }
  | { kind: 'ignored'; reason: string }
  | { kind: 'failure'; category: ErrorCategory; message: string };

export async function orchestrate(
  event: IIssueEvent,
  options: IOrchestrateOptions = {},
): Promise<OrchestrateResult> {
  const writeSummary = options.writeStepSummaryFn ?? defaultWriteStepSummary;
  const decision = gate(event);
  writeSummary(
    `### Gate\n\n- decision: \`${decision.kind}\`\n- reason: ${decision.reason}\n`,
  );

  if (decision.kind === 'ignore') {
    return { kind: 'ignored', reason: decision.reason };
  }

  if (decision.kind === 'implement') {
    writeSummary(
      '\n### Implement mode\n\nDeferred to Phase 2. No comment posted, no runner call.\n',
    );
    return { kind: 'ignored', reason: 'implement mode deferred to Phase 2' };
  }

  try {
    const sanitized = sanitize(event.issue);
    const context = await (options.collectContextFn ?? collectContext)(sanitized.title);
    const runner = options.runner ?? (await createRunner());

    const signal = AbortSignal.timeout(LIMITS.runnerDeadlineMs);
    const output = await runner.run({
      mode: AgentMode.Plan,
      issue: sanitized,
      context,
      limits: {
        maxInputTokens: LIMITS.maxInputTokens,
        maxOutputTokens: LIMITS.maxOutputTokens,
        deadlineMs: LIMITS.runnerDeadlineMs,
      },
      signal,
    });

    const telemetry: ITelemetryRecord = {
      mode: 'plan',
      model: output.telemetry.modelId,
      runUrl: buildRunUrl(),
      tokens: sumTokens(output.telemetry.inputTokens, output.telemetry.outputTokens),
    };

    const body = output.commentMarkdown + formatTelemetryComment(telemetry);
    await postIssueComment(event.issue.number, body, { fetchFn: options.fetchFn });

    writeSummary('\n' + formatTelemetrySummary(telemetry));
    return { kind: 'success' };
  } catch (err) {
    const category = classify(err);
    const message = err instanceof Error ? err.message : String(err);
    console.error('[ai-agent] error', { category, message });
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }

    if (category !== ErrorCategory.CommentPostFailed) {
      try {
        await postIssueComment(
          event.issue.number,
          buildFailureComment('plan', category),
          { fetchFn: options.fetchFn },
        );
      } catch (postErr) {
        console.error('[ai-agent] failure-comment post also failed', postErr);
      }
    }

    writeSummary(
      `\n### Failure\n\n- mode: plan\n- category: \`${category}\`\n- message: ${message}\n`,
    );
    return { kind: 'failure', category, message };
  }
}

function sumTokens(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

function buildFailureComment(mode: string, category: ErrorCategory): string {
  return [
    '## AI Run Failed',
    '',
    'The agent could not complete the requested mode.',
    '',
    `- mode: ${mode}`,
    `- category: \`${category}\``,
    `- run: ${buildRunUrl()}`,
    '',
    'See the Actions logs for details.',
  ].join('\n');
}

function defaultWriteStepSummary(content: string): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  try {
    appendFileSync(path, content + '\n');
  } catch (err) {
    console.error('[ai-agent] failed to write step summary', err);
  }
}

export { AgentError };
