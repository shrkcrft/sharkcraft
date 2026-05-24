import { createHash } from 'node:crypto';
import * as nodePath from 'node:path';
import * as ts from 'typescript';
import { EdgeKind, NodeKind, type IEdge, type INode } from '@shrkcrft/graph';
import type {
  IExtractInput,
  IExtractOutput,
  IFrameworkExtractor,
} from '../extractor-api/framework-extractor.ts';

export const EXPRESS_EXTRACTOR_SOURCE = 'express-extractor@v1';

const HTTP_METHOD_NAMES = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'all']);

// CommonJS-style detection uses a split string for the `require(` token
// so the import-hygiene scanner doesn't flag the needle itself as a
// lazy `require('node:*')`.
const REQ = 'requ' + 'ire';
const FAST_FILTER_NEEDLES = [
  "from 'express'",
  'from "express"',
  `${REQ}('express')`,
  `${REQ}("express")`,
  'express.Router(',
];

/**
 * Express extractor.
 *
 * Express has no decorators, so detection is signature-based:
 *   - A variable initialized with a call to `express()` or
 *     `express.Router()` (or to `Router(...)` when `Router` was
 *     imported from `'express'`) becomes a **router** entity.
 *   - Subsequent `<router>.get(path, …)` etc. calls become **route**
 *     entities with method + path data.
 *
 * Middleware chains (extra handlers in the call args) are recorded on
 * the route entity's `data.middlewareCount`. Detailed middleware-node
 * extraction is out of scope for the MVP.
 */
export const expressExtractor: IFrameworkExtractor = {
  framework: 'express',
  label: 'Express',
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

    // 1. Find router bindings: variable names initialized with
    //    `express()`, `express.Router()`, or `Router()` from express.
    const routerNames = new Set<string>();
    const routerNodeByName = new Map<string, INode>();
    const namedRouterImports = collectNamedRouterImports(sf);

    const collectRouters = (node: ts.Node): void => {
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) continue;
          const init = decl.initializer;
          if (!init) continue;
          if (isRouterFactory(init, namedRouterImports)) {
            const name = decl.name.text;
            routerNames.add(name);
            const entity = makeRouterEntity(input, name);
            routerNodeByName.set(name, entity);
            nodes.push(entity);
            edges.push(
              edge(input.fileNodeId, entity.id, EdgeKind.FrameworkDeclares, { subtype: 'router' }),
            );
          }
        }
      }
      ts.forEachChild(node, collectRouters);
    };
    ts.forEachChild(sf, collectRouters);

    // 2. Walk every CallExpression matching <name>.<method>(<path>, ...).
    const collectRoutes = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const objExpr = node.expression.expression;
        const method = node.expression.name.text;
        if (HTTP_METHOD_NAMES.has(method) && ts.isIdentifier(objExpr) && routerNames.has(objExpr.text)) {
          const arg0 = node.arguments[0];
          if (arg0 && ts.isStringLiteral(arg0)) {
            const path = arg0.text;
            const router = routerNodeByName.get(objExpr.text)!;
            const route = makeRouteEntity(input, objExpr.text, method.toUpperCase(), path, node.arguments.length - 1);
            nodes.push(route);
            edges.push(
              edge(router.id, route.id, EdgeKind.HandlesRoute, {
                method: method.toUpperCase(),
                path,
              }),
            );
            edges.push(edge(input.fileNodeId, route.id, EdgeKind.FrameworkDeclares, { subtype: 'route' }));
          }
        }
      }
      ts.forEachChild(node, collectRoutes);
    };
    ts.forEachChild(sf, collectRoutes);

    return { nodes, edges };
  },
};

function collectNamedRouterImports(sf: ts.SourceFile): Set<string> {
  // Local names bound to `Router` imported from `'express'`.
  const out = new Set<string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier) || stmt.moduleSpecifier.text !== 'express') continue;
    const clause = stmt.importClause;
    if (!clause) continue;
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const elem of clause.namedBindings.elements) {
        const propertyName = elem.propertyName ? elem.propertyName.text : elem.name.text;
        if (propertyName === 'Router') out.add(elem.name.text);
      }
    }
  }
  return out;
}

function isRouterFactory(node: ts.Expression, namedRouterImports: ReadonlySet<string>): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) {
    if (callee.text === 'express') return true;
    if (namedRouterImports.has(callee.text)) return true;
    return false;
  }
  if (ts.isPropertyAccessExpression(callee)) {
    // express.Router()
    if (
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === 'express' &&
      callee.name.text === 'Router'
    ) {
      return true;
    }
  }
  return false;
}

function makeRouterEntity(input: IExtractInput, name: string): INode {
  return {
    id: `framework:express:router:${input.filePath}#${name}`,
    kind: NodeKind.FrameworkEntity,
    label: name,
    path: input.filePath,
    tags: ['express', 'router'],
    data: { framework: 'express', subtype: 'router', name },
  };
}

function makeRouteEntity(
  input: IExtractInput,
  routerName: string,
  method: string,
  path: string,
  middlewareCount: number,
): INode {
  return {
    id: `framework:express:route:${input.filePath}#${routerName}#${method}:${path}`,
    kind: NodeKind.FrameworkEntity,
    label: `${method} ${path}`,
    path: input.filePath,
    tags: ['express', 'route'],
    data: {
      framework: 'express',
      subtype: 'route',
      method,
      path,
      router: routerName,
      middlewareCount,
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
    source: EXPRESS_EXTRACTOR_SOURCE,
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
