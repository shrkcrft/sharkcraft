/**
 * Lightweight, dependency-free graph visualization. Nodes are laid out on a
 * single ring; edges are drawn as straight lines colored by relation. Best
 * for ≤ ~80 visible nodes — call sites must filter before passing in.
 */
import { useMemo } from 'react';

export interface IGraphSvgNode {
  id: string;
  kind: string;
  label?: string;
}

export interface IGraphSvgEdge {
  from: string;
  to: string;
  kind: string;
}

export interface IGraphSvgProps {
  nodes: readonly IGraphSvgNode[];
  edges: readonly IGraphSvgEdge[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  width?: number;
  height?: number;
}

const KIND_COLOR: Record<string, string> = {
  rule: '#5aa9ff',
  path: '#3fb950',
  template: '#d29922',
  pipeline: '#a371f7',
  preset: '#f78166',
  pack: '#79c0ff',
  boundary: '#f85149',
  scaffold: '#56d364',
  knowledge: '#8a96a6',
  doc: '#6e7681',
};

function colorFor(kind: string): string {
  return KIND_COLOR[kind] ?? '#8a96a6';
}

export function GraphSvg({
  nodes,
  edges,
  selectedId,
  onSelect,
  width = 760,
  height = 520,
}: IGraphSvgProps): JSX.Element {
  const layout = useMemo(() => {
    const cx = width / 2;
    const cy = height / 2;
    const r = Math.min(width, height) / 2 - 40;
    const positions = new Map<string, { x: number; y: number }>();
    const n = Math.max(nodes.length, 1);
    nodes.forEach((node, i) => {
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
      positions.set(node.id, { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
    });
    return positions;
  }, [nodes, width, height]);

  // Build an adjacency set for fast highlighting of the selected node's edges.
  const adj = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const e of edges) {
      if (!map.has(e.from)) map.set(e.from, new Set());
      if (!map.has(e.to)) map.set(e.to, new Set());
      map.get(e.from)!.add(e.to);
      map.get(e.to)!.add(e.from);
    }
    return map;
  }, [edges]);

  const neighbors = selectedId ? adj.get(selectedId) ?? new Set<string>() : new Set<string>();

  if (nodes.length === 0) {
    return (
      <div className="empty">
        <div className="empty__title">No graph nodes</div>
        <div className="card__hint">Adjust filters or wait for inspection to load.</div>
      </div>
    );
  }

  return (
    <svg
      role="img"
      aria-label="Knowledge graph"
      viewBox={`0 0 ${width} ${height}`}
      style={{
        width: '100%',
        height,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        display: 'block',
      }}
      data-testid="graph-svg"
    >
      <g>
        {edges.map((e, i) => {
          const from = layout.get(e.from);
          const to = layout.get(e.to);
          if (!from || !to) return null;
          const isActive =
            !selectedId || e.from === selectedId || e.to === selectedId;
          return (
            <line
              key={`${e.from}-${e.to}-${i}`}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke="var(--border)"
              strokeOpacity={isActive ? 0.9 : 0.15}
              strokeWidth={isActive && selectedId ? 1.5 : 1}
            />
          );
        })}
      </g>
      <g>
        {nodes.map((n) => {
          const p = layout.get(n.id);
          if (!p) return null;
          const isSelected = selectedId === n.id;
          const isNeighbor = neighbors.has(n.id);
          const fill = colorFor(n.kind);
          const opacity = !selectedId || isSelected || isNeighbor ? 1 : 0.35;
          return (
            <g
              key={`${n.kind}:${n.id}`}
              transform={`translate(${p.x}, ${p.y})`}
              style={{ cursor: 'pointer' }}
              onClick={() => onSelect?.(n.id)}
            >
              <circle
                r={isSelected ? 8 : 5}
                fill={fill}
                stroke={isSelected ? 'var(--text)' : 'transparent'}
                strokeWidth={2}
                opacity={opacity}
              />
              {isSelected || isNeighbor ? (
                <text
                  y={-12}
                  textAnchor="middle"
                  fontFamily="var(--mono)"
                  fontSize={10}
                  fill="var(--text)"
                  opacity={opacity}
                  style={{ pointerEvents: 'none' }}
                >
                  {n.label ?? n.id}
                </text>
              ) : null}
            </g>
          );
        })}
      </g>
    </svg>
  );
}
