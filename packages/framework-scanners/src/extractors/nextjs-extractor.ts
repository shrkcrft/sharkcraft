import { createHash } from 'node:crypto';
import { EdgeKind, NodeKind, type IEdge, type INode } from '@shrkcrft/graph';
import type {
  IExtractInput,
  IExtractOutput,
  IFrameworkExtractor,
} from '../extractor-api/framework-extractor.ts';

export const NEXTJS_EXTRACTOR_SOURCE = 'nextjs-extractor@v1';

// Path-based detection only — Next.js entities are defined by file
// LOCATION more than by file content. We still emit content-derived
// metadata (e.g. exported HTTP method names for app-router route.ts).

const APP_ROUTER_RE = /(?:^|\/)app\/(?:.*\/)?(page|layout|route|loading|error|not-found|template|head)\.(?:tsx?|jsx?)$/;
const PAGES_ROUTER_RE = /(?:^|\/)pages\/(?!_app|_document|_error|api\/)(.+?)\.(?:tsx?|jsx?)$/;
const PAGES_API_RE = /(?:^|\/)pages\/api\/(.+?)\.(?:tsx?|jsx?)$/;

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

/**
 * Next.js extractor.
 *
 * Detects:
 *   - App-router files: `app/**\/page.tsx`, `layout.tsx`, `route.ts`,
 *     etc. The route path is derived from the file location, ignoring
 *     route groups `(...)` and parallel routes `@...`. `route.ts`
 *     additionally inspects the content for exported HTTP method names
 *     to emit per-method route entities.
 *   - Pages-router files: `pages/foo.tsx` → `/foo`, `pages/[id].tsx` →
 *     `/:id`. `pages/api/*.ts` becomes `api-route` entities.
 *
 * No content-shape detection — Next.js conventions are entirely
 * filesystem-based for routing.
 */
export const nextjsExtractor: IFrameworkExtractor = {
  framework: 'nextjs',
  label: 'Next.js',
  fileMatches({ path }) {
    return APP_ROUTER_RE.test(path) || PAGES_ROUTER_RE.test(path) || PAGES_API_RE.test(path);
  },
  extract(input): IExtractOutput {
    const nodes: INode[] = [];
    const edges: IEdge[] = [];

    const appMatch = APP_ROUTER_RE.exec(input.filePath);
    if (appMatch) {
      const role = appMatch[1]!;
      const routePath = appRouteFromPath(input.filePath);
      if (role === 'route') {
        // route.ts — one entity per exported HTTP method.
        const methods = detectExportedHttpMethods(input.content);
        if (methods.length === 0) {
          // Still emit a placeholder route entity so the file is
          // surfaced; consumers see the empty method list.
          const e = makeEntity(input, 'route', `route ${routePath}`, { kind: 'app-route', routePath, methods: [] });
          nodes.push(e);
          edges.push(edge(input.fileNodeId, e.id, EdgeKind.FrameworkDeclares, { subtype: 'route' }));
        } else {
          for (const method of methods) {
            const e = makeEntity(input, 'route', `${method} ${routePath}`, {
              kind: 'app-route',
              routePath,
              method,
            });
            nodes.push(e);
            edges.push(edge(input.fileNodeId, e.id, EdgeKind.FrameworkDeclares, { subtype: 'route' }));
          }
        }
      } else {
        const subtype = role; // 'page' | 'layout' | 'error' | …
        const e = makeEntity(input, subtype, `${subtype} ${routePath}`, {
          kind: `app-${subtype}`,
          routePath,
        });
        nodes.push(e);
        edges.push(edge(input.fileNodeId, e.id, EdgeKind.FrameworkDeclares, { subtype }));
      }
      return { nodes, edges };
    }

    const apiMatch = PAGES_API_RE.exec(input.filePath);
    if (apiMatch) {
      const routePath = '/api/' + normalizePagesPath(apiMatch[1]!);
      const e = makeEntity(input, 'api-route', `API ${routePath}`, {
        kind: 'pages-api',
        routePath,
      });
      nodes.push(e);
      edges.push(edge(input.fileNodeId, e.id, EdgeKind.FrameworkDeclares, { subtype: 'api-route' }));
      return { nodes, edges };
    }

    const pageMatch = PAGES_ROUTER_RE.exec(input.filePath);
    if (pageMatch) {
      const routePath = '/' + normalizePagesPath(pageMatch[1]!);
      const e = makeEntity(input, 'page', `page ${routePath}`, {
        kind: 'pages-route',
        routePath,
      });
      nodes.push(e);
      edges.push(edge(input.fileNodeId, e.id, EdgeKind.FrameworkDeclares, { subtype: 'page' }));
      return { nodes, edges };
    }

    return { nodes, edges };
  },
};

function appRouteFromPath(filePath: string): string {
  // Slice from the first `app/` segment onward, strip the filename,
  // and remove route groups + parallel route segments.
  const idx = filePath.indexOf('/app/');
  if (idx === -1) return '/';
  const tail = filePath.slice(idx + '/app'.length);
  const dirOnly = tail.replace(/\/[^/]+$/, '');
  const segments = dirOnly.split('/').filter((s) => s.length > 0);
  const out: string[] = [];
  for (const seg of segments) {
    // Route groups `(marketing)` are ignored.
    if (/^\(.+\)$/.test(seg)) continue;
    // Parallel routes `@modal` are ignored.
    if (seg.startsWith('@')) continue;
    // Dynamic segments `[id]` → `:id`, `[...slug]` → `*`, `[[...slug]]` → `*?`.
    if (/^\[\[\.\.\..+\]\]$/.test(seg)) out.push('*?');
    else if (/^\[\.\.\..+\]$/.test(seg)) out.push('*');
    else if (/^\[.+\]$/.test(seg)) out.push(':' + seg.slice(1, -1));
    else out.push(seg);
  }
  return out.length === 0 ? '/' : '/' + out.join('/');
}

function normalizePagesPath(p: string): string {
  // Strip trailing 'index'; map [id] → :id, etc. Same convention as
  // appRouteFromPath but for the pages-router filename pattern.
  const parts = p.split('/').filter((s) => s.length > 0);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const seg = parts[i]!;
    if (i === parts.length - 1 && seg === 'index') continue;
    if (/^\[\[\.\.\..+\]\]$/.test(seg)) out.push('*?');
    else if (/^\[\.\.\..+\]$/.test(seg)) out.push('*');
    else if (/^\[.+\]$/.test(seg)) out.push(':' + seg.slice(1, -1));
    else out.push(seg);
  }
  return out.join('/');
}

function detectExportedHttpMethods(content: string): readonly string[] {
  const found: string[] = [];
  for (const method of HTTP_METHODS) {
    // `export async function GET(...)`, `export function POST(`, `export const PUT = …`.
    const re = new RegExp(`export\\s+(?:async\\s+)?(?:function\\s+|const\\s+)${method}\\b`);
    if (re.test(content)) found.push(method);
  }
  return found;
}

function makeEntity(
  input: IExtractInput,
  subtype: string,
  label: string,
  data: Readonly<Record<string, unknown>>,
): INode {
  return {
    id: `framework:nextjs:${subtype}:${input.filePath}#${label}`,
    kind: NodeKind.FrameworkEntity,
    label,
    path: input.filePath,
    tags: ['nextjs', subtype],
    data: { framework: 'nextjs', subtype, ...data },
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
    source: NEXTJS_EXTRACTOR_SOURCE,
    ...(data ? { data } : {}),
  };
}
