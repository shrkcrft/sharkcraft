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

  // Priority baseline always contributes (so a critical rule outranks a low-priority match).
  score += priorityWeight(entry.priority as never) / 10;

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
    if (entry.title.toLowerCase().includes(queryText)) {
      score += FIELD_WEIGHTS.title;
      reasons.push({ field: 'title', match: queryText });
    }
    if (entry.summary?.toLowerCase().includes(queryText)) {
      score += FIELD_WEIGHTS.summary;
      reasons.push({ field: 'summary', match: queryText });
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
