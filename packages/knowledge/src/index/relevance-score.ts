import type { IKnowledgeEntry } from '../model/knowledge-entry.ts';
import type { IKnowledgeQuery } from '../model/knowledge-query.ts';
import type { IKnowledgeMatchReason } from '../model/knowledge-search-result.ts';
import { priorityWeight } from '../model/knowledge-priority.ts';

export interface ScoredMatch {
  score: number;
  reasons: IKnowledgeMatchReason[];
}

const FIELD_WEIGHTS = {
  id: 80,
  title: 50,
  tags: 35,
  scope: 30,
  appliesWhen: 40,
  summary: 25,
  content: 15,
};

export function scoreEntry(entry: IKnowledgeEntry, query: IKnowledgeQuery): ScoredMatch {
  let score = 0;
  const reasons: IKnowledgeMatchReason[] = [];

  // Priority baseline always contributes so that — once an entry has *any*
  // match reason — a foundational critical rule (e.g. architecture.layer-order)
  // outranks a non-critical entry that merely shares a keyword. The old
  // `/ 10` shrank Critical (weight 100) to a baseline of 10, an order of
  // magnitude below a single lexical hit (id 80, title 50, appliesWhen 40), so
  // critical rules were reliably buried. Use the full priority weight: Critical
  // 100, High 70, Medium 40, Low 10 — on par with a strong lexical hit, while
  // a *strong* multi-field lexical match (which sums well past 100) still wins.
  // This does not surface no-reason entries: the index drops score>0 results
  // with empty reasons, so an irrelevant critical rule never leaks in on
  // priority alone.
  score += priorityWeight(entry.priority as never);

  // Type filter is a hard match — only score the rest if type matches when types specified.
  const queryText = (query.query ?? '').trim().toLowerCase();
  const queryWords = queryText
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);

  // Free-text matches
  if (queryText.length > 0) {
    if (entry.id.toLowerCase().includes(queryText)) {
      score += FIELD_WEIGHTS.id;
      reasons.push({ field: 'id', match: queryText });
    }
    // Title / summary: an exact full-phrase hit earns the full weight; otherwise
    // credit by the SHARE of query words present. Matching per-word — not only
    // the whole query string — lets a semantically relevant title (e.g.
    // "Catalog i18n overlay" for "localize product catalog translations
    // currency") outscore an entry that merely shares one incidental tag. The
    // old full-phrase-only check earned title/summary zero on every multi-word
    // query, so a single off-topic tag hit could win.
    const wordCount = Math.max(1, queryWords.length);
    const titleLc = entry.title.toLowerCase();
    if (titleLc.includes(queryText)) {
      score += FIELD_WEIGHTS.title;
      reasons.push({ field: 'title', match: queryText });
    } else {
      const hits = queryWords.filter((w) => titleLc.includes(w));
      if (hits.length > 0) {
        score += FIELD_WEIGHTS.title * (hits.length / wordCount);
        reasons.push({ field: 'title', match: hits.join(' ') });
      }
    }
    const summaryLc = entry.summary?.toLowerCase() ?? '';
    if (summaryLc.length > 0) {
      if (summaryLc.includes(queryText)) {
        score += FIELD_WEIGHTS.summary;
        reasons.push({ field: 'summary', match: queryText });
      } else {
        const hits = queryWords.filter((w) => summaryLc.includes(w));
        if (hits.length > 0) {
          score += FIELD_WEIGHTS.summary * (hits.length / wordCount);
          reasons.push({ field: 'summary', match: hits.join(' ') });
        }
      }
    }
    if (entry.content.toLowerCase().includes(queryText)) {
      score += FIELD_WEIGHTS.content;
      reasons.push({ field: 'content', match: queryText });
    }

    // Per-word matches against tag/scope/appliesWhen.
    for (const word of queryWords) {
      if (entry.tags.some((t) => t.toLowerCase().includes(word))) {
        score += FIELD_WEIGHTS.tags / queryWords.length;
        reasons.push({ field: 'tags', match: word });
      }
      if (entry.scope.some((s) => s.toLowerCase().includes(word))) {
        score += FIELD_WEIGHTS.scope / queryWords.length;
        reasons.push({ field: 'scope', match: word });
      }
      if (entry.appliesWhen.some((a) => a.toLowerCase().includes(word))) {
        score += FIELD_WEIGHTS.appliesWhen / queryWords.length;
        reasons.push({ field: 'appliesWhen', match: word });
      }
    }
  }

  // appliesWhen exact-match bonus.
  if (query.appliesWhen?.length) {
    const matches = entry.appliesWhen.filter((a) => query.appliesWhen!.includes(a));
    if (matches.length > 0) {
      score += FIELD_WEIGHTS.appliesWhen;
      for (const m of matches) reasons.push({ field: 'appliesWhen', match: m });
    }
  }

  // scope exact-match bonus.
  if (query.scope?.length) {
    const matches = entry.scope.filter((s) => query.scope!.includes(s));
    if (matches.length > 0) {
      score += FIELD_WEIGHTS.scope;
      for (const m of matches) reasons.push({ field: 'scope', match: m });
    }
  }

  // tag exact-match bonus.
  if (query.tags?.length) {
    const matches = entry.tags.filter((t) => query.tags!.includes(t));
    if (matches.length === query.tags.length) {
      score += FIELD_WEIGHTS.tags;
      for (const m of matches) reasons.push({ field: 'tags', match: m });
    } else if (matches.length > 0) {
      score += FIELD_WEIGHTS.tags / 2;
      for (const m of matches) reasons.push({ field: 'tags', match: m });
    }
  }

  return { score, reasons };
}
