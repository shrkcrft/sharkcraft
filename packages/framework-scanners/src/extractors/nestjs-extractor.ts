import { createHash } from 'node:crypto';
import * as nodePath from 'node:path';
import * as ts from 'typescript';
import { EdgeKind, NodeKind, type IEdge, type INode } from '@shrkcrft/graph';
import type {
  IExtractInput,
  IExtractOutput,
  IFrameworkExtractor,
} from '../extractor-api/framework-extractor.ts';

export const NESTJS_EXTRACTOR_SOURCE = 'nestjs-extractor@v1';

const HTTP_METHOD_DECORATORS = new Set([
  'Get',
  'Post',
  'Put',
  'Delete',
  'Patch',
  'Options',
  'Head',
  'All',
]);

const FAST_FILTER_NEEDLES = ['@Controller', '@Module', '@Injectable', "from '@nestjs/"];

/**
 * NestJS extractor.
 *
 * Emits FrameworkEntity nodes (controller / module / provider / route)
 * and connecting edges (FrameworkDeclares from file → entity;
 * HandlesRoute from controller → route).
 *
 * Class-level entities are detected by their decorator names; route
 * methods are detected by HTTP-method decorators on class members.
 * Constructor-injection edges are out of scope for the MVP — they're
 * encoded as a `data.injects` field on the consumer node instead, so
 * later rounds can promote them to edges without changing the
 * detection logic.
 */
export const nestjsExtractor: IFrameworkExtractor = {
  framework: 'nestjs',
  label: 'NestJS',
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

    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name) {
        const decorators = collectDecorators(node);
        if (decorators.length === 0) {
          ts.forEachChild(node, visit);
          return;
        }
        const ctrl = decorators.find((d) => d.name === 'Controller');
        const mod = decorators.find((d) => d.name === 'Module');
        const inj = decorators.find((d) => d.name === 'Injectable');
        if (ctrl) {
          const basePath = readFirstStringArg(ctrl.callArguments) ?? '';
          const entity = makeEntity(input, node, 'controller', { basePath });
          nodes.push(entity);
          edges.push(edge(input.fileNodeId, entity.id, EdgeKind.FrameworkDeclares, { subtype: 'controller' }));
          // Walk methods to find routes.
          for (const member of node.members) {
            if (!ts.isMethodDeclaration(member) || !member.name) continue;
            if (!ts.isIdentifier(member.name)) continue;
            const methodDecorators = collectDecorators(member);
            for (const d of methodDecorators) {
              if (!HTTP_METHOD_DECORATORS.has(d.name)) continue;
              const subPath = readFirstStringArg(d.callArguments) ?? '';
              const fullPath = joinRoute(basePath, subPath);
              const route = makeRouteEntity(input, node, member, {
                method: d.name.toUpperCase(),
                path: fullPath,
              });
              nodes.push(route);
              edges.push(edge(entity.id, route.id, EdgeKind.HandlesRoute, {
                method: d.name.toUpperCase(),
                path: fullPath,
              }));
              edges.push(edge(input.fileNodeId, route.id, EdgeKind.FrameworkDeclares, { subtype: 'route' }));
            }
          }
        } else if (mod) {
          const entity = makeEntity(input, node, 'module', {
            imports: readArrayProperty(mod.callArguments, 'imports'),
            providers: readArrayProperty(mod.callArguments, 'providers'),
            controllers: readArrayProperty(mod.callArguments, 'controllers'),
            exports: readArrayProperty(mod.callArguments, 'exports'),
          });
          nodes.push(entity);
          edges.push(edge(input.fileNodeId, entity.id, EdgeKind.FrameworkDeclares, { subtype: 'module' }));
        } else if (inj) {
          const entity = makeEntity(input, node, 'provider', {});
          nodes.push(entity);
          edges.push(edge(input.fileNodeId, entity.id, EdgeKind.FrameworkDeclares, { subtype: 'provider' }));
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
    return { nodes, edges };
  },
};

// ── helpers ─────────────────────────────────────────────────────────

interface IDecoratorInfo {
  name: string;
  callArguments?: ts.NodeArray<ts.Expression>;
}

function collectDecorators(node: ts.Node): readonly IDecoratorInfo[] {
  if (!ts.canHaveDecorators(node)) return [];
  const decorators = ts.getDecorators(node) ?? [];
  const out: IDecoratorInfo[] = [];
  for (const d of decorators) {
    const expr = d.expression;
    if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
      out.push({ name: expr.expression.text, callArguments: expr.arguments });
    } else if (ts.isIdentifier(expr)) {
      out.push({ name: expr.text });
    }
  }
  return out;
}

function readFirstStringArg(args: ts.NodeArray<ts.Expression> | undefined): string | undefined {
  if (!args || args.length === 0) return undefined;
  const a = args[0];
  if (a && ts.isStringLiteral(a)) return a.text;
  return undefined;
}

function readArrayProperty(
  args: ts.NodeArray<ts.Expression> | undefined,
  name: string,
): readonly string[] {
  if (!args || args.length === 0) return [];
  const a = args[0];
  if (!a || !ts.isObjectLiteralExpression(a)) return [];
  for (const prop of a.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    if (!ts.isIdentifier(prop.name) || prop.name.text !== name) continue;
    if (!ts.isArrayLiteralExpression(prop.initializer)) continue;
    const out: string[] = [];
    for (const el of prop.initializer.elements) {
      if (ts.isIdentifier(el)) out.push(el.text);
    }
    return out;
  }
  return [];
}

function joinRoute(base: string, sub: string): string {
  const b = base.replace(/\/+$/, '');
  const s = sub.replace(/^\/+/, '');
  if (!b && !s) return '/';
  if (!b) return '/' + s;
  if (!s) return '/' + b.replace(/^\/+/, '');
  return '/' + b.replace(/^\/+/, '') + '/' + s;
}

function makeEntity(
  input: IExtractInput,
  cls: ts.ClassDeclaration,
  subtype: string,
  extra: Readonly<Record<string, unknown>>,
): INode {
  const name = cls.name?.text ?? 'Anonymous';
  const id = `framework:nestjs:${subtype}:${input.filePath}#${name}`;
  return {
    id,
    kind: NodeKind.FrameworkEntity,
    label: name,
    path: input.filePath,
    tags: ['nestjs', subtype],
    data: { framework: 'nestjs', subtype, className: name, ...extra },
  };
}

function makeRouteEntity(
  input: IExtractInput,
  cls: ts.ClassDeclaration,
  member: ts.MethodDeclaration,
  data: { method: string; path: string },
): INode {
  const className = cls.name?.text ?? 'Anonymous';
  const methodName = (member.name && ts.isIdentifier(member.name)) ? member.name.text : 'handler';
  const id = `framework:nestjs:route:${input.filePath}#${className}.${methodName}#${data.method}:${data.path}`;
  return {
    id,
    kind: NodeKind.FrameworkEntity,
    label: `${data.method} ${data.path}`,
    path: input.filePath,
    tags: ['nestjs', 'route'],
    data: {
      framework: 'nestjs',
      subtype: 'route',
      className,
      handler: methodName,
      method: data.method,
      path: data.path,
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
    source: NESTJS_EXTRACTOR_SOURCE,
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
