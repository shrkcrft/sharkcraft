/**
 * Ranker explainability.
 *
 * Answers `shrk why <id> --for-task "<task>"` and `shrk why-not <id> --for-task "<task>"`
 * without forcing the user to author an agent-test. The report shows whether an
 * id exists in the relevant registry, how the deterministic ranker scored it,
 * whether it would have been included in the task packet, what outranked it,
 * which signals matched / were missing, and concrete metadata fixes.
 *
 * Read-only, no AI, no network.
 *
 * Schema: sharkcraft.ranker-explainability/v1
 */
import type { IKnowledgeEntry } from '@shrkcrft/knowledge';
import type { IRule } from '@shrkcrft/rules';
import type { ITemplateDefinition } from '@shrkcrft/templates';
import type { IPipelineDefinition } from '@shrkcrft/pipelines';
import type { IPreset } from '@shrkcrft/presets';
import {
  buildSearchIndex,
  searchIndex,
  type ISearchDocument,
} from './search-index.ts';
import {
  listSearchTuning,
  tuningBoostFor,
  type ISearchTuningEntry,
} from './search-tuning-registry.ts';
import { rankAll } from './task-ranker.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const RANKER_EXPLAINABILITY_SCHEMA = 'sharkcraft.ranker-explainability/v1';

export enum RankerExplainKind {
  Knowledge = 'knowledge',
  Template = 'template',
  Rule = 'rule',
  Helper = 'helper',
  Playbook = 'playbook',
  Construct = 'construct',
  Policy = 'policy',
  Command = 'command',
  Path = 'path',
  Preset = 'preset',
  Pipeline = 'pipeline',
}

export interface IRankerExplainRequest {
  /** Target id to explain. Required. */
  id: string;
  /** Either a task or a query — at least one. */
  task?: string;
  query?: string;
  /** Optional kind hint. */
  kind?: RankerExplainKind;
}

export interface IRankerOutrankedBy {
  id: string;
  kind: string;
  score: number;
  /** First few reasons surfaced by the ranker. */
  reasons: readonly string[];
}

export interface IRankerExplainNearestId {
  id: string;
  kind: string;
  /** Edit-distance / similarity. Lower is closer. */
  distance: number;
}

export interface IRankerExplainSignal {
  signal: string;
  matched: boolean;
  detail?: string;
}

export interface IRankerExplainTuningTrace {
  tuningId: string;
  reasons: readonly string[];
  delta: number;
}

export interface IRankerExplainReport {
  schema: typeof RANKER_EXPLAINABILITY_SCHEMA;
  generatedAt: string;
  request: IRankerExplainRequest;
  /** Whether the id was found in any registry. */
  found: boolean;
  /** Detected registry/kind when found. */
  resolvedKind?: string;
  /** Whether the entry was included in the rendered top-N when ranking for the given task. */
  included: boolean;
  /** Position in the top-N (1-based) when included; undefined otherwise. */
  rank?: number;
  /** Final score (post-tuning where applicable). */
  score?: number;
  /** Threshold the entry would have to clear to make the top-N for this task. */
  threshold?: number;
  /** Signals that matched (e.g. token hits, domain tags, appliesWhen, …). */
  matchedSignals: readonly IRankerExplainSignal[];
  /** Signals that did NOT match (i.e. what the entry is missing to rank higher). */
  missingSignals: readonly IRankerExplainSignal[];
  /** Items that outranked the target for this task. */
  outrankedBy: readonly IRankerOutrankedBy[];
  /** Tuning trace (which tuning entries touched this id and by how much). */
  tuningTrace: readonly IRankerExplainTuningTrace[];
  /** Suggested metadata fixes — concrete editorial guidance. */
  suggestedMetadataFixes: readonly string[];
  /** Suggested follow-up commands. */
  suggestedCommands: readonly string[];
  /** Nearest ids (used when the target id is missing entirely). */
  nearestIds: readonly IRankerExplainNearestId[];
  /** Free-form diagnostics. */
  diagnostics: readonly string[];
}

interface IRegistryHit {
  id: string;
  kind: string;
  title: string;
  source: string;
  tags?: readonly string[];
  appliesWhen?: readonly string[];
}

function sourceLabel(s: { origin?: string; loader?: string } | undefined): string {
  if (!s) return 'local';
  if (s.loader) return s.loader;
  if (s.origin) return s.origin;
  return 'local';
}

function listRegistryHits(inspection: ISharkcraftInspection): IRegistryHit[] {
  const out: IRegistryHit[] = [];
  for (const r of inspection.ruleService.list()) {
    out.push({
      id: r.id,
      kind: 'rule',
      title: r.title ?? r.id,
      source: sourceLabel(r.source),
      ...(r.tags ? { tags: r.tags } : {}),
      ...(r.appliesWhen ? { appliesWhen: r.appliesWhen } : {}),
    });
  }
  for (const p of inspection.pathService.list()) {
    out.push({
      id: p.id,
      kind: 'path',
      title: p.title ?? p.id,
      source: sourceLabel(p.source),
      ...(p.tags ? { tags: p.tags } : {}),
      ...(p.appliesWhen ? { appliesWhen: p.appliesWhen } : {}),
    });
  }
  for (const t of inspection.templates) {
    out.push({
      id: t.id,
      kind: 'template',
      title: t.name ?? t.id,
      source: 'local',
      ...(t.tags ? { tags: t.tags } : {}),
      ...(t.appliesWhen ? { appliesWhen: t.appliesWhen } : {}),
    });
  }
  for (const k of inspection.knowledgeEntries) {
    if (!out.some((o) => o.id === k.id)) {
      out.push({
        id: k.id,
        kind: 'knowledge',
        title: k.title ?? k.id,
        source: sourceLabel(k.source),
        ...(k.tags ? { tags: k.tags } : {}),
        ...(k.appliesWhen ? { appliesWhen: k.appliesWhen } : {}),
      });
    }
  }
  for (const p of inspection.pipelines) {
    out.push({
      id: p.id,
      kind: 'pipeline',
      title: p.title ?? p.id,
      source: 'local',
      ...(p.tags ? { tags: p.tags } : {}),
    });
  }
  for (const p of inspection.presetRegistry.list()) {
    out.push({
      id: p.id,
      kind: 'preset',
      title: p.title ?? p.id,
      source: 'local',
      ...(p.tags ? { tags: p.tags } : {}),
    });
  }
  return out;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) dp[j] = j;
  for (let i = 1; i <= m; i += 1) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const tmp = dp[j]!;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + cost);
      prev = tmp;
    }
  }
  return dp[n]!;
}

function nearestIds(
  hits: readonly IRegistryHit[],
  target: string,
  limit = 5,
): IRankerExplainNearestId[] {
  return hits
    .map((h) => ({ id: h.id, kind: h.kind, distance: levenshtein(h.id, target) }))
    .filter((h) => h.distance <= Math.max(3, Math.floor(target.length * 0.4)))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

interface IRankerOutput {
  rules: readonly { id: string; score: number; reasons: readonly string[] }[];
  paths: readonly { id: string; score: number; reasons: readonly string[] }[];
  templates: readonly { id: string; score: number; reasons: readonly string[] }[];
  pipelines: readonly { id: string; score: number; reasons: readonly string[] }[];
  presets: readonly { id: string; score: number; reasons: readonly string[] }[];
}

function rankForTask(inspection: ISharkcraftInspection, task: string): IRankerOutput {
  const all = rankAll(inspection, task, 50);
  return {
    rules: all.rules.map((r) => ({ id: r.item.id, score: r.score, reasons: r.reasons })),
    paths: all.paths.map((r) => ({ id: r.item.id, score: r.score, reasons: r.reasons })),
    templates: all.templates.map((r) => ({ id: r.item.id, score: r.score, reasons: r.reasons })),
    pipelines: all.pipelines.map((r) => ({ id: r.item.id, score: r.score, reasons: r.reasons })),
    presets: all.presets.map((r) => ({ id: r.item.id, score: r.score, reasons: r.reasons })),
  };
}

function suggestedFixes(
  taskOrQuery: string,
  hit: IRegistryHit,
  matched: readonly IRankerExplainSignal[],
  missing: readonly IRankerExplainSignal[],
): string[] {
  const out: string[] = [];
  const lower = taskOrQuery.toLowerCase();
  const tokens = new Set(tokenize(taskOrQuery));
  const itemTags = new Set((hit.tags ?? []).map((t) => t.toLowerCase()));
  const itemAW = new Set((hit.appliesWhen ?? []).map((t) => t.toLowerCase()));
  if (missing.some((s) => s.signal === 'token-hits-title')) {
    out.push(
      `Mention one of these tokens in title/description so token hits score: ${[...tokens].slice(0, 5).join(', ')}`,
    );
  }
  if (missing.some((s) => s.signal === 'tags')) {
    const candidate = inferDomainTags(lower);
    if (candidate.length > 0) {
      out.push(
        `Add a tag matching the task domain: ${candidate.filter((t) => !itemTags.has(t)).join(', ')}`,
      );
    }
  }
  if (missing.some((s) => s.signal === 'appliesWhen')) {
    const candidate = inferDomainAppliesWhen(lower);
    if (candidate.length > 0) {
      out.push(
        `Declare an appliesWhen value matching task intent: ${candidate.filter((a) => !itemAW.has(a)).join(', ')}`,
      );
    }
  }
  if (matched.length === 0 && missing.length > 0) {
    out.push('No signals matched. Add tags/appliesWhen referencing the task domain, or include domain tokens in the title.');
  }
  return out;
}

/**
 * Generic domain-token inference. Project-specific tokens move to
 * pack-contributed search-tuning rather than hardcoded heuristics
 * in the engine.
 */
function inferDomainTags(taskLower: string): string[] {
  const out: string[] = [];
  if (/\brenderer\b/.test(taskLower)) out.push('renderer');
  if (/\b(angular|react)\b/.test(taskLower)) out.push(/\bangular\b/.test(taskLower) ? 'angular' : 'react');
  if (/\b(layout|drag|drop)\b/.test(taskLower)) out.push('layout');
  return Array.from(new Set(out));
}

function inferDomainAppliesWhen(taskLower: string): string[] {
  const out: string[] = [];
  if (/\b(create|add|new|generate|build)\b/.test(taskLower)) out.push('generate-code');
  if (/\b(rename|move)\b/.test(taskLower)) out.push('refactor');
  return Array.from(new Set(out));
}

function commonSuggestedCommands(found: boolean, hit: IRegistryHit | undefined): string[] {
  if (!found) {
    return [
      'shrk commands suggest "<partial id>"',
      'shrk find <text>',
      'shrk search <text> --explain',
    ];
  }
  const out: string[] = [];
  out.push(`shrk why-not ${hit?.id ?? '<id>'} --for-task "<task>"`);
  out.push('shrk search "<task>" --explain');
  out.push('shrk search tuning explain "<task>"');
  out.push('shrk coverage scaffolds --task "<task>"');
  return out;
}

function deriveMatchedAndMissing(
  hit: IRegistryHit | undefined,
  taskOrQuery: string,
): { matched: IRankerExplainSignal[]; missing: IRankerExplainSignal[] } {
  if (!hit) return { matched: [], missing: [] };
  const taskTokens = new Set(tokenize(taskOrQuery));
  const titleTokens = new Set(tokenize(hit.title));
  const idTokens = new Set(tokenize(hit.id));
  const tagSet = new Set((hit.tags ?? []).map((t) => t.toLowerCase()));
  const awSet = new Set((hit.appliesWhen ?? []).map((t) => t.toLowerCase()));
  const inferredTags = new Set(inferDomainTags(taskOrQuery.toLowerCase()));
  const inferredAW = new Set(inferDomainAppliesWhen(taskOrQuery.toLowerCase()));
  const titleHits: string[] = [];
  for (const t of taskTokens) if (titleTokens.has(t)) titleHits.push(t);
  const idHits: string[] = [];
  for (const t of taskTokens) if (idTokens.has(t)) idHits.push(t);
  const tagHits: string[] = [];
  for (const t of inferredTags) if (tagSet.has(t)) tagHits.push(t);
  const awHits: string[] = [];
  for (const a of inferredAW) if (awSet.has(a)) awHits.push(a);
  const matched: IRankerExplainSignal[] = [];
  const missing: IRankerExplainSignal[] = [];
  if (titleHits.length > 0) matched.push({ signal: 'token-hits-title', matched: true, detail: titleHits.join(', ') });
  else missing.push({ signal: 'token-hits-title', matched: false });
  if (idHits.length > 0) matched.push({ signal: 'id-tokens', matched: true, detail: idHits.join(', ') });
  else missing.push({ signal: 'id-tokens', matched: false });
  if (tagHits.length > 0) matched.push({ signal: 'tags', matched: true, detail: tagHits.join(', ') });
  else missing.push({ signal: 'tags', matched: false });
  if (awHits.length > 0) matched.push({ signal: 'appliesWhen', matched: true, detail: awHits.join(', ') });
  else missing.push({ signal: 'appliesWhen', matched: false });
  return { matched, missing };
}

function gatherTuningTrace(
  hit: IRegistryHit | undefined,
  tuning: readonly ISearchTuningEntry[],
  taskOrQuery: string,
): IRankerExplainTuningTrace[] {
  if (!hit) return [];
  const tokens = tokenize(taskOrQuery);
  const boost = tuningBoostFor(
    {
      id: hit.id,
      kind: hit.kind,
      ...(hit.tags ? { tags: hit.tags } : {}),
      source: hit.source,
    },
    tokens,
    tuning,
  );
  if (!boost.composition || boost.composition.length === 0) {
    if (boost.reasons.length === 0) return [];
    return [{ tuningId: '(combined)', reasons: boost.reasons, delta: boost.delta ?? 0 }];
  }
  const traces: IRankerExplainTuningTrace[] = [];
  for (const c of boost.composition) {
    for (const x of c.contributors) {
      traces.push({
        tuningId: x.tuningId,
        reasons: [`${c.key} ${x.value > 0 ? '+' : ''}${x.value}`],
        delta: x.value,
      });
    }
  }
  return traces;
}

export interface IExplainRankerOptions {
  /** If true, return why-not behaviour. */
  whyNot?: boolean;
  /** Top-N considered for ranking. Default 10. */
  topN?: number;
}

export function explainRankerDecision(
  inspection: ISharkcraftInspection,
  request: IRankerExplainRequest,
  options: IExplainRankerOptions = {},
): IRankerExplainReport {
  const topN = options.topN ?? 10;
  const hits = listRegistryHits(inspection);
  const id = request.id;
  const found = hits.find((h) => h.id === id);
  const taskOrQuery = request.task ?? request.query ?? '';
  const tuning = listSearchTuning(inspection);

  // Build search-based ranking for query mode (no task).
  let ranker: IRankerOutput | undefined;
  let documentSnapshot: ISearchDocument | undefined;
  let searchScore: number | undefined;
  let searchRank: number | undefined;
  let searchThreshold: number | undefined;
  if (request.task) {
    ranker = rankForTask(inspection, request.task);
  }
  if (request.query) {
    const index = buildSearchIndex(inspection);
    const result = searchIndex(index, { query: request.query, limit: Math.max(topN, 20), explain: true }, inspection);
    const targetHit = result.hits.find((h) => h.document.id === id);
    if (targetHit) {
      documentSnapshot = targetHit.document;
      searchScore = targetHit.score;
      searchRank = result.hits.indexOf(targetHit) + 1;
    }
    const tail = result.hits[Math.min(topN, result.hits.length) - 1];
    if (tail) searchThreshold = tail.score;
  }

  // For task ranking, find which kind contains the target.
  let rank: number | undefined;
  let score: number | undefined;
  let threshold: number | undefined;
  let kindContainer: keyof IRankerOutput | undefined;
  if (ranker) {
    for (const key of ['rules', 'paths', 'templates', 'pipelines', 'presets'] as const) {
      const arr = ranker[key];
      const idx = arr.findIndex((r) => r.id === id);
      if (idx >= 0) {
        rank = idx + 1;
        score = arr[idx]!.score;
        const tail = arr[Math.min(topN, arr.length) - 1];
        threshold = tail ? tail.score : 0;
        kindContainer = key;
        break;
      }
    }
  }

  const included = ranker ? !!(rank && rank <= topN) : !!(searchRank && searchRank <= topN);

  // Matched / missing signals derived from the task/query vs hit metadata.
  const sig = deriveMatchedAndMissing(found, taskOrQuery);

  // Items that outranked the target.
  const outranked: IRankerOutrankedBy[] = [];
  if (ranker && kindContainer) {
    const arr = ranker[kindContainer];
    const myIdx = arr.findIndex((r) => r.id === id);
    if (myIdx > 0) {
      for (const better of arr.slice(0, myIdx)) {
        outranked.push({ id: better.id, kind: kindContainer.slice(0, -1), score: better.score, reasons: better.reasons.slice(0, 3) });
      }
    }
  }
  if (!ranker && request.query && documentSnapshot && searchRank && searchRank > 1) {
    const index = buildSearchIndex(inspection);
    const r = searchIndex(index, { query: request.query, limit: Math.max(topN, 20), explain: true }, inspection);
    for (let i = 0; i < searchRank - 1; i += 1) {
      const h = r.hits[i];
      if (!h) break;
      outranked.push({ id: h.document.id, kind: String(h.document.kind), score: h.score, reasons: h.reasons.slice(0, 3) });
    }
  }

  const tuningTrace = gatherTuningTrace(found, tuning, taskOrQuery);

  const matchedSignals = sig.matched;
  const missingSignals = sig.missing;
  const suggestedMetadataFixes = found
    ? suggestedFixes(taskOrQuery, found, matchedSignals, missingSignals)
    : [];
  const suggestedCommands = commonSuggestedCommands(!!found, found);

  const diagnostics: string[] = [];
  if (!found) diagnostics.push(`id "${id}" was not found in any registry`);
  if (found && !taskOrQuery) diagnostics.push('no --for-task or --for-query provided — only structural info available');
  if (options.whyNot && included) diagnostics.push('why-not asked, but the id IS included for this task');
  if (!options.whyNot && !found) diagnostics.push('cannot include a missing id — see nearestIds[]');

  const report: IRankerExplainReport = {
    schema: RANKER_EXPLAINABILITY_SCHEMA,
    generatedAt: new Date().toISOString(),
    request,
    found: !!found,
    ...(found ? { resolvedKind: found.kind } : {}),
    included,
    ...(rank !== undefined ? { rank } : searchRank !== undefined ? { rank: searchRank } : {}),
    ...(score !== undefined ? { score } : searchScore !== undefined ? { score: searchScore } : {}),
    ...(threshold !== undefined ? { threshold } : searchThreshold !== undefined ? { threshold: searchThreshold } : {}),
    matchedSignals,
    missingSignals,
    outrankedBy: outranked.slice(0, 5),
    tuningTrace,
    suggestedMetadataFixes,
    suggestedCommands,
    nearestIds: found ? [] : nearestIds(hits, id),
    diagnostics,
  };
  return report;
}

// ── Rendering ───────────────────────────────────────────────────────────

export function renderRankerExplainText(report: IRankerExplainReport, whyNot: boolean): string {
  const lines: string[] = [];
  const heading = whyNot ? `=== shrk why-not ${report.request.id} ===` : `=== shrk why ${report.request.id} ===`;
  lines.push(heading);
  if (report.request.task) lines.push(`task: ${report.request.task}`);
  if (report.request.query) lines.push(`query: ${report.request.query}`);
  lines.push('');
  lines.push(`found:        ${report.found ? 'yes' : 'no'}`);
  if (report.resolvedKind) lines.push(`kind:         ${report.resolvedKind}`);
  lines.push(`included:     ${report.included ? 'yes' : 'no'}`);
  if (report.rank !== undefined) lines.push(`rank:         ${report.rank}`);
  if (report.score !== undefined) lines.push(`score:        ${report.score}`);
  if (report.threshold !== undefined) lines.push(`threshold:    ${report.threshold}`);
  lines.push('');
  if (report.matchedSignals.length > 0) {
    lines.push('Matched signals:');
    for (const s of report.matchedSignals) {
      lines.push(`  + ${s.signal}${s.detail ? `: ${s.detail}` : ''}`);
    }
  } else {
    lines.push('Matched signals: (none)');
  }
  if (report.missingSignals.length > 0) {
    lines.push('Missing signals:');
    for (const s of report.missingSignals) {
      lines.push(`  - ${s.signal}`);
    }
  }
  if (report.outrankedBy.length > 0) {
    lines.push('');
    lines.push('Outranked by:');
    for (const o of report.outrankedBy) {
      lines.push(`  [${o.score}] ${o.id} (${o.kind})  ${o.reasons.join('; ')}`);
    }
  }
  if (report.tuningTrace.length > 0) {
    lines.push('');
    lines.push('Search tuning trace:');
    for (const t of report.tuningTrace) {
      lines.push(`  · ${t.tuningId}  delta=${t.delta}  ${t.reasons.join('; ')}`);
    }
  }
  if (report.suggestedMetadataFixes.length > 0) {
    lines.push('');
    lines.push('Suggested metadata fixes:');
    for (const f of report.suggestedMetadataFixes) lines.push(`  • ${f}`);
  }
  if (report.suggestedCommands.length > 0) {
    lines.push('');
    lines.push('Next commands:');
    for (const c of report.suggestedCommands) lines.push(`  $ ${c}`);
  }
  if (report.nearestIds.length > 0) {
    lines.push('');
    lines.push('Nearest ids:');
    for (const n of report.nearestIds) lines.push(`  ~ ${n.id} (${n.kind})  distance=${n.distance}`);
  }
  if (report.diagnostics.length > 0) {
    lines.push('');
    lines.push('Diagnostics:');
    for (const d of report.diagnostics) lines.push(`  · ${d}`);
  }
  return lines.join('\n') + '\n';
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderRankerExplainMarkdown(report: IRankerExplainReport, whyNot: boolean): string {
  const lines: string[] = [];
  lines.push(`# ${whyNot ? 'shrk why-not' : 'shrk why'} \`${report.request.id}\``);
  if (report.request.task) lines.push(`Task: \`${report.request.task}\``);
  if (report.request.query) lines.push(`Query: \`${report.request.query}\``);
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('| --- | --- |');
  lines.push(`| found | ${report.found ? 'yes' : 'no'} |`);
  if (report.resolvedKind) lines.push(`| kind | ${report.resolvedKind} |`);
  lines.push(`| included | ${report.included ? 'yes' : 'no'} |`);
  if (report.rank !== undefined) lines.push(`| rank | ${report.rank} |`);
  if (report.score !== undefined) lines.push(`| score | ${report.score} |`);
  if (report.threshold !== undefined) lines.push(`| threshold | ${report.threshold} |`);
  lines.push('');
  if (report.matchedSignals.length > 0) {
    lines.push('## Matched signals');
    for (const s of report.matchedSignals) lines.push(`- ${s.signal}${s.detail ? `: ${s.detail}` : ''}`);
    lines.push('');
  }
  if (report.missingSignals.length > 0) {
    lines.push('## Missing signals');
    for (const s of report.missingSignals) lines.push(`- ${s.signal}`);
    lines.push('');
  }
  if (report.outrankedBy.length > 0) {
    lines.push('## Outranked by');
    for (const o of report.outrankedBy) {
      lines.push(`- \`${o.id}\` (${o.kind}) score=${o.score} — ${o.reasons.join('; ')}`);
    }
    lines.push('');
  }
  if (report.tuningTrace.length > 0) {
    lines.push('## Search tuning trace');
    for (const t of report.tuningTrace) {
      lines.push(`- \`${t.tuningId}\` delta=${t.delta} — ${t.reasons.join('; ')}`);
    }
    lines.push('');
  }
  if (report.suggestedMetadataFixes.length > 0) {
    lines.push('## Suggested metadata fixes');
    for (const f of report.suggestedMetadataFixes) lines.push(`- ${f}`);
    lines.push('');
  }
  if (report.suggestedCommands.length > 0) {
    lines.push('## Next commands');
    for (const c of report.suggestedCommands) lines.push(`- \`${c}\``);
    lines.push('');
  }
  if (report.nearestIds.length > 0) {
    lines.push('## Nearest ids');
    for (const n of report.nearestIds) lines.push(`- \`${n.id}\` (${n.kind}) distance=${n.distance}`);
    lines.push('');
  }
  if (report.diagnostics.length > 0) {
    lines.push('## Diagnostics');
    for (const d of report.diagnostics) lines.push(`- ${d}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function renderRankerExplainHtml(report: IRankerExplainReport, whyNot: boolean): string {
  const md = renderRankerExplainMarkdown(report, whyNot);
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<title>SharkCraft — ${whyNot ? 'why-not' : 'why'} ${escHtml(report.request.id)}</title>`,
    '<style>body{font:14px/1.5 -apple-system,sans-serif;max-width:880px;margin:24px auto;padding:0 16px}h1{font-size:20px;border-bottom:1px solid #d0d7de;padding-bottom:8px}h2{font-size:16px;margin-top:24px}code{background:#f6f8fa;padding:1px 4px;border-radius:4px;font-size:12px}table{border-collapse:collapse}th,td{border:1px solid #d0d7de;padding:4px 10px}</style></head><body>',
    '<pre>' + escHtml(md) + '</pre>',
    '</body></html>',
  ].join('\n');
}
