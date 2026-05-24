import { createHash } from 'node:crypto';
import * as nodePath from 'node:path';
import * as ts from 'typescript';
import { EdgeKind, NodeKind, type IEdge, type INode } from '@shrkcrft/graph';
import type {
  IExtractInput,
  IExtractOutput,
  IFrameworkExtractor,
} from '../extractor-api/framework-extractor.ts';

export const SOLID_EXTRACTOR_SOURCE = 'solid-extractor@v1';

const SOLID_PRIMITIVE_RE = /^create[A-Z]/;

const FAST_FILTER_NEEDLES = [
  "from 'solid-js'",
  'from "solid-js"',
  'createSignal',
  'createEffect',
  'createMemo',
];

/**
 * Solid extractor.
 *
 * Detection (heuristic — no type info):
 *   - Top-level `function Component()` / `const Component = (...)` with a
 *     name starting with an uppercase letter and a body that produces
 *     JSX → component entity.
 *   - Uses of `createSignal`, `createEffect`, `createMemo`,
 *     `createStore`, etc. → primitive-usage entities, linked to the
 *     enclosing component via UsesHook edges.
 *
 * Same shape as the React extractor; lives separately because the
 * detection heuristics (Solid uses primitives instead of hooks) and
 * fast-filter needles differ.
 */
export const solidExtractor: IFrameworkExtractor = {
  framework: 'solid',
  label: 'Solid',
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

    const components: { id: string; name: string; node: ts.Node }[] = [];
    const primitivesUsed = new Set<string>();

    for (const stmt of sf.statements) visitTopLevel(stmt, input, components);

    const enclosingComponent = (n: ts.Node): string | undefined => {
      for (const c of components) if (isAncestor(c.node, n)) return c.id;
      return undefined;
    };

    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && SOLID_PRIMITIVE_RE.test(n.expression.text)) {
        const name = n.expression.text;
        primitivesUsed.add(name);
        const compId = enclosingComponent(n);
        if (compId) {
          const primId = `framework:solid:primitive-usage:${input.filePath}#${name}`;
          edges.push(edge(compId, primId, EdgeKind.UsesHook, { hook: name }));
        }
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(sf, visit);

    for (const c of components) {
      nodes.push({
        id: c.id,
        kind: NodeKind.FrameworkEntity,
        label: c.name,
        path: input.filePath,
        tags: ['solid', 'component'],
        data: { framework: 'solid', subtype: 'component', name: c.name },
      });
      edges.push(edge(input.fileNodeId, c.id, EdgeKind.FrameworkDeclares, { subtype: 'component' }));
    }
    for (const prim of primitivesUsed) {
      const id = `framework:solid:primitive-usage:${input.filePath}#${prim}`;
      nodes.push({
        id,
        kind: NodeKind.FrameworkEntity,
        label: prim,
        path: input.filePath,
        tags: ['solid', 'primitive-usage'],
        data: { framework: 'solid', subtype: 'primitive-usage', primitive: prim },
      });
      edges.push(edge(input.fileNodeId, id, EdgeKind.FrameworkDeclares, { subtype: 'primitive-usage' }));
    }
    return { nodes, edges };
  },
};

function visitTopLevel(
  stmt: ts.Node,
  input: IExtractInput,
  out: { id: string; name: string; node: ts.Node }[],
): void {
  if (ts.isVariableStatement(stmt)) {
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      const name = decl.name.text;
      if (!/^[A-Z]/.test(name)) continue;
      const init = decl.initializer;
      if (!init) continue;
      if (containsJsx(init)) {
        out.push({ id: `framework:solid:component:${input.filePath}#${name}`, name, node: init });
      }
    }
    return;
  }
  if (ts.isFunctionDeclaration(stmt) && stmt.name && /^[A-Z]/.test(stmt.name.text)) {
    if (containsJsx(stmt)) {
      out.push({ id: `framework:solid:component:${input.filePath}#${stmt.name.text}`, name: stmt.name.text, node: stmt });
    }
  }
}

function containsJsx(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function isAncestor(ancestor: ts.Node, descendant: ts.Node): boolean {
  let cur: ts.Node | undefined = descendant;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parent;
  }
  return false;
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
    source: SOLID_EXTRACTOR_SOURCE,
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
