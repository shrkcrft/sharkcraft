import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
} from 'react';
import {
  getKnowledge,
  getKnowledgeEntry,
  getKnowledgeGraph,
  getKnowledgeSimilar,
} from '../api/endpoints.ts';
import { useApi } from '../api/useApi.ts';
import { navigate, useRoute } from '../utils/routing.ts';
import { copyText } from '../utils/clipboard.ts';
import { PageHeader } from '../components/layout/PageHeader.tsx';
import { LoadingState } from '../components/primitives/LoadingState.tsx';
import { ErrorState } from '../components/primitives/ErrorState.tsx';
import { EmptyState } from '../components/primitives/EmptyState.tsx';
import { Card } from '../components/primitives/Card.tsx';
import { Badge } from '../components/primitives/Badge.tsx';
import { CommandBlock } from '../components/primitives/CommandBlock.tsx';
import { GraphSvg } from '../components/domain/GraphSvg.tsx';
import { KnowledgeAsk } from '../components/domain/KnowledgeAsk.tsx';
import { KnowledgeCommandPalette } from '../components/domain/KnowledgeCommandPalette.tsx';
import { MarkdownLite } from '../components/domain/MarkdownLite.tsx';
import { HighlightedText } from '../components/domain/HighlightedText.tsx';
import type {
  IDashboardKnowledgeDetail,
  IDashboardKnowledgeEntryResponse,
  IDashboardKnowledgeInsights,
  IDashboardKnowledgeSimilar,
  IDashboardKnowledgeSummary,
} from '../api/types.ts';

type Tab = 'browse' | 'graph' | 'ask';

function isTab(v: string | null): v is Tab {
  return v === 'browse' || v === 'graph' || v === 'ask';
}

function buildHash(tab: Tab, id: string | null): string {
  const params = new URLSearchParams();
  if (tab !== 'browse') params.set('tab', tab);
  if (id) params.set('id', id);
  const qs = params.toString();
  return `#/knowledge${qs ? `?${qs}` : ''}`;
}

/** Map a knowledge type to a GraphSvg-style colour for the kind dot. */
function kindColor(type: string): string {
  if (type === 'rule') return '#5aa9ff';
  if (type === 'path') return '#3fb950';
  if (type === 'template') return '#d29922';
  if (type === 'warning' || type === 'security') return '#f85149';
  if (type === 'architecture') return '#a371f7';
  return '#8a96a6';
}

function priorityKind(p: string): 'danger' | 'warning' | 'info' | 'default' {
  if (p === 'critical') return 'danger';
  if (p === 'high') return 'warning';
  if (p === 'medium') return 'info';
  return 'default';
}

function KindDot({ type }: { type: string }): JSX.Element {
  return <span className="kb-dot" style={{ background: kindColor(type) }} aria-hidden="true" />;
}

/** Make a non-button clickable element keyboard-operable (Enter / Space). */
function onActivate(handler: () => void): (e: KeyboardEvent<HTMLElement>) => void {
  return (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handler();
    }
  };
}

export function KnowledgePage(): JSX.Element {
  const listFetcher = useCallback((s: AbortSignal | undefined) => getKnowledge(s), []);
  const list = useApi(listFetcher);

  // The URL hash is the single source of truth for tab + selected entry, so
  // back/forward, pasted deep links, and reloads all "just work" and there is
  // no two-way sync to keep consistent. `useRoute()` re-renders on hashchange.
  const route = useRoute();
  const tab: Tab = isTab(route.params.tab ?? null) ? (route.params.tab as Tab) : 'browse';
  const selectedId = route.params.id || null;

  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [scopeFilter, setScopeFilter] = useState<string | null>(null);
  const [priorityFilter, setPriorityFilter] = useState<string | null>(null);
  const [onlyMissingHints, setOnlyMissingHints] = useState(false);
  const [detail, setDetail] = useState<IDashboardKnowledgeEntryResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [similar, setSimilar] = useState<readonly IDashboardKnowledgeSimilar[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Navigation is one-way: write the hash and let `route` re-derive state.
  const goTab = useCallback((t: Tab) => navigate(buildHash(t, selectedId)), [selectedId]);
  const openEntry = useCallback(
    (id: string, goBrowse = false) => {
      setPaletteOpen(false);
      navigate(buildHash(goBrowse ? 'browse' : tab, id));
    },
    [tab],
  );

  // ⌘K / Ctrl-K toggles the command palette.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Load the selected entry's detail + similar whenever the URL's id changes.
  // Keyed on `selectedId` only, so unrelated re-renders (filters, tab, palette)
  // never refetch, and a newer selection cancels an in-flight one.
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setSimilar([]);
      setDetailLoading(false);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setSimilar([]);
    void Promise.all([
      getKnowledgeEntry(selectedId),
      getKnowledgeSimilar(selectedId).catch(() => null),
    ])
      .then(([d, s]) => {
        if (cancelled) return;
        setDetail(d.data);
        setSimilar(s?.data.similar ?? []);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const entries = useMemo(() => list.data?.entries ?? [], [list.data]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (typeFilter && e.type !== typeFilter) return false;
      if (scopeFilter && !e.scope.includes(scopeFilter)) return false;
      if (priorityFilter && e.priority !== priorityFilter) return false;
      if (onlyMissingHints && e.hasActionHints) return false;
      if (q) {
        const hay = `${e.id} ${e.title} ${e.summary ?? ''} ${e.tags.join(' ')} ${e.scope.join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [entries, query, typeFilter, scopeFilter, priorityFilter, onlyMissingHints]);

  if (list.loading && !list.data) return <LoadingState />;
  if (list.error) return <ErrorState error={list.error} onRetry={list.refetch} />;
  const data = list.data!;

  const tabs = (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      <button type="button" className="kb-kbd-btn" onClick={() => setPaletteOpen(true)} aria-label="Open command palette">
        <span aria-hidden="true">⌕</span> Jump <kbd>⌘K</kbd>
      </button>
      <div className="tabs" style={{ margin: 0, border: 'none' }}>
        {(['browse', 'graph', 'ask'] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={`tabs__tab${tab === t ? ' tabs__tab--active' : ''}`}
            onClick={() => goTab(t)}
          >
            {t === 'browse' ? 'Browse' : t === 'graph' ? 'Graph' : 'Ask AI'}
          </button>
        ))}
      </div>
    </div>
  );

  if (!data.available) {
    return (
      <>
        <PageHeader title="Knowledge" actions={tabs} />
        <EmptyState
          title="No knowledge entries yet"
          description="Knowledge entries are the durable, AI-ready facts about this project — rules, conventions, architecture notes, and more."
          command="shrk knowledge list --json"
          commandPurpose="Inspect knowledge loading"
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Knowledge"
        subtitle="Browse, search, visualize and ask your project's knowledge base."
        actions={tabs}
      />

      {tab === 'ask' ? (
        <KnowledgeAsk onSelectSource={(id) => openEntry(id, true)} />
      ) : null}

      {tab === 'browse' ? (
        <>
          <InsightsStrip
            insights={data.insights}
            total={data.total}
            activePriority={priorityFilter}
            onlyMissingHints={onlyMissingHints}
            onPriority={(p) => setPriorityFilter((c) => (c === p ? null : p))}
            onMissingHints={() => setOnlyMissingHints((v) => !v)}
          />

          <div className="kb-search">
            <span className="kb-search__icon" aria-hidden="true">⌕</span>
            <input
              className="kb-search__input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search knowledge by id, title, tag, scope…"
              aria-label="Search knowledge entries"
            />
            <span className="kb-search__count">
              {filtered.length} / {data.total}
            </span>
          </div>

          <FacetBar label="type" facets={data.facets.types} active={typeFilter} onToggle={(v) => setTypeFilter((c) => (c === v ? null : v))} />
          <FacetBar label="scope" facets={data.facets.scopes.slice(0, 16)} active={scopeFilter} onToggle={(v) => setScopeFilter((c) => (c === v ? null : v))} />

          <div className="grid" style={{ gridTemplateColumns: '2fr 3fr', marginTop: 14, alignItems: 'start' }}>
            <Card title={`Entries (${filtered.length})`}>
              {filtered.length === 0 ? (
                <div className="card__hint">No entries match the current filters.</div>
              ) : (
                <ul className="kb-list">
                  {filtered.map((e) => (
                    <EntryRow key={e.id} entry={e} active={selectedId === e.id} query={query} onClick={() => openEntry(e.id)} />
                  ))}
                </ul>
              )}
            </Card>
            <DetailPanel
              detail={detail}
              loading={detailLoading}
              selectedId={selectedId}
              similar={similar}
              onSelectRelated={(id) => openEntry(id)}
            />
          </div>
        </>
      ) : null}

      {tab === 'graph' ? (
        <div className="grid" style={{ gridTemplateColumns: '3fr 2fr', alignItems: 'start' }}>
          <KnowledgeGraphView selectedId={selectedId} onSelect={(id) => openEntry(id)} />
          <DetailPanel
            detail={detail}
            loading={detailLoading}
            selectedId={selectedId}
            similar={similar}
            onSelectRelated={(id) => openEntry(id)}
          />
        </div>
      ) : null}

      {paletteOpen ? (
        <KnowledgeCommandPalette
          entries={entries}
          onSelect={(id) => openEntry(id, true)}
          onGoTab={(t) => {
            setPaletteOpen(false);
            goTab(t);
          }}
          onClose={() => setPaletteOpen(false)}
        />
      ) : null}
    </>
  );
}

/* -------------------------------------------------------------------------- */

function InsightsStrip({
  insights,
  total,
  activePriority,
  onlyMissingHints,
  onPriority,
  onMissingHints,
}: {
  insights: IDashboardKnowledgeInsights;
  total: number;
  activePriority: string | null;
  onlyMissingHints: boolean;
  onPriority: (p: string) => void;
  onMissingHints: () => void;
}): JSX.Element {
  const order: Array<{ key: 'critical' | 'high' | 'medium' | 'low'; color: string }> = [
    { key: 'critical', color: '#f85149' },
    { key: 'high', color: '#d29922' },
    { key: 'medium', color: '#5aa9ff' },
    { key: 'low', color: '#8a96a6' },
  ];
  const max = Math.max(1, ...order.map((o) => insights.byPriority[o.key]));
  return (
    <div className="kb-insights">
      <div className="kb-insights__bars">
        <span className="kb-facets__label">priority</span>
        {order.map((o) => {
          const n = insights.byPriority[o.key];
          const active = activePriority === o.key;
          return (
            <button
              key={o.key}
              type="button"
              className={`kb-bar${active ? ' kb-bar--active' : ''}`}
              onClick={() => onPriority(o.key)}
              title={`${n} ${o.key} (click to filter)`}
            >
              <span className="kb-bar__track">
                <span className="kb-bar__fill" style={{ height: `${(n / max) * 100}%`, background: o.color }} />
              </span>
              <span className="kb-bar__label">{o.key}</span>
              <span className="kb-bar__count">{n}</span>
            </button>
          );
        })}
      </div>
      <div className="kb-insights__chips">
        <button
          type="button"
          className={`kb-chip kb-chip--clickable${onlyMissingHints ? ' kb-chip--active' : ''}`}
          onClick={onMissingHints}
          title="Entries with no action hints — agents have to guess the flow"
        >
          missing action hints <span className="kb-chip__count">{insights.withoutActionHints}</span>
        </button>
        <span className="kb-chip kb-chip--mini" title="Entries with no related links">
          orphans <span className="kb-chip__count">{insights.orphans}</span>
        </span>
        <span className="kb-chip kb-chip--mini" title="Entries with no summary">
          no summary <span className="kb-chip__count">{insights.withoutSummary}</span>
        </span>
        <span className="kb-chip kb-chip--mini">{total} total</span>
      </div>
    </div>
  );
}

function FacetBar({
  label,
  facets,
  active,
  onToggle,
}: {
  label: string;
  facets: readonly { value: string; count: number }[];
  active: string | null;
  onToggle: (value: string) => void;
}): JSX.Element | null {
  if (facets.length === 0) return null;
  return (
    <div className="kb-facets">
      <span className="kb-facets__label">{label}</span>
      <div className="kb-chips">
        {facets.map((f) => (
          <button
            key={f.value}
            type="button"
            className={`kb-chip kb-chip--clickable${active === f.value ? ' kb-chip--active' : ''}`}
            onClick={() => onToggle(f.value)}
          >
            {f.value}
            <span className="kb-chip__count">{f.count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function EntryRow({
  entry,
  active,
  query,
  onClick,
}: {
  entry: IDashboardKnowledgeSummary;
  active: boolean;
  query: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <li
      className={`kb-row${active ? ' kb-row--active' : ''}`}
      onClick={onClick}
      onKeyDown={onActivate(onClick)}
      role="button"
      tabIndex={0}
      aria-label={`Open ${entry.title}`}
    >
      <div className="kb-row__head">
        <KindDot type={entry.type} />
        <span className="kb-row__title"><HighlightedText text={entry.title} query={query} /></span>
        <Badge kind={priorityKind(entry.priority)}>{entry.priority}</Badge>
      </div>
      <div className="kb-row__id mono"><HighlightedText text={entry.id} query={query} /></div>
      {entry.summary ? <div className="kb-row__summary"><HighlightedText text={entry.summary} query={query} /></div> : null}
      <div className="kb-row__meta">
        <span className="badge badge--info">{entry.type}</span>
        {entry.hasActionHints ? <span className="badge badge--accent">action hints</span> : null}
        {entry.scope.slice(0, 3).map((s) => (
          <span key={s} className="kb-chip kb-chip--mini">{s}</span>
        ))}
      </div>
    </li>
  );
}

function ChipList({ items, mono }: { items: readonly string[]; mono?: boolean }): JSX.Element {
  return (
    <div className="kb-chips">
      {items.map((v) => (
        <span key={v} className={`kb-chip kb-chip--mini${mono ? ' mono' : ''}`}>{v}</span>
      ))}
    </div>
  );
}

function CopyContextButton({ entry }: { entry: IDashboardKnowledgeDetail }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const onCopy = async (): Promise<void> => {
    await copyText(buildAgentContext(entry)).catch(() => false);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button className={`btn${copied ? ' btn--copied' : ''}`} type="button" onClick={() => void onCopy()}>
      {copied ? 'Copied' : 'Copy as agent context'}
    </button>
  );
}

function buildAgentContext(e: IDashboardKnowledgeDetail): string {
  const lines: string[] = [`# ${e.title}`, '', `id: ${e.id}`, `type: ${e.type} · priority: ${e.priority}`];
  if (e.scope.length) lines.push(`scope: ${e.scope.join(', ')}`);
  if (e.tags.length) lines.push(`tags: ${e.tags.join(', ')}`);
  lines.push('', e.content.trim());
  const ah = e.actionHints;
  if (ah) {
    if (ah.commands.length) lines.push('', '## Commands', ...ah.commands.map((c) => `- ${c}`));
    if (ah.forbiddenActions.length) lines.push('', '## Forbidden', ...ah.forbiddenActions.map((c) => `- ${c}`));
    if (ah.verificationCommands.length) lines.push('', '## Verify', ...ah.verificationCommands.map((c) => `- ${c}`));
  }
  if (e.related.length) lines.push('', `related: ${e.related.join(', ')}`);
  return lines.join('\n');
}

function DetailPanel({
  detail,
  loading,
  selectedId,
  similar,
  onSelectRelated,
}: {
  detail: IDashboardKnowledgeEntryResponse | null;
  loading: boolean;
  selectedId: string | null;
  similar: readonly IDashboardKnowledgeSimilar[];
  onSelectRelated: (id: string) => void;
}): JSX.Element {
  if (!selectedId) {
    return (
      <Card title="Entry">
        <div className="card__hint">Select an entry (or press ⌘K) to read its full content, action hints, and connections.</div>
      </Card>
    );
  }
  if (loading && !detail) {
    return <Card title="Entry"><div className="card__hint">Loading…</div></Card>;
  }
  if (!detail || !detail.found || !detail.entry) {
    return <Card title="Entry"><div className="card__hint">Entry not found: {selectedId}</div></Card>;
  }
  const e = detail.entry;
  const ah = e.actionHints;
  return (
    <Card>
      <div className="kb-detail__head">
        <KindDot type={e.type} />
        <h3 className="kb-detail__title">{e.title}</h3>
        <Badge kind={priorityKind(e.priority)}>{e.priority}</Badge>
        <Badge kind="info">{e.type}</Badge>
      </div>
      <div className="kb-detail__id mono">{e.id}</div>
      {e.summary ? <p className="kb-detail__summary">{e.summary}</p> : null}

      <div className="kb-detail__meta">
        {e.scope.length > 0 ? <div><div className="kb-detail__label">scope</div><ChipList items={e.scope} /></div> : null}
        {e.tags.length > 0 ? <div><div className="kb-detail__label">tags</div><ChipList items={e.tags} /></div> : null}
        {e.appliesWhen.length > 0 ? <div><div className="kb-detail__label">applies when</div><ChipList items={e.appliesWhen} /></div> : null}
      </div>

      <div className="kb-detail__label" style={{ marginTop: 12 }}>content</div>
      <div className="kb-detail__content"><MarkdownLite text={e.content} /></div>

      {e.examples.length > 0 ? (
        <div className="kb-detail__examples">
          <div className="kb-detail__label" style={{ marginTop: 12 }}>examples</div>
          {e.examples.map((ex, i) => (
            <div className="kb-example" key={`ex-${i}`}>
              {ex.title ? <div className="kb-example__title">{ex.title}</div> : null}
              {ex.description ? <div className="kb-example__desc">{ex.description}</div> : null}
              {ex.code ? (
                <div className="kb-example__codewrap">
                  {ex.language ? <span className="kb-example__lang">{ex.language}</span> : null}
                  <pre className="kb-md__code">{ex.code}</pre>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {ah ? (
        <div className="kb-detail__hints">
          <div className="kb-detail__label">action hints</div>
          {ah.commands.length > 0 ? <HintRow title="commands" items={ah.commands} mono /> : null}
          {ah.mcpTools.length > 0 ? <HintRow title="mcp tools" items={ah.mcpTools} mono /> : null}
          {ah.preferredFlow.length > 0 ? <HintRow title="preferred flow" items={ah.preferredFlow} mono /> : null}
          {ah.forbiddenActions.length > 0 ? <HintRow title="forbidden" items={ah.forbiddenActions} danger /> : null}
          {ah.verificationCommands.length > 0 ? <HintRow title="verify" items={ah.verificationCommands} mono /> : null}
          {ah.relatedPathConventions.length > 0 ? <HintRow title="path conventions" items={ah.relatedPathConventions} mono /> : null}
          {ah.relatedTemplates.length > 0 ? <HintRow title="templates" items={ah.relatedTemplates} mono /> : null}
          {ah.writePolicy ? (
            <div className="kb-detail__hint-line">
              <span className="kb-detail__label">write policy</span> <Badge kind="warning">{ah.writePolicy}</Badge>
            </div>
          ) : null}
        </div>
      ) : null}

      {detail.related.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          <div className="kb-detail__label">related</div>
          <div className="kb-chips">
            {detail.related.map((r) => (
              <button key={r.id} type="button" className="kb-chip kb-chip--clickable mono" onClick={() => onSelectRelated(r.id)}>
                {r.id}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {similar.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          <div className="kb-detail__label">similar entries</div>
          <ul className="kb-edges">
            {similar.map((s) => (
              <li
                key={s.id}
                onClick={() => onSelectRelated(s.id)}
                onKeyDown={onActivate(() => onSelectRelated(s.id))}
                role="button"
                tabIndex={0}
              >
                <KindDot type={s.type} /> <span className="mono">{s.id}</span>{' '}
                <span className="card__hint">{s.reasons.join(' · ') || `score ${s.score}`}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {detail.inbound.length > 0 || detail.outbound.length > 0 ? (
        <div className="grid grid--2" style={{ marginTop: 12 }}>
          <div>
            <div className="kb-detail__label">inbound ({detail.inbound.length})</div>
            <ul className="kb-edges">
              {detail.inbound.slice(0, 12).map((n, i) => (
                <li
                  key={`${n.id}-${i}`}
                  onClick={() => onSelectRelated(n.id)}
                  onKeyDown={onActivate(() => onSelectRelated(n.id))}
                  role="button"
                  tabIndex={0}
                >
                  <span className="mono">{n.id}</span> <span className="card__hint">{n.relation}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="kb-detail__label">outbound ({detail.outbound.length})</div>
            <ul className="kb-edges">
              {detail.outbound.slice(0, 12).map((n, i) => (
                <li
                  key={`${n.id}-${i}`}
                  onClick={() => onSelectRelated(n.id)}
                  onKeyDown={onActivate(() => onSelectRelated(n.id))}
                  role="button"
                  tabIndex={0}
                >
                  <span className="mono">→ {n.id}</span> <span className="card__hint">{n.relation}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <div className="kb-detail__actions">
        <CommandBlock command={`shrk knowledge get ${e.id}`} purpose="Read this entry in the terminal" safety="read-only" />
        <CopyContextButton entry={e} />
      </div>
    </Card>
  );
}

function HintRow({
  title,
  items,
  mono,
  danger,
}: {
  title: string;
  items: readonly string[];
  mono?: boolean;
  danger?: boolean;
}): JSX.Element {
  return (
    <div className="kb-detail__hint-line">
      <span className="kb-detail__label">{title}</span>
      <div className="kb-chips">
        {items.map((v, i) => (
          <span key={`${v}-${i}`} className={`kb-chip kb-chip--mini${mono ? ' mono' : ''}${danger ? ' kb-chip--danger' : ''}`}>{v}</span>
        ))}
      </div>
    </div>
  );
}

function KnowledgeGraphView({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  const fetcher = useCallback((s: AbortSignal | undefined) => getKnowledgeGraph(s), []);
  const graph = useApi(fetcher);
  const [filter, setFilter] = useState('');
  const [focus, setFocus] = useState(false);
  // Defer the filter so the input stays responsive while the (heavier) layout
  // recompute lags a frame behind on large graphs.
  const deferredFilter = useDeferredValue(filter);

  const nodes = useMemo(() => {
    const all = graph.data?.nodes ?? [];
    const q = deferredFilter.trim().toLowerCase();
    let f = q ? all.filter((n) => `${n.id} ${n.label ?? ''}`.toLowerCase().includes(q)) : all;
    // Neighborhood focus: when a node is selected, optionally narrow to its ego-network.
    if (focus && selectedId && graph.data) {
      const keep = new Set<string>([selectedId]);
      for (const e of graph.data.edges) {
        if (e.from === selectedId) keep.add(e.to);
        if (e.to === selectedId) keep.add(e.from);
      }
      f = f.filter((n) => keep.has(n.id));
    }
    return f.slice(0, 120);
  }, [graph.data, deferredFilter, focus, selectedId]);
  const edges = useMemo(() => {
    if (!graph.data) return [];
    const ids = new Set(nodes.map((n) => n.id));
    return graph.data.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  }, [graph.data, nodes]);

  if (graph.loading && !graph.data) return <Card title="Graph"><LoadingState /></Card>;
  if (graph.error) return <Card title="Graph"><ErrorState error={graph.error} onRetry={graph.refetch} /></Card>;

  return (
    <Card>
      <div className="kb-graph__toolbar">
        <input
          className="kb-search__input"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter nodes…"
          aria-label="Filter graph nodes"
          style={{ flex: 1 }}
        />
        <button
          type="button"
          className={`kb-chip kb-chip--clickable${focus ? ' kb-chip--active' : ''}`}
          onClick={() => setFocus((v) => !v)}
          disabled={!selectedId}
          title={selectedId ? 'Show only the selected node and its neighbours' : 'Select a node first'}
        >
          focus
        </button>
        <span className="card__hint">{nodes.length} nodes · {edges.length} edges</span>
      </div>
      <GraphSvg nodes={nodes} edges={edges} selectedId={selectedId} onSelect={onSelect} />
      <div className="kb-graph__legend">
        <Legend color="#5aa9ff" label="rule" />
        <Legend color="#3fb950" label="path" />
        <Legend color="#d29922" label="template" />
        <Legend color="#8a96a6" label="knowledge" />
        <span className="card__hint">solid = related · faint = shared scope</span>
      </div>
      {graph.data?.truncated ? (
        <div className="card__hint" style={{ marginTop: 6 }}>Showing the top entries — graph truncated for legibility.</div>
      ) : null}
    </Card>
  );
}

function Legend({ color, label }: { color: string; label: string }): JSX.Element {
  return (
    <span className="kb-legend">
      <span className="kb-dot" style={{ background: color }} aria-hidden="true" />
      {label}
    </span>
  );
}
