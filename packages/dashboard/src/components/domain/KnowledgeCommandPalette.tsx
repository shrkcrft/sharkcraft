import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { HighlightedText } from './HighlightedText.tsx';
import type { IDashboardKnowledgeSummary } from '../../api/types.ts';

export interface IKnowledgeCommandPaletteProps {
  entries: readonly IDashboardKnowledgeSummary[];
  onSelect: (id: string) => void;
  onGoTab: (tab: 'browse' | 'graph' | 'ask') => void;
  onClose: () => void;
}

interface IPaletteItem {
  id: string;
  label: string;
  sub?: string;
  badge?: string;
  run: () => void;
}

/**
 * ⌘K / Ctrl-K fuzzy command palette over knowledge entries + quick actions.
 * Mounted only while open; read-only navigation, no side effects beyond
 * selecting an entry or switching tabs.
 */
export function KnowledgeCommandPalette({
  entries,
  onSelect,
  onGoTab,
  onClose,
}: IKnowledgeCommandPaletteProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const items = useMemo<IPaletteItem[]>(() => {
    const q = query.trim().toLowerCase();
    const actions: IPaletteItem[] = [
      { id: '__browse', label: 'Go to Browse', badge: 'tab', run: () => onGoTab('browse') },
      { id: '__graph', label: 'Open Graph view', badge: 'tab', run: () => onGoTab('graph') },
      { id: '__ask', label: 'Ask the AI', badge: 'tab', run: () => onGoTab('ask') },
    ].filter((a) => !q || a.label.toLowerCase().includes(q));
    const matched: IPaletteItem[] = entries
      .filter((e) => !q || `${e.id} ${e.title} ${e.tags.join(' ')}`.toLowerCase().includes(q))
      .slice(0, 60)
      .map((e) => ({ id: e.id, label: e.title, sub: e.id, badge: e.type, run: () => onSelect(e.id) }));
    return [...actions, ...matched];
  }, [query, entries, onSelect, onGoTab]);

  const clampedActive = Math.min(active, Math.max(items.length - 1, 0));

  // Keep the keyboard-selected row in view when arrowing past the visible fold.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [clampedActive]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      items[clampedActive]?.run();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="kb-pal__backdrop" onClick={onClose} role="presentation">
      <div
        className="kb-pal"
        role="dialog"
        aria-label="Knowledge command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="kb-pal__input"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Jump to an entry or action…"
          aria-label="Search knowledge entries and actions"
        />
        <ul className="kb-pal__list">
          {items.length === 0 ? (
            <li className="kb-pal__empty">No matches</li>
          ) : (
            items.map((it, i) => (
              <li
                key={it.id}
                ref={i === clampedActive ? activeRef : undefined}
                className={`kb-pal__item${i === clampedActive ? ' kb-pal__item--active' : ''}`}
                // onMouseMove (not onMouseEnter) so a cursor merely resting over
                // the list while the user arrows with the keyboard doesn't keep
                // snatching `active` back to the hovered row.
                onMouseMove={() => setActive(i)}
                onClick={() => it.run()}
                role="button"
                tabIndex={-1}
              >
                <span className="kb-pal__label">
                  <HighlightedText text={it.label} query={query} />
                </span>
                {it.sub ? (
                  <span className="kb-pal__sub mono">
                    <HighlightedText text={it.sub} query={query} />
                  </span>
                ) : null}
                {it.badge ? <span className="kb-pal__badge">{it.badge}</span> : null}
              </li>
            ))
          )}
        </ul>
        <div className="kb-pal__foot">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
