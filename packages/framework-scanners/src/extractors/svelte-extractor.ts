import { createHash } from 'node:crypto';
import { EdgeKind, NodeKind, type IEdge, type INode } from '@shrkcrft/graph';
import type {
  IExtractInput,
  IExtractOutput,
  IFrameworkExtractor,
} from '../extractor-api/framework-extractor.ts';

export const SVELTE_EXTRACTOR_SOURCE = 'svelte-extractor@v1';

const STORE_RE = /\$([A-Za-z_][A-Za-z0-9_]*)/g;
const SCRIPT_OPEN_RE = /<script\b[^>]*>/i;
const SCRIPT_CLOSE_RE = /<\/script>/i;
const RUNES_RE = /\$(state|derived|effect|props|bindable|inspect)\s*\(/g;

/**
 * Svelte extractor.
 *
 * Detection sources:
 *   1. `.svelte` files — always a component. Component name from filename.
 *   2. `.svelte.ts` / `.svelte.js` (Svelte 5 runes in module files) — emits a
 *      module-level entity.
 *
 * Lightweight metadata: store usages (`$store` syntax) and Svelte 5 runes
 * (`$state`, `$derived`, etc.) inside the `<script>` block.
 *
 * Out of scope: slot detection, action detection, transition detection.
 */
export const svelteExtractor: IFrameworkExtractor = {
  framework: 'svelte',
  label: 'Svelte',
  fileMatches({ path }) {
    return path.endsWith('.svelte') || path.endsWith('.svelte.ts') || path.endsWith('.svelte.js');
  },
  extract(input): IExtractOutput {
    const nodes: INode[] = [];
    const edges: IEdge[] = [];
    const filename = input.filePath.split('/').pop()!;
    const name = filename
      .replace(/\.svelte$/, '')
      .replace(/\.svelte\.(?:t|j)s$/, '');
    const isModule = filename.endsWith('.svelte.ts') || filename.endsWith('.svelte.js');
    const subtype = isModule ? 'module' : 'component';
    const script = isModule ? input.content : extractScriptBlock(input.content);
    const runes = collectRunes(script);
    const stores = collectStoreUsages(script);
    const entity: INode = {
      id: `framework:svelte:${subtype}:${input.filePath}#${name}`,
      kind: NodeKind.FrameworkEntity,
      label: name,
      path: input.filePath,
      tags: ['svelte', subtype],
      data: {
        framework: 'svelte',
        subtype,
        name,
        ...(runes.length > 0 ? { runes } : {}),
        ...(stores.length > 0 ? { stores } : {}),
      },
    };
    nodes.push(entity);
    edges.push(edge(input.fileNodeId, entity.id, EdgeKind.FrameworkDeclares, { subtype }));
    return { nodes, edges };
  },
};

function extractScriptBlock(content: string): string {
  const open = content.search(SCRIPT_OPEN_RE);
  if (open < 0) return '';
  const after = content.slice(open).indexOf('>');
  if (after < 0) return '';
  const start = open + after + 1;
  const closeIdx = content.slice(start).search(SCRIPT_CLOSE_RE);
  if (closeIdx < 0) return content.slice(start);
  return content.slice(start, start + closeIdx);
}

function collectRunes(script: string): readonly string[] {
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  RUNES_RE.lastIndex = 0;
  while ((m = RUNES_RE.exec(script)) !== null) found.add('$' + m[1]!);
  return [...found].sort();
}

function collectStoreUsages(script: string): readonly string[] {
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  STORE_RE.lastIndex = 0;
  while ((m = STORE_RE.exec(script)) !== null) {
    const name = m[1]!;
    // Filter Svelte 5 runes ($state, $derived, etc.) — those aren't stores.
    if (['state', 'derived', 'effect', 'props', 'bindable', 'inspect'].includes(name)) continue;
    // Filter common JS globals.
    if (name === 'this' || name === 'else') continue;
    found.add('$' + name);
  }
  return [...found].sort().slice(0, 20);
}

function edge(
  from: string,
  to: string,
  kind: EdgeKind,
  data?: Readonly<Record<string, unknown>>,
): IEdge {
  return {
    id: createHash('sha1').update(`${from}|${to}|${kind}`).digest('hex'),
    from,
    to,
    kind,
    source: SVELTE_EXTRACTOR_SOURCE,
    ...(data ? { data } : {}),
  };
}
