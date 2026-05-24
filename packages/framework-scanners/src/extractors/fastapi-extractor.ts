import { createHash } from 'node:crypto';
import { EdgeKind, NodeKind, type IEdge, type INode } from '@shrkcrft/graph';
import type {
  IExtractInput,
  IExtractOutput,
  IFrameworkExtractor,
} from '../extractor-api/framework-extractor.ts';

export const FASTAPI_EXTRACTOR_SOURCE = 'fastapi-extractor@v1';

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'];

const FAST_FILTER_NEEDLES = [
  'from fastapi',
  'fastapi import',
  'FastAPI(',
  'APIRouter(',
];

/**
 * FastAPI extractor.
 *
 * Regex-only (Python is not parsed via the TS AST). Detection:
 *   - `<name> = FastAPI(...)` and `<name> = APIRouter(...)` → app /
 *     router entity.
 *   - `@<name>.<method>('<path>', ...)` → route entity, with the
 *     decorated function captured on the next non-blank, non-decorator
 *     line as the handler name.
 *
 * Out of scope (Python-only follow-ups):
 *   - Path-operation function parameters (Pydantic body / query / path).
 *   - Dependency injection (Depends()).
 *   - Nested router includes (include_router).
 */
export const fastapiExtractor: IFrameworkExtractor = {
  framework: 'fastapi',
  label: 'FastAPI',
  fileMatches({ path, content }) {
    if (!path.endsWith('.py')) return false;
    for (const needle of FAST_FILTER_NEEDLES) {
      if (content.includes(needle)) return true;
    }
    return false;
  },
  extract(input): IExtractOutput {
    const nodes: INode[] = [];
    const edges: IEdge[] = [];
    const appNames = new Map<string, INode>();

    const lines = input.content.split('\n');

    // First pass: find `<name> = FastAPI(` / `APIRouter(`.
    const appRe = /^([A-Za-z_]\w*)\s*=\s*(FastAPI|APIRouter)\s*\(/;
    for (let i = 0; i < lines.length; i += 1) {
      const m = appRe.exec(lines[i]!);
      if (!m) continue;
      const name = m[1]!;
      const kind = m[2] === 'FastAPI' ? 'app' : 'router';
      const node = makeAppEntity(input, name, kind);
      appNames.set(name, node);
      nodes.push(node);
      edges.push(edge(input.fileNodeId, node.id, EdgeKind.FrameworkDeclares, { subtype: kind }));
    }

    if (appNames.size === 0) return { nodes, edges };

    // Second pass: decorators on the line preceding a `def` / `async def`.
    const decoratorRe = /^@([A-Za-z_]\w*)\.([a-z]+)\s*\(\s*['"]([^'"]+)['"]/;
    const defRe = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
    for (let i = 0; i < lines.length; i += 1) {
      const dm = decoratorRe.exec(lines[i]!);
      if (!dm) continue;
      const appName = dm[1]!;
      const method = dm[2]!;
      const path = dm[3]!;
      if (!appNames.has(appName)) continue;
      if (!HTTP_METHODS.includes(method)) continue;
      // Find the handler def — scan forward through additional decorators.
      let handler = 'handler';
      for (let j = i + 1; j < lines.length; j += 1) {
        const line = lines[j]!;
        const trimmed = line.trimStart();
        if (trimmed.length === 0) continue;
        if (trimmed.startsWith('@')) continue; // stacked decorator
        const def = defRe.exec(trimmed);
        if (def) handler = def[1]!;
        break;
      }
      const app = appNames.get(appName)!;
      const route = makeRouteEntity(input, appName, handler, method.toUpperCase(), path);
      nodes.push(route);
      edges.push(edge(app.id, route.id, EdgeKind.HandlesRoute, {
        method: method.toUpperCase(),
        path,
        handler,
      }));
      edges.push(edge(input.fileNodeId, route.id, EdgeKind.FrameworkDeclares, { subtype: 'route' }));
    }

    return { nodes, edges };
  },
};

function makeAppEntity(input: IExtractInput, name: string, subtype: string): INode {
  return {
    id: `framework:fastapi:${subtype}:${input.filePath}#${name}`,
    kind: NodeKind.FrameworkEntity,
    label: name,
    path: input.filePath,
    tags: ['fastapi', subtype],
    data: { framework: 'fastapi', subtype, name },
  };
}

function makeRouteEntity(
  input: IExtractInput,
  appName: string,
  handler: string,
  method: string,
  path: string,
): INode {
  return {
    id: `framework:fastapi:route:${input.filePath}#${appName}.${handler}#${method}:${path}`,
    kind: NodeKind.FrameworkEntity,
    label: `${method} ${path}`,
    path: input.filePath,
    tags: ['fastapi', 'route'],
    data: {
      framework: 'fastapi',
      subtype: 'route',
      app: appName,
      handler,
      method,
      path,
    },
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
    source: FASTAPI_EXTRACTOR_SOURCE,
    ...(data ? { data } : {}),
  };
}
