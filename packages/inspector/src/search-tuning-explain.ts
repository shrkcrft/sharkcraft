import { buildSearchIndex, searchIndex, type ISearchOptions } from './search-index.ts';
import {
  listSearchTuning,
  listSearchTuningIssues,
  loadSearchTuning,
  tuningBoostFor,
  type ISearchTuningEntry,
} from './search-tuning-registry.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const SEARCH_TUNING_EXPLAIN_SCHEMA = 'sharkcraft.search-tuning-explain/v1';

export interface ISearchTuningExplainOptions {
  /** Limit how many top results to compare before/after. Default: 5. */
  topN?: number;
}

export interface IPerHitTuningExplain {
  docId: string;
  title: string;
  kind: string;
  baselineScore: number;
  tunedScore: number;
  delta: number;
  reasons: readonly string[];
  /** Per-key composition: contributors, merge strategy applied, combined value. */
  composition?: readonly {
    key: string;
    strategy: 'sum' | 'max';
    contributors: readonly { tuningId: string; value: number }[];
    combined: number;
  }[];
}

export interface ITuningMatch {
  tuningId: string;
  source: string;
  packageName?: string;
  matchedTags: readonly string[];
  matchedKinds: readonly string[];
  matchedIds: readonly string[];
  matchedSources: readonly string[];
  taskHints: readonly { whenTokens: readonly string[]; matched: boolean }[];
}

export interface ISearchTuningExplainReport {
  schema: typeof SEARCH_TUNING_EXPLAIN_SCHEMA;
  generatedAt: string;
  query: string;
  tokens: readonly string[];
  loadedTunings: readonly {
    id: string;
    source: string;
    packageName?: string;
    sourceFile?: string;
    mergeStrategy?: 'sum' | 'max';
  }[];
  matched: readonly ITuningMatch[];
  cappedBoosts: readonly { tuningId: string; key: string; original: number; clamped: number }[];
  topResults: readonly IPerHitTuningExplain[];
  warnings: readonly { code: string; message: string; tuningId?: string }[];
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,\.;:\/]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
}

function describeBoost(entry: ISearchTuningEntry, tokens: readonly string[]): ITuningMatch {
  const matchedTags = entry.boostTags ? Object.keys(entry.boostTags) : [];
  const matchedKinds: string[] = [];
  const matchedIds = entry.boostIds ? Object.keys(entry.boostIds) : [];
  const matchedSources = entry.boostSources ? Object.keys(entry.boostSources) : [];
  const taskHints: { whenTokens: readonly string[]; matched: boolean }[] = (entry.taskHints ?? []).map(
    (h) => ({
      whenTokens: h.whenTokens ?? [],
      matched:
        (h.whenTokens ?? []).length === 0 ||
        (h.whenTokens ?? []).every((t) => tokens.includes(t.toLowerCase())),
    }),
  );
  for (const h of entry.taskHints ?? []) {
    if (h.boostKinds) for (const k of Object.keys(h.boostKinds)) if (!matchedKinds.includes(k)) matchedKinds.push(k);
    if (h.boostIds) for (const id of Object.keys(h.boostIds)) if (!matchedIds.includes(id)) matchedIds.push(id);
    if (h.boostTags) for (const t of Object.keys(h.boostTags)) if (!matchedTags.includes(t)) matchedTags.push(t);
  }
  const out: ITuningMatch = {
    tuningId: entry.id,
    source: entry.source,
    matchedTags,
    matchedKinds,
    matchedIds,
    matchedSources,
    taskHints,
  };
  if (entry.packageName) out.packageName = entry.packageName;
  return out;
}

export async function explainSearchTuning(
  inspection: ISharkcraftInspection,
  query: string,
  options: ISearchTuningExplainOptions = {},
): Promise<ISearchTuningExplainReport> {
  await loadSearchTuning(inspection);
  const tuning = listSearchTuning(inspection);
  const issues = listSearchTuningIssues(inspection);
  const tokens = tokenize(query);
  const matched = tuning.map((t) => describeBoost(t, tokens));
  const cappedBoosts = issues
    .filter((i) => i.code === 'boost-clamped')
    .map((i) => {
      const parsed = /Boost for "([^"]+)" clamped to (\S+) \(was (\S+)\)/.exec(i.message);
      return {
        ...(i.tuningId ? { tuningId: i.tuningId } : { tuningId: '(unknown)' }),
        key: parsed?.[1] ?? '?',
        clamped: parsed ? Number(parsed[2]) : 0,
        original: parsed ? Number(parsed[3]) : 0,
      };
    });
  const index = buildSearchIndex(inspection);
  const opts: ISearchOptions = { query, limit: Math.max(5, options.topN ?? 5), explain: true };
  const baseline = searchIndex(index, { ...opts, tuning: [] });
  const tuned = searchIndex(index, opts, inspection);
  const tunedById = new Map(tuned.hits.map((h) => [h.document.id, h] as const));
  const topResults: IPerHitTuningExplain[] = [];
  const considered = baseline.hits.slice(0, options.topN ?? 5);
  for (const h of considered) {
    const t = tunedById.get(h.document.id);
    if (!t) continue;
    const boost = tuningBoostFor(
      {
        id: h.document.id,
        kind: h.document.kind,
        ...(h.document.tags ? { tags: h.document.tags } : {}),
        source: h.document.source,
      },
      tokens,
      tuning,
    );
    topResults.push({
      docId: h.document.id,
      title: h.document.title,
      kind: h.document.kind,
      baselineScore: h.score,
      tunedScore: t.score,
      delta: Number((t.score - h.score).toFixed(2)),
      reasons: boost.reasons,
      ...(boost.composition && boost.composition.length > 0 ? { composition: boost.composition } : {}),
    });
  }
  return {
    schema: SEARCH_TUNING_EXPLAIN_SCHEMA,
    generatedAt: new Date().toISOString(),
    query,
    tokens,
    loadedTunings: tuning.map((t) => ({
      id: t.id,
      source: t.source,
      ...(t.packageName ? { packageName: t.packageName } : {}),
      ...(t.sourceFile ? { sourceFile: t.sourceFile } : {}),
      ...(t.mergeStrategy ? { mergeStrategy: t.mergeStrategy } : {}),
    })),
    matched,
    cappedBoosts,
    topResults,
    warnings: issues
      .filter((i) => i.severity !== 'info')
      .map((i) => {
        const out: { code: string; message: string; tuningId?: string } = {
          code: i.code,
          message: i.message,
        };
        if (i.tuningId) out.tuningId = i.tuningId;
        return out;
      }),
  };
}

export function renderTuningExplainMarkdown(report: ISearchTuningExplainReport): string {
  const lines: string[] = [];
  lines.push(`# Search tuning explain`);
  lines.push('');
  lines.push(`Query: \`${report.query}\``);
  lines.push(`Tokens: ${report.tokens.map((t) => '`' + t + '`').join(', ') || '_none_'}`);
  lines.push('');
  lines.push(`## Loaded tunings (${report.loadedTunings.length})`);
  if (report.loadedTunings.length === 0) lines.push('_(none — no tuning files contributed)_');
  for (const t of report.loadedTunings) {
    const strategy = t.mergeStrategy ? ` · merge=${t.mergeStrategy}` : '';
    lines.push(
      `- \`${t.id}\` (${t.source}${t.packageName ? ' / ' + t.packageName : ''}${strategy})`,
    );
  }
  lines.push('');
  lines.push(`## Top result deltas`);
  if (report.topResults.length === 0) lines.push('_No matches in the top window._');
  lines.push('');
  if (report.topResults.length > 0) {
    lines.push('| Doc | Kind | Baseline | Tuned | Δ |');
    lines.push('| --- | --- | ---: | ---: | ---: |');
    for (const r of report.topResults) {
      lines.push(`| \`${r.docId}\` | ${r.kind} | ${r.baselineScore} | ${r.tunedScore} | ${r.delta} |`);
    }
    // Show composition for hits whose key got contributions from >1 tuning.
    const interesting = report.topResults
      .filter((r) => (r.composition ?? []).some((c) => c.contributors.length > 1));
    if (interesting.length > 0) {
      lines.push('');
      lines.push('### Composition');
      for (const r of interesting) {
        lines.push(`- \`${r.docId}\``);
        for (const c of r.composition ?? []) {
          if (c.contributors.length <= 1) continue;
          const parts = c.contributors.map((x) => `${x.tuningId} ${x.value > 0 ? '+' : ''}${x.value}`).join(', ');
          lines.push(
            `  - ${c.key} (strategy=${c.strategy}): [${parts}] → ${c.combined > 0 ? '+' : ''}${c.combined}`,
          );
        }
      }
    }
  }
  if (report.cappedBoosts.length > 0) {
    lines.push('');
    lines.push('## Capped boosts');
    for (const c of report.cappedBoosts) {
      lines.push(`- \`${c.tuningId}\` ${c.key}: ${c.original} → ${c.clamped}`);
    }
  }
  if (report.warnings.length > 0) {
    lines.push('');
    lines.push('## Warnings');
    for (const w of report.warnings) {
      lines.push(`- [${w.code}] ${w.message}${w.tuningId ? ` (${w.tuningId})` : ''}`);
    }
  }
  return lines.join('\n') + '\n';
}

export function renderTuningExplainHtml(report: ISearchTuningExplainReport): string {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines: string[] = [];
  lines.push('<!doctype html><html><head><meta charset="utf-8">');
  lines.push('<title>SharkCraft — search tuning explain</title>');
  lines.push(
    '<style>body{font:14px/1.5 -apple-system,sans-serif;max-width:900px;margin:24px auto;padding:0 16px}h1{font-size:20px;border-bottom:1px solid #d0d7de;padding-bottom:8px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d0d7de;padding:6px 10px}th{background:#f6f8fa}code{background:#f6f8fa;padding:1px 4px;border-radius:4px;font-size:12px}</style></head><body>',
  );
  lines.push(`<h1>Search tuning explain</h1>`);
  lines.push(`<p>Query: <code>${esc(report.query)}</code></p>`);
  lines.push(`<p>Tokens: ${report.tokens.map((t) => `<code>${esc(t)}</code>`).join(', ') || '<em>none</em>'}</p>`);
  lines.push(`<h2>Loaded tunings (${report.loadedTunings.length})</h2><ul>`);
  for (const t of report.loadedTunings) {
    lines.push(
      `<li><code>${esc(t.id)}</code> · ${esc(t.source)}${t.packageName ? ' / ' + esc(t.packageName) : ''}</li>`,
    );
  }
  if (report.loadedTunings.length === 0) lines.push('<li><em>(none)</em></li>');
  lines.push('</ul>');
  lines.push(`<h2>Top result deltas</h2>`);
  if (report.topResults.length === 0) lines.push('<p><em>No matches in the top window.</em></p>');
  else {
    lines.push('<table><thead><tr><th>Doc</th><th>Kind</th><th>Baseline</th><th>Tuned</th><th>Δ</th></tr></thead><tbody>');
    for (const r of report.topResults) {
      lines.push(
        `<tr><td><code>${esc(r.docId)}</code></td><td>${esc(r.kind)}</td><td>${r.baselineScore}</td><td>${r.tunedScore}</td><td>${r.delta}</td></tr>`,
      );
    }
    lines.push('</tbody></table>');
  }
  lines.push('</body></html>');
  return lines.join('\n') + '\n';
}
