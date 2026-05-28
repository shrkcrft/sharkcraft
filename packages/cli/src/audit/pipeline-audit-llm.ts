import { AiMessageRole, type IAiMessage, type IAiProvider } from '@shrkcrft/ai';
import type { ISharkcraftInspection } from '@shrkcrft/inspector';
import type {
  ILlmPipelineAuditFinding,
  IPipelineAuditEntry,
  IPipelineAuditReport,
  PipelineAuditFindingSeverity,
} from './pipeline-audit.ts';

export interface IEnrichPipelineAuditOptions {
  provider: IAiProvider;
  inspection: ISharkcraftInspection;
  maxTokensPerPipeline?: number;
  onPerPipelineError?: (pipelineId: string, error: Error) => void;
}

export async function enrichPipelineAuditWithLlm(
  report: IPipelineAuditReport,
  options: IEnrichPipelineAuditOptions,
): Promise<IPipelineAuditReport> {
  const enriched: IPipelineAuditEntry[] = [];
  for (const entry of report.pipelines) {
    const pipeline = options.inspection.pipelineRegistry.get(entry.pipelineId);
    if (!pipeline) {
      enriched.push(entry);
      continue;
    }
    try {
      const messages = buildEnrichmentMessages(pipeline, entry);
      const res = await options.provider.send({
        messages,
        maxTokens: options.maxTokensPerPipeline ?? 1024,
      });
      if (!res.ok) {
        options.onPerPipelineError?.(entry.pipelineId, res.error as unknown as Error);
        enriched.push(entry);
        continue;
      }
      const parsed = parseLlmFindings(res.value.content);
      enriched.push({ ...entry, llmFindings: parsed });
    } catch (e) {
      options.onPerPipelineError?.(entry.pipelineId, e as Error);
      enriched.push(entry);
    }
  }

  return {
    ...report,
    llmEnriched: true,
    llmProviderId: options.provider.id,
    pipelines: enriched,
  };
}

function buildEnrichmentMessages(
  pipeline: { id: string; steps: ReadonlyArray<unknown> },
  entry: IPipelineAuditEntry,
): IAiMessage[] {
  const system: IAiMessage = {
    role: AiMessageRole.System,
    content: [
      'You are a critic auditing a SharkCraft pipeline definition for staleness, content quality, and step-ordering issues.',
      '',
      'CRITICAL DISTINCTION:',
      '- You are auditing the PIPELINE itself, not its target domain. A pipeline that orchestrates a release is fine even if the release process changes; only flag it if the pipeline now executes the wrong steps.',
      '- A step referencing a tool you do not recognise is NOT necessarily wrong — flag it only if the deterministic layer has already marked the reference as unresolved or if the name is clearly a typo of a real tool.',
      '',
      'STRICT silence bias: emit a finding only if a senior maintainer would change something on the strength of it. Better silence than ceremony.',
      '',
      'Look for issues the deterministic layer (pipelines lint) CANNOT see:',
      '  1. **step-order-bug**       — steps that depend on each other are in the wrong order.',
      '  2. **review-gap**           — a writing step lacks proper review/handoff context.',
      '  3. **missing-precondition** — a step that assumes state a prior step does not establish.',
      '  4. **stale-step**           — a step references a workflow or tool that has changed.',
      '  5. **dead-step**            — a step that no longer does anything useful.',
      '  6. **other**                — only if none of the above fit.',
      '',
      'Return ONLY a JSON object, no preface, no fences:',
      '{',
      '  "findings": [',
      '    { "severity": "info"|"warn"|"error", "category": "<one of the above>", "message": "<one sentence>", "confidence": 0.0 }',
      '  ]',
      '}',
      'If nothing new is worth flagging, return {"findings": []}.',
    ].join('\n'),
  };
  const user: IAiMessage = {
    role: AiMessageRole.User,
    content: [
      `# Pipeline under audit`,
      `id: ${pipeline.id}`,
      ``,
      `## Steps`,
      JSON.stringify(pipeline.steps, null, 2).slice(0, 4096),
      ``,
      `## Deterministic findings already produced`,
      entry.deterministicFindings.length === 0
        ? '(none)'
        : entry.deterministicFindings
            .map((f) => `- [${f.severity}] ${f.category}${f.stepId ? ` (${f.stepId})` : ''}: ${f.message}`)
            .join('\n'),
    ].join('\n'),
  };
  return [system, user];
}

function parseLlmFindings(raw: string): readonly ILlmPipelineAuditFinding[] {
  const trimmed = raw.trim();
  let jsonText = trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) jsonText = fenced[1]!.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    const first = jsonText.indexOf('{');
    const last = jsonText.lastIndexOf('}');
    if (first < 0 || last <= first) return [];
    try {
      parsed = JSON.parse(jsonText.slice(first, last + 1));
    } catch {
      return [];
    }
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const list = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(list)) return [];
  const out: ILlmPipelineAuditFinding[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const severity = coerceSeverity(obj.severity);
    const category = typeof obj.category === 'string' && obj.category.trim() ? obj.category.trim() : 'other';
    const message = typeof obj.message === 'string' ? obj.message.trim() : '';
    const confidence =
      typeof obj.confidence === 'number' && obj.confidence >= 0 && obj.confidence <= 1
        ? obj.confidence
        : 0.5;
    if (!message) continue;
    out.push({ severity, category, message, confidence });
  }
  return out;
}

function coerceSeverity(value: unknown): PipelineAuditFindingSeverity {
  if (value === 'error' || value === 'warn' || value === 'info') return value;
  if (value === 'warning') return 'warn';
  return 'info';
}
