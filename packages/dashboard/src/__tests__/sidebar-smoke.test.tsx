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
  test('Sidebar renders the expected nav items', () => {
    const html = renderToString(<Sidebar />);
    for (const label of [
      'Overview',
      'Dev Sessions',
      'Quality',
      'Safety',
      'Architecture',
      'Knowledge Graph',
      'Packs',
      'Presets &amp; Pipelines',
      'Onboarding',
      'Reports',
      'Review &amp; CI',
      'Commands',
      'MCP',
    ]) {
      expect(html).toContain(label);
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
