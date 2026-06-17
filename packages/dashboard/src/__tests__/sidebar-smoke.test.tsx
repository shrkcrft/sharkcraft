import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';

// Minimal stubs so component code that touches window/location at import time
// runs cleanly under Bun's non-DOM environment.
(globalThis as { window?: { location: { hash: string; origin: string } } }).window = {
  location: { hash: '#/overview', origin: 'http://127.0.0.1:4567' },
};
(globalThis as { document?: object }).document = {};
(globalThis as { addEventListener?: (..._a: unknown[]) => void }).addEventListener = () => {};

import { Sidebar } from '../components/layout/Sidebar.tsx';
import { CommandBlock } from '../components/primitives/CommandBlock.tsx';

describe('dashboard smoke render', () => {
  test('Sidebar renders the curated nav items (alpha.8 trim)', () => {
    const html = renderToString(<Sidebar />);
    // The dashboard surfaces 10 pages: project state + dev sessions +
    // configuration + MCP. Onboarding / Reports / Review & CI / Commands
    // were removed in the alpha.8 trim — their backing CLI verbs still
    // work; the dashboard pages were tied to advanced workflows, not
    // "see project state".
    for (const label of [
      'Overview',
      'Statistics',
      'Architecture',
      'Knowledge Graph',
      'Quality',
      'Safety',
      'Dev Sessions',
      'Packs',
      'Presets &amp; Pipelines',
      'MCP',
      'Token Savings',
    ]) {
      expect(html).toContain(label);
    }
    // The new Knowledge explorer page is wired into the nav (distinct from
    // the existing "Knowledge Graph" item).
    expect(html).toContain('>Knowledge</button>');
    // Removed labels must NOT appear in the trimmed sidebar.
    for (const removed of ['Onboarding', 'Reports', 'Review &amp; CI', 'Commands']) {
      expect(html).not.toContain(removed);
    }
  });

  test('CommandBlock renders the command, purpose, and a Copy button', () => {
    const html = renderToString(
      <CommandBlock command="shrk quality --strict" purpose="Strict gates" safety="read-only" />,
    );
    expect(html).toContain('shrk quality --strict');
    expect(html).toContain('Strict gates');
    expect(html).toContain('Copy');
    expect(html).toContain('read-only');
  });
});
