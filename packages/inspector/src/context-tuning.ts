import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { listSearchTuning, tuningBoostFor } from './search-tuning-registry.ts';
import { searchDocumentId, searchKindForPrefix } from './search-document-id.ts';
import { tuningQueryTokens } from './tuning-query-tokens.ts';

// Context relevance scores are on a large scale (priority × weights, ~100–190),
// so the pack's small ambient boostTags (±2–3) are noise there. The meaningful
// signal for "this entry must surface" is a TASK-SPECIFIC taskHint boost
// (whenTokens-gated boostIds). We isolate it (full boost minus the
// token-agnostic ambient boost) and scale it so a directed taskHint boost
// decisively lifts the entry into its section — without disturbing the base
// relevance order of everything the pack did NOT explicitly target.
const TASK_HINT_SCALE = 100;

/**
 * Build a context `boostFor(entry)` callback from the pack search-tuning — the
 * same tuning `shrk search` and the task ranker use. Returns the TASK-SPECIFIC
 * (taskHint) boost only, scaled for the context score range; ambient boostTags
 * are intentionally ignored here. Returns undefined when no tuning is loaded so
 * buildContext skips the re-rank entirely.
 *
 * The document id comes from THE search-document codec and the trigger tokens
 * from THE tuning tokenizer, so a key or trigger that fires in `shrk search`
 * fires here too (a hyphenated `changed-only` trigger used to fire only there).
 */
export function contextTuningBoostFor(
  inspection: ISharkcraftInspection,
  task: string,
):
  | ((entry: { readonly id: string; readonly type?: unknown; readonly tags?: readonly string[] }) => number)
  | undefined {
  const tuning = listSearchTuning(inspection);
  if (tuning.length === 0) return undefined;
  const tokens = tuningQueryTokens(task);
  return (entry) => {
    const prefix = String(entry.type).toLowerCase() === 'rule' ? 'rule' : 'knowledge';
    const doc = {
      id: searchDocumentId(prefix, entry.id),
      kind: searchKindForPrefix(prefix) ?? prefix,
      ...(entry.tags ? { tags: entry.tags } : {}),
      source: 'local',
    };
    const full = tuningBoostFor(doc, tokens, tuning).delta;
    const ambient = tuningBoostFor(doc, [], tuning).delta;
    const taskHintDelta = full - ambient;
    return taskHintDelta > 0 ? taskHintDelta * TASK_HINT_SCALE : 0;
  };
}
