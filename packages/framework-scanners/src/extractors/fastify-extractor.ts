import { createHash } from 'node:crypto';
import * as nodePath from 'node:path';
import * as ts from 'typescript';
import { EdgeKind, NodeKind, type IEdge, type INode } from '@shrkcrft/graph';
import type {
  IExtractInput,
  IExtractOutput,
  IFrameworkExtractor,
} from '../extractor-api/framework-extractor.ts';

export const FASTIFY_EXTRACTOR_SOURCE = 'fastify-extractor@v1';

const HTTP_METHOD_NAMES = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'all', 'route']);

const FAST_FILTER_NEEDLES = [
  "from 'fastify'",
  'from "fastify"',
  '@fastify/',
  'fastify(',
  'Fastify(',
];

/**
 * Fastify extractor.
 *
 * Detection model is similar to Express but for Fastify's API:
 *   - A variable initialized with `fastify(...)` or `Fastify(...)` becomes a
 *     **server** entity.
 *   - Subsequent `<server>.get('/path', ...)`, `.post`, etc. become **route**
 *     entities. `.route({ method, url })` is also recognised.
 */
export const fastifyExtractor: IFrameworkExtractor = {
  framework: 'fastify',
  label: 'Fastify',
  fileMatches({ path, content }) {
    if (!/\.(?:t|j)sx?$/.test(path)) return false;
    for (const needle of FAST_FILTER_NEEDLES) {
      if (content.includes(needle)) return true;
    }
    return false;
  },
  extract(input): IExtractOutput {
    const nodes: INode[] = [];
    const edges: IEdge[] = [];
    const sf = parse(input);
    if (!sf) return { nodes, edges };

    const serverNames = new Set<string>();
    const serverNodeByName = new Map<string, INode>();

    const findServers = (node: ts.Node): void => {
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) continue;
          const init = decl.initializer;
          if (!init) continue;
          if (isFastifyFactory(init)) {
            const name = decl.name.text;
            serverNames.add(name);
            const entity = makeServerEntity(input, name);
            serverNodeByName.set(name, entity);
            nodes.push(entity);
            edges.push(edge(input.fileNodeId, entity.id, EdgeKind.FrameworkDeclares, { subtype: 'server' }));
          }
        }
      }
      ts.forEachChild(node, findServers);
    };
    ts.forEachChild(sf, findServers);

    const findRoutes = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const objExpr = node.expression.expression;
        const method = node.expression.name.text;
        if (
          HTTP_METHOD_NAMES.has(method) &&
          ts.isIdentifier(objExpr) &&
          serverNames.has(objExpr.text)
        ) {
          const route = parseRouteCall(input, objExpr.text, method, node);
          if (route) {
            const serverEntity = serverNodeByName.get(objExpr.text)!;
            nodes.push(route);
            edges.push(edge(serverEntity.id, route.id, EdgeKind.HandlesRoute, {
              method: (route.data?.['method'] as string | undefined) ?? '?',
              path: (route.data?.['path'] as string | undefined) ?? '?',
            }));
            edges.push(edge(input.fileNodeId, route.id, EdgeKind.FrameworkDeclares, { subtype: 'route' }));
          }
        }
      }
      ts.forEachChild(node, findRoutes);
    };
    ts.forEachChild(sf, findRoutes);
    return { nodes, edges };
  },
};

function isFastifyFactory(node: ts.Expression): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) {
    return callee.text === 'fastify' || callee.text === 'Fastify';
  }
  return false;
}

function parseRouteCall(
  input: IExtractInput,
  serverName: string,
  method: string,
  call: ts.CallExpression,
): INode | undefined {
  const arg0 = call.arguments[0];
  if (!arg0) return undefined;
  if (method === 'route') {
    if (!ts.isObjectLiteralExpression(arg0)) return undefined;
    let m: string | undefined;
    let p: string | undefined;
    for (const prop of arg0.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
      const v = prop.initializer;
      if (prop.name.text === 'method' && ts.isStringLiteral(v)) m = v.text.toUpperCase();
      if ((prop.name.text === 'url' || prop.name.text === 'path') && ts.isStringLiteral(v)) p = v.text;
    }
    if (!m || !p) return undefined;
    return makeRouteEntity(input, serverName, m, p);
  }
  if (!ts.isStringLiteral(arg0)) return undefined;
  return makeRouteEntity(input, serverName, method.toUpperCase(), arg0.text);
}

function makeServerEntity(input: IExtractInput, name: string): INode {
  return {
    id: `framework:fastify:server:${input.filePath}#${name}`,
    kind: NodeKind.FrameworkEntity,
    label: name,
    path: input.filePath,
    tags: ['fastify', 'server'],
    data: { framework: 'fastify', subtype: 'server', name },
  };
}

function makeRouteEntity(
  input: IExtractInput,
  serverName: string,
  method: string,
  path: string,
): INode {
  return {
    id: `framework:fastify:route:${input.filePath}#${serverName}#${method}:${path}`,
    kind: NodeKind.FrameworkEntity,
    label: `${method} ${path}`,
    path: input.filePath,
    tags: ['fastify', 'route'],
    data: { framework: 'fastify', subtype: 'route', method, path, server: serverName },
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
    source: FASTIFY_EXTRACTOR_SOURCE,
    ...(data ? { data } : {}),
  };
}

function parse(input: IExtractInput): ts.SourceFile | undefined {
  const ext = nodePath.extname(input.filePath).toLowerCase();
  const kind =
    ext === '.tsx' ? ts.ScriptKind.TSX
    : ext === '.jsx' ? ts.ScriptKind.JSX
    : ext === '.js' || ext === '.mjs' || ext === '.cjs' ? ts.ScriptKind.JS
    : ts.ScriptKind.TS;
  try {
    return ts.createSourceFile(input.filePath, input.content, ts.ScriptTarget.Latest, true, kind);
  } catch {
    return undefined;
  }
}
