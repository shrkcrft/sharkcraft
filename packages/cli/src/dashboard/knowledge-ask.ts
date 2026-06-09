/**
 * Read-only "ask a question over the knowledge base" for the dashboard.
 *
 * Deterministic retrieval (searchKnowledge) is the source of truth and ALWAYS
 * populates `sources`. The local LLM only synthesizes a prose `answer` grounded
 * in those entries. When no LLM is reachable, or it times out / errors, the
 * response degrades gracefully to the retrieved entries — the GET handler never
 * hangs and never writes anything.
 */
import { ERROR_CODES } from '@shrkcrft/core';
import { AiMessageRole, selectAiProvider, type IAiMessage } from '@shrkcrft/ai';
import { searchKnowledge } from '@shrkcrft/knowledge';
import type { ISharkcraftInspection } from '@shrkcrft/inspector';
import type {
  IDashboardKnowledgeAskResponse,
  IDashboardKnowledgeSource,
} from '@shrkcrft/dashboard-api';

/** Hard wall-clock bound so a slow local model can't hang a dashboard GET. */
const ASK_TIMEOUT_MS = 15_000;
/** How many entries to retrieve and feed as grounding. */
const RETRIEVE_LIMIT = 8;
/** Per-entry grounding budget (chars) — keeps the prompt small for local models. */
const ENTRY_CHARS = 1100;

const SYSTEM_PROMPT = [
  'You are the SharkCraft knowledge assistant for a single repository.',
  'Answer the question USING ONLY the knowledge entries provided below as context.',
  'Every entry is delimited and prefixed with its id in [brackets].',
  'Cite the entries you used by writing their id in [brackets] inline.',
  'If the answer is not present in the provided entries, say so plainly — do not invent.',
  'Be concise: a few short paragraphs or bullets. No preamble, no sign-off.',
].join('\n');

function roundScore(n: number): number {
  return Math.round(n * 100) / 100;
}

function buildMessages(question: string, grounding: string): IAiMessage[] {
  return [
    { role: AiMessageRole.System, content: SYSTEM_PROMPT },
    {
      role: AiMessageRole.User,
      content: [
        '# Knowledge entries',
        grounding,
        '',
        '# Question',
        question.trim(),
        '',
        'Answer now, citing entry ids in [brackets].',
      ].join('\n'),
    },
  ];
}

export async function buildKnowledgeAsk(
  inspection: ISharkcraftInspection,
  question: string,
): Promise<IDashboardKnowledgeAskResponse> {
  const startedAt = Date.now();
  const trimmed = question.trim();

  // 1. Deterministic retrieval — always available, the engine's ground truth.
  const results = searchKnowledge(inspection.knowledgeEntries, {
    query: trimmed,
    limit: RETRIEVE_LIMIT,
  });
  const sources: IDashboardKnowledgeSource[] = results.map((r) => ({
    id: r.entry.id,
    title: r.entry.title,
    type: String(r.entry.type),
    score: roundScore(r.score),
  }));

  const degrade = (note: string, provider?: string): IDashboardKnowledgeAskResponse => ({
    question: trimmed,
    llmAvailable: false,
    ...(provider ? { provider } : {}),
    answer: null,
    degraded: true,
    note,
    sources,
    citedEntryIds: [],
    durationMs: Date.now() - startedAt,
  });

  // 2. Provider selection — local-only, may be absent.
  const selection = selectAiProvider(process.env.AI_PROVIDER);
  if (!selection.provider) {
    return degrade(
      'No local LLM is reachable, so this is the deterministic top-matches view. Start an Ollama daemon or set LLAMACPP_MODEL_PATH to enable synthesized answers.',
    );
  }
  if (results.length === 0) {
    return degrade('No knowledge entries matched the question.', selection.provider.id);
  }

  // 3. Grounded prompt from the retrieved entries.
  const grounding = results
    .map((r) => {
      const body = (r.entry.summary ?? r.entry.content).slice(0, ENTRY_CHARS);
      return `### [${r.entry.id}] ${r.entry.title}\n${body}`;
    })
    .join('\n\n');

  // 4. Bounded LLM call; any failure degrades to retrieval-only.
  const res = await selection.provider.send({
    messages: buildMessages(trimmed, grounding),
    maxTokens: 1024,
    temperature: 0.2,
    timeoutMs: ASK_TIMEOUT_MS,
  });
  if (!res.ok) {
    const note =
      res.error.code === ERROR_CODES.TIMEOUT
        ? 'The local LLM timed out — showing the deterministic top matches instead.'
        : `The local LLM could not answer (${res.error.message}) — showing the deterministic top matches instead.`;
    return degrade(note, selection.provider.id);
  }

  const answer = res.value.content.trim();
  const citedEntryIds = sources.map((s) => s.id).filter((id) => answer.includes(id));
  return {
    question: trimmed,
    llmAvailable: true,
    provider: selection.provider.id,
    answer,
    degraded: false,
    sources,
    citedEntryIds,
    durationMs: Date.now() - startedAt,
  };
}
