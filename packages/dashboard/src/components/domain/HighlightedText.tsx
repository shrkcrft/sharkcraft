import { Fragment, useMemo, type ReactNode } from 'react';

export interface IHighlightedTextProps {
  /** The full text to render. */
  text: string;
  /** Case-insensitive substring to highlight. Empty / whitespace = no highlight. */
  query: string;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Render `text`, wrapping every case-insensitive occurrence of `query` in a
 * <mark>. Pure React text nodes — never `dangerouslySetInnerHTML` — so it stays
 * XSS-safe even when the query (or text) contains HTML or regex metacharacters.
 * Returns the text untouched when the query is empty.
 */
export function HighlightedText({ text, query }: IHighlightedTextProps): JSX.Element {
  const parts = useMemo<ReactNode[]>(() => {
    const q = query.trim();
    if (!q) return [text];
    const re = new RegExp(`(${escapeRegExp(q)})`, 'ig');
    const lower = q.toLowerCase();
    return text.split(re).map((part, i) =>
      part && part.toLowerCase() === lower ? (
        <mark key={i} className="kb-hl">
          {part}
        </mark>
      ) : (
        <Fragment key={i}>{part}</Fragment>
      ),
    );
  }, [text, query]);
  return <>{parts}</>;
}
