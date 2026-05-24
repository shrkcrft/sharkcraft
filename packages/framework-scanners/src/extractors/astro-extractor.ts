import { createHash } from 'node:crypto';
import { EdgeKind, NodeKind, type IEdge, type INode } from '@shrkcrft/graph';
import type {
  IExtractInput,
  IExtractOutput,
  IFrameworkExtractor,
} from '../extractor-api/framework-extractor.ts';

export const ASTRO_EXTRACTOR_SOURCE = 'astro-extractor@v1';

const PAGE_RE = /(?:^|\/)src\/pages\/(.+?)\.astro$/;
const COMPONENT_RE = /\.astro$/;
const API_ROUTE_RE = /(?:^|\/)src\/pages\/(.+?)\.(?:ts|js)$/;

/**
 * Astro extractor.
 *
 * Astro uses file-based routing under `src/pages/`. Detection is
 * entirely path-based; the content is not parsed (Astro has its own
 * frontmatter / template DSL that's out of scope for the MVP).
 *
 *   - `src/pages/**\/*.astro` → page (with derived route path)
 *   - `**\/*.astro` outside pages/ → component
 *   - `src/pages/**\/*.{ts,js}` → API route (server-side endpoint)
 */
export const astroExtractor: IFrameworkExtractor = {
  framework: 'astro',
  label: 'Astro',
  fileMatches({ path }) {
    return path.endsWith('.astro') || API_ROUTE_RE.test(path);
  },
  extract(input): IExtractOutput {
    const nodes: INode[] = [];
    const edges: IEdge[] = [];

    const pageMatch = PAGE_RE.exec(input.filePath);
    if (pageMatch) {
      const route = astroRoute(pageMatch[1]!);
      const e = makeEntity(input, 'page', `page ${route}`, { kind: 'page', routePath: route });
      nodes.push(e);
      edges.push(edge(input.fileNodeId, e.id, EdgeKind.FrameworkDeclares, { subtype: 'page' }));
      return { nodes, edges };
    }

    const apiMatch = API_ROUTE_RE.exec(input.filePath);
    if (apiMatch) {
      const route = '/' + normalize(apiMatch[1]!);
      // Astro API routes export one binding per HTTP verb (`export const
      // GET = ...`, `export async function POST(...) { ... }`, etc.).
      // Detect each exported method and emit a per-method route entity.
      // If no method exports are found, fall back to a single
      // unspecified `api-route` entity so the file still surfaces.
      const methods = detectAstroApiMethods(input.content);
      if (methods.length === 0) {
        const e = makeEntity(input, 'api-route', `API ${route}`, { kind: 'api-route', routePath: route });
        nodes.push(e);
        edges.push(edge(input.fileNodeId, e.id, EdgeKind.FrameworkDeclares, { subtype: 'api-route' }));
      } else {
        for (const method of methods) {
          const e = makeEntity(input, 'api-route', `${method} ${route}`, {
            kind: 'api-route',
            routePath: route,
            method,
          });
          nodes.push(e);
          edges.push(edge(input.fileNodeId, e.id, EdgeKind.FrameworkDeclares, { subtype: 'api-route', method }));
        }
      }
      return { nodes, edges };
    }

    if (COMPONENT_RE.test(input.filePath)) {
      const filename = input.filePath.split('/').pop()!.replace(/\.astro$/, '');
      const e = makeEntity(input, 'component', filename, { kind: 'component', name: filename });
      nodes.push(e);
      edges.push(edge(input.fileNodeId, e.id, EdgeKind.FrameworkDeclares, { subtype: 'component' }));
    }
    return { nodes, edges };
  },
};

function astroRoute(p: string): string {
  return '/' + normalize(p);
}

function normalize(p: string): string {
  const parts = p.split('/').filter((s) => s.length > 0);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const seg = parts[i]!;
    if (i === parts.length - 1 && seg === 'index') continue;
    // Astro dynamic segments: `[id].astro` → `:id`, `[...slug].astro` → `*`.
    if (/^\[\.\.\..+\]$/.test(seg)) out.push('*');
    else if (/^\[.+\]$/.test(seg)) out.push(':' + seg.slice(1, -1));
    else out.push(seg);
  }
  return out.join('/');
}

function makeEntity(
  input: IExtractInput,
  subtype: string,
  label: string,
  data: Readonly<Record<string, unknown>>,
): INode {
  return {
    id: `framework:astro:${subtype}:${input.filePath}#${label}`,
    kind: NodeKind.FrameworkEntity,
    label,
    path: input.filePath,
    tags: ['astro', subtype],
    data: { framework: 'astro', subtype, ...data },
  };
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
    source: ASTRO_EXTRACTOR_SOURCE,
    ...(data ? { data } : {}),
  };
}

const ASTRO_API_METHOD_NAMES = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD', 'ALL'] as const;

/**
 * Detect which HTTP verbs an Astro API endpoint file exports. Matches:
 *   - `export const GET = ...`
 *   - `export let POST = ...`
 *   - `export async function PUT(...) { ... }`
 *   - `export function DELETE(...) { ... }`
 * Returns the unique set of detected verb names, in canonical order.
 */
function detectAstroApiMethods(content: string): readonly string[] {
  const found = new Set<string>();
  for (const m of ASTRO_API_METHOD_NAMES) {
    const re = new RegExp(`^\\s*export\\s+(?:const|let|var|(?:async\\s+)?function)\\s+${m}\\b`, 'm');
    if (re.test(content)) found.add(m);
  }
  return ASTRO_API_METHOD_NAMES.filter((m) => found.has(m));
}
