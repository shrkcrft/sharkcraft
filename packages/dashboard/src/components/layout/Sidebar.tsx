import { useRoute, navigate } from '../../utils/routing.ts';

interface INavItem {
  hash: string;
  label: string;
  matchPrefix?: string;
}

const ITEMS: ReadonlyArray<INavItem | { group: string }> = [
  { group: 'At a glance' },
  { hash: '#/overview', label: 'Overview' },
  { group: 'Codebase' },
  { hash: '#/stats', label: 'Statistics' },
  { hash: '#/architecture', label: 'Architecture' },
  { hash: '#/graph', label: 'Knowledge Graph' },
  { group: 'Quality & Safety' },
  { hash: '#/quality', label: 'Quality' },
  { hash: '#/safety', label: 'Safety' },
  { hash: '#/review-ci', label: 'Review & CI' },
  { group: 'Work in flight' },
  { hash: '#/sessions', label: 'Dev Sessions', matchPrefix: '#/sessions' },
  { hash: '#/reports', label: 'Reports' },
  { hash: '#/commands', label: 'Commands' },
  { group: 'Configuration' },
  { hash: '#/packs', label: 'Packs' },
  { hash: '#/presets-pipelines', label: 'Presets & Pipelines' },
  { hash: '#/onboarding', label: 'Onboarding' },
  { group: 'System' },
  { hash: '#/mcp', label: 'MCP' },
];

export function Sidebar(): JSX.Element {
  const route = useRoute();
  return (
    <aside className="sidebar" data-testid="sidebar">
      <div className="sidebar__brand">
        <div style={{ width: 28, height: 28, borderRadius: 6, background: 'var(--accent-soft)', display: 'grid', placeItems: 'center', color: 'var(--accent)', fontWeight: 700 }}>
          ◆
        </div>
        <div>
          <div className="sidebar__brand-name">SharkCraft</div>
          <div className="sidebar__brand-sub">read-only local dashboard</div>
        </div>
      </div>
      <nav className="sidebar__nav">
        {ITEMS.map((it, i) => {
          if ('group' in it) {
            return (
              <div key={`g-${i}`} className="sidebar__group">
                {it.group}
              </div>
            );
          }
          const isActive = it.matchPrefix
            ? route.hash.startsWith(it.matchPrefix)
            : route.hash === it.hash || (route.hash === '' && it.hash === '#/overview');
          return (
            <button
              key={it.hash}
              className={`sidebar__item${isActive ? ' sidebar__item--active' : ''}`}
              onClick={() => navigate(it.hash)}
              type="button"
            >
              {it.label}
            </button>
          );
        })}
      </nav>
      <div className="sidebar__footer">
        SharkCraft is local-first. No data leaves your machine.
      </div>
    </aside>
  );
}
