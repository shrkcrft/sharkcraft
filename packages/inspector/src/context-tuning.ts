import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { listSearchTuning, tuningBoostFor } from './search-tuning-registry.ts';

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
 */
export function contextTuningBoostFor(
  inspection: ISharkcraftInspection,
  task: string,
):
  | ((entry: { readonly id: string; readonly type?: unknown; readonly tags?: readonly string[] }) => number)
  | undefined {
  const tuning = listSearchTuning(inspection);
  if (tuning.length === 0) return undefined;
  const tokens = task
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
  return (entry) => {
    const isRule = String(entry.type).toLowerCase() === 'rule';
    const doc = {
      id: `${isRule ? 'rule' : 'knowledge'}:${entry.id}`,
      kind: isRule ? 'rule' : 'knowledge',
      ...(entry.tags ? { tags: entry.tags } : {}),
      source: 'local',
    };
    const full = tuningBoostFor(doc, tokens, tuning).delta;
    const ambient = tuningBoostFor(doc, [], tuning).delta;
    const taskHintDelta = full - ambient;
    return taskHintDelta > 0 ? taskHintDelta * TASK_HINT_SCALE : 0;
  };
}
