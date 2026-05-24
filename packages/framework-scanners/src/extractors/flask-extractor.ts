import { createHash } from 'node:crypto';
import { EdgeKind, NodeKind, type IEdge, type INode } from '@shrkcrft/graph';
import type {
  IExtractInput,
  IExtractOutput,
  IFrameworkExtractor,
} from '../extractor-api/framework-extractor.ts';

export const FLASK_EXTRACTOR_SOURCE = 'flask-extractor@v1';

const FAST_FILTER_NEEDLES = [
  'from flask',
  'Flask(__name__)',
  'Flask(name=',
  'Blueprint(',
  '@app.route',
  '@blueprint.route',
];

/**
 * Flask extractor.
 *
 * Regex-only. Detection model:
 *   - `<name> = Flask(...)` → **app** entity.
 *   - `<name> = Blueprint('<bp>', __name__, ...)` → **blueprint**
 *     entity. The first string argument is captured as the blueprint
 *     name.
 *   - `@<name>.route('<path>', methods=[...])` immediately preceding a
 *     `def <handler>` → **route** entity with method(s) + path +
 *     handler. The default method is GET when `methods=` is absent.
 */
export const flaskExtractor: IFrameworkExtractor = {
  framework: 'flask',
  label: 'Flask',
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

    const lines = input.content.split('\n');
    const appNames = new Map<string, INode>();

    const flaskRe = /^([A-Za-z_]\w*)\s*=\s*Flask\s*\(/;
    const bpRe = /^([A-Za-z_]\w*)\s*=\s*Blueprint\s*\(\s*['"]([^'"]+)['"]/;

    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i]!;
      let m = flaskRe.exec(raw);
      if (m) {
        const name = m[1]!;
        const e = makeEntity(input, 'app', name, { name });
        appNames.set(name, e);
        nodes.push(e);
        edges.push(edge(input.fileNodeId, e.id, EdgeKind.FrameworkDeclares, { subtype: 'app', line: i + 1 }));
        continue;
      }
      m = bpRe.exec(raw);
      if (m) {
        const localName = m[1]!;
        const bpName = m[2]!;
        const e = makeEntity(input, 'blueprint', bpName, { localName, name: bpName });
        appNames.set(localName, e);
        nodes.push(e);
        edges.push(edge(input.fileNodeId, e.id, EdgeKind.FrameworkDeclares, { subtype: 'blueprint', line: i + 1 }));
      }
    }

    if (appNames.size === 0) return { nodes, edges };

    // Routes: `@<appOrBlueprint>.route('<path>', methods=[...])` then a `def`.
    const routeRe = /^@([A-Za-z_]\w*)\.route\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*methods\s*=\s*\[([^\]]+)\])?/;
    const defRe = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
    for (let i = 0; i < lines.length; i += 1) {
      const m = routeRe.exec(lines[i]!);
      if (!m) continue;
      const target = m[1]!;
      const path = m[2]!;
      const methodsRaw = m[3];
      const methods = methodsRaw
        ? methodsRaw.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '').toUpperCase()).filter(Boolean)
        : ['GET'];
      if (!appNames.has(target)) continue;
      // Find handler name on a subsequent non-decorator line.
      let handler = 'handler';
      for (let j = i + 1; j < lines.length; j += 1) {
        const t = lines[j]!.trimStart();
        if (!t) continue;
        if (t.startsWith('@')) continue;
        const def = defRe.exec(t);
        if (def) handler = def[1]!;
        break;
      }
      // Emit one route entity per HTTP method (matches FastAPI's per-method shape).
      const app = appNames.get(target)!;
      for (const method of methods) {
        const e = makeRouteEntity(input, target, handler, method, path);
        nodes.push(e);
        edges.push(edge(app.id, e.id, EdgeKind.HandlesRoute, { method, path, handler }));
        edges.push(edge(input.fileNodeId, e.id, EdgeKind.FrameworkDeclares, { subtype: 'route', line: i + 1 }));
      }
    }
    return { nodes, edges };
  },
};

function makeEntity(
  input: IExtractInput,
  subtype: string,
  label: string,
  extra: Readonly<Record<string, unknown>>,
): INode {
  return {
    id: `framework:flask:${subtype}:${input.filePath}#${label}`,
    kind: NodeKind.FrameworkEntity,
    label,
    path: input.filePath,
    tags: ['flask', subtype],
    data: { framework: 'flask', subtype, ...extra },
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
    id: `framework:flask:route:${input.filePath}#${appName}.${handler}#${method}:${path}`,
    kind: NodeKind.FrameworkEntity,
    label: `${method} ${path}`,
    path: input.filePath,
    tags: ['flask', 'route'],
    data: {
      framework: 'flask',
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
    source: FLASK_EXTRACTOR_SOURCE,
    ...(data ? { data } : {}),
  };
}
