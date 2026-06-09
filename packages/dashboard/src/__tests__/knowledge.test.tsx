import { afterEach, describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';

// Stub window for buildUrl (reads origin) before importing client code.
(globalThis as { window?: { location: { origin: string; hash: string } } }).window = {
  location: { origin: 'http://127.0.0.1:4567', hash: '#/knowledge' },
};

import { KnowledgeAsk } from '../components/domain/KnowledgeAsk.tsx';
import { MarkdownLite } from '../components/domain/MarkdownLite.tsx';
import { HighlightedText } from '../components/domain/HighlightedText.tsx';
import { KnowledgeCommandPalette } from '../components/domain/KnowledgeCommandPalette.tsx';
import { askKnowledge, getKnowledgeEntry, getKnowledgeSimilar } from '../api/endpoints.ts';
import type { IDashboardKnowledgeSummary } from '../api/types.ts';

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function envelope(data: unknown): Response {
  return new Response(
    JSON.stringify({
      schema: 'sharkcraft.dashboard-api/v1',
      generatedAt: 'now',
      projectRoot: '/p',
      data,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('KnowledgeAsk', () => {
  test('renders the AI ask UI without firing a request', () => {
    const html = renderToString(<KnowledgeAsk />);
    expect(html).toContain('Ask the knowledge base');
    expect(html).toContain('Ask');
  });
});

describe('knowledge endpoints', () => {
  test('askKnowledge hits /api/knowledge/ask with the q param and unwraps data', async () => {
    let calledUrl = '';
    globalThis.fetch = (async (url: unknown) => {
      calledUrl = String(url);
      return envelope({
        question: 'hi',
        llmAvailable: false,
        answer: null,
        degraded: true,
        sources: [],
        citedEntryIds: [],
        durationMs: 1,
      });
    }) as unknown as typeof fetch;
    const res = await askKnowledge('hi');
    expect(calledUrl).toContain('/api/knowledge/ask');
    expect(calledUrl).toContain('q=hi');
    expect(res.data.degraded).toBe(true);
  });

  test('getKnowledgeEntry encodes the id into the path', async () => {
    let calledUrl = '';
    globalThis.fetch = (async (url: unknown) => {
      calledUrl = String(url);
      return envelope({ found: false, inbound: [], outbound: [], related: [], commandHints: [] });
    }) as unknown as typeof fetch;
    await getKnowledgeEntry('repo.safety.mcp-is-read-only');
    expect(calledUrl).toContain('/api/knowledge/entry/repo.safety.mcp-is-read-only');
  });

  test('getKnowledgeSimilar hits the similar path', async () => {
    let calledUrl = '';
    globalThis.fetch = (async (url: unknown) => {
      calledUrl = String(url);
      return envelope({ id: 'r.x', available: false, similar: [] });
    }) as unknown as typeof fetch;
    await getKnowledgeSimilar('r.x');
    expect(calledUrl).toContain('/api/knowledge/similar/r.x');
  });
});

describe('MarkdownLite', () => {
  test('renders headings, lists, inline code and fenced code', () => {
    const html = renderToString(
      <MarkdownLite text={'# Title\n\n- one\n- two\n\nUse `shrk doctor` now.\n\n```\ncode block\n```'} />,
    );
    expect(html).toContain('Title');
    expect(html).toContain('<ul');
    expect(html).toContain('<code');
    expect(html).toContain('shrk doctor');
    expect(html).toContain('<pre');
    expect(html).toContain('code block');
    // No raw HTML injection vector.
    expect(html).not.toContain('dangerouslySetInnerHTML');
  });

  test('escapes HTML in content (no injection)', () => {
    const html = renderToString(<MarkdownLite text={'<script>alert(1)</script>'} />);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('renders safe links and neutralizes unsafe schemes', () => {
    const html = renderToString(
      <MarkdownLite text={'See [the docs](https://example.com/x) and [bad](javascript:alert(1)).'} />,
    );
    expect(html).toContain('href="https://example.com/x"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('the docs');
    // Unsafe scheme: the link text survives, but no javascript: href is emitted.
    expect(html).toContain('bad');
    expect(html).not.toContain('javascript:alert');
  });
});

describe('HighlightedText', () => {
  test('wraps case-insensitive matches in <mark>', () => {
    const html = renderToString(<HighlightedText text="Apply the RULE now" query="rule" />);
    expect(html).toContain('<mark');
    expect(html).toContain('RULE');
  });

  test('no <mark> when the query is empty/whitespace', () => {
    const html = renderToString(<HighlightedText text="Apply the rule" query="   " />);
    expect(html).not.toContain('<mark');
    expect(html).toContain('Apply the rule');
  });

  test('treats regex metacharacters literally (no catastrophic match)', () => {
    const html = renderToString(<HighlightedText text="a.b.c" query="." />);
    // Exactly the two literal dots — not every character, which an unescaped
    // "." regex would have highlighted.
    expect((html.match(/<mark/g) ?? []).length).toBe(2);
  });
});

describe('KnowledgeCommandPalette', () => {
  const entries: IDashboardKnowledgeSummary[] = [
    { id: 'r.alpha', title: 'Alpha rule', type: 'rule', priority: 'high', scope: ['s'], tags: ['t'], relatedCount: 0, hasActionHints: false, source: 'local' },
  ];
  test('renders entries and quick-action hints', () => {
    const html = renderToString(
      <KnowledgeCommandPalette entries={entries} onSelect={() => {}} onGoTab={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain('Alpha rule');
    expect(html).toContain('r.alpha');
    expect(html).toContain('Open Graph view');
    expect(html).toContain('navigate');
  });
});
