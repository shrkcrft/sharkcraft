import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { GraphSvg } from '../components/domain/GraphSvg.tsx';

describe('GraphSvg', () => {
  test('renders nodes and edges as SVG when given data', () => {
    const html = renderToString(
      <GraphSvg
        nodes={[
          { id: 'rule:a', kind: 'rule', label: 'a' },
          { id: 'template:b', kind: 'template', label: 'b' },
        ]}
        edges={[{ from: 'rule:a', to: 'template:b', kind: 'related-template' }]}
      />,
    );
    expect(html).toContain('<svg');
    expect(html).toContain('<circle');
    expect(html).toContain('<line');
  });

  test('shows an empty state when there are no nodes', () => {
    const html = renderToString(<GraphSvg nodes={[]} edges={[]} />);
    expect(html).toContain('No graph nodes');
    expect(html).not.toContain('<svg');
  });
});
