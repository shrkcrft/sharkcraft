import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { askKnowledge } from '../../api/endpoints.ts';
import { DashboardApiError } from '../../api/client.ts';
import { copyText } from '../../utils/clipboard.ts';
import { Badge } from '../primitives/Badge.tsx';
import { MarkdownLite } from './MarkdownLite.tsx';
import type { IDashboardKnowledgeAskResponse } from '../../api/types.ts';

export interface IKnowledgeAskProps {
  /** Called when the user clicks one of the cited / source entries. */
  onSelectSource?: (id: string) => void;
  /** Optional starter question. */
  initialQuestion?: string;
}

/** Human-readable duration: `840 ms` under a second, `1.4s` / `12s` above. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

/**
 * AI block: ask a natural-language question over the knowledge base. The answer
 * is synthesized by the local LLM and grounded in retrieved entries; when no
 * LLM is reachable it degrades to the deterministic top matches. Read-only —
 * it calls the GET `/api/knowledge/ask` endpoint and never writes.
 */
export function KnowledgeAsk({ onSelectSource, initialQuestion }: IKnowledgeAskProps): JSX.Element {
  const [question, setQuestion] = useState(initialQuestion ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IDashboardKnowledgeAskResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Focus the question box when the Ask tab mounts so the user can type at once.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const ask = useCallback(async (): Promise<void> => {
    const q = question.trim();
    if (!q || loading) return;
    setLoading(true);
    setError(null);
    // Client-side deadline slightly beyond the server's 15s bound, so a stalled
    // network can never leave the button stuck on "Thinking…" forever.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 22_000);
    try {
      const res = await askKnowledge(q, ac.signal);
      setResult(res.data);
    } catch (e) {
      setError(
        ac.signal.aborted
          ? 'The request took too long and was cancelled. Try a shorter question or check the local LLM.'
          : e instanceof DashboardApiError
            ? e.message
            : String(e),
      );
      setResult(null);
    } finally {
      clearTimeout(timer);
      setLoading(false);
    }
  }, [question, loading]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Cmd/Ctrl+Enter submits.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void ask();
    }
  };

  const onCopyAnswer = useCallback(async (): Promise<void> => {
    if (!result?.answer) return;
    await copyText(result.answer).catch(() => false);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [result]);

  // Allocate the cited lookup once per result, not on every keystroke re-render.
  const cited = useMemo(() => new Set(result?.citedEntryIds ?? []), [result]);

  return (
    <div className="kb-ask">
      <div className="kb-ask__head">
        <div className="kb-ask__spark" aria-hidden="true">✦</div>
        <div>
          <div className="kb-ask__title">Ask the knowledge base</div>
          <div className="kb-ask__sub">
            Grounded in your entries, answered by your local LLM. Nothing leaves your machine.
          </div>
        </div>
      </div>

      <textarea
        ref={inputRef}
        className="kb-ask__input"
        aria-label="Ask a question about the knowledge base"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="e.g. How do I safely generate a new MCP tool? What are the apply safety rules?"
        rows={3}
      />
      <div className="kb-ask__actions">
        <span className="kb-ask__hint">⌘/Ctrl + Enter to ask</span>
        <button
          className="btn btn--primary"
          type="button"
          onClick={() => void ask()}
          disabled={loading || question.trim().length === 0}
        >
          {loading ? 'Thinking…' : 'Ask'}
        </button>
      </div>

      {error ? <div className="error" style={{ marginTop: 12 }}>{error}</div> : null}

      {result ? (
        <div className="kb-ask__result">
          {result.note ? (
            <div className={`kb-ask__note kb-ask__note--${result.degraded ? 'warn' : 'info'}`}>
              {result.note}
            </div>
          ) : null}

          {result.answer ? (
            <div className="kb-ask__answer-md">
              <MarkdownLite text={result.answer} />
            </div>
          ) : (
            <div className="card__hint" style={{ marginBottom: 10 }}>
              No synthesized answer — review the matching entries below.
            </div>
          )}

          {result.sources.length > 0 ? (
            <div className="kb-ask__sources">
              <div className="kb-ask__sources-title">
                {result.answer ? 'Sources' : 'Top matching entries'}
              </div>
              <div className="kb-chips">
                {result.sources.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`kb-chip kb-chip--clickable${cited.has(s.id) ? ' kb-chip--cited' : ''}`}
                    title={s.title}
                    onClick={() => onSelectSource?.(s.id)}
                  >
                    <span className="mono">{s.id}</span>
                    {cited.has(s.id) ? <span className="kb-chip__star">cited</span> : null}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="kb-ask__meta">
            {result.llmAvailable ? (
              <Badge kind="success">llm: {result.provider}</Badge>
            ) : (
              <Badge kind="warning">llm offline</Badge>
            )}
            <span className="card__hint">{formatDuration(result.durationMs)}</span>
            {result.answer ? (
              <button
                type="button"
                className={`btn btn--ghost kb-ask__copy${copied ? ' btn--copied' : ''}`}
                onClick={() => void onCopyAnswer()}
              >
                {copied ? 'Copied' : 'Copy answer'}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
