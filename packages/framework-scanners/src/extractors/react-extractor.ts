import { createHash } from 'node:crypto';
import * as nodePath from 'node:path';
import * as ts from 'typescript';
import { EdgeKind, NodeKind, type IEdge, type INode } from '@shrkcrft/graph';
import type {
  IExtractInput,
  IExtractOutput,
  IFrameworkExtractor,
} from '../extractor-api/framework-extractor.ts';

export const REACT_EXTRACTOR_SOURCE = 'react-extractor@v1';

const HOOK_NAME_RE = /^use[A-Z]/;

const FAST_FILTER_NEEDLES = [
  "from 'react'",
  'from "react"',
  "from 'react/jsx-runtime'",
  'jsx',
  'React.FC',
  'createElement',
];

/**
 * React extractor.
 *
 * Heuristic detection (no full type information):
 *   - **Component**: top-level function / arrow function / class
 *     declaration whose name starts with an uppercase letter AND whose
 *     body contains a JSX element. False positives in TSX are filtered
 *     by the JSX-presence check.
 *   - **Hook usage**: any CallExpression whose callee identifier
 *     matches `/^use[A-Z]/`. Recorded as a single hook-usage entity
 *     per (file, hook name) pair.
 *
 * Emits FrameworkDeclares edges from file → entity, and UsesHook edges
 * from component → hook-usage entity when both can be co-located.
 */
export const reactExtractor: IFrameworkExtractor = {
  framework: 'react',
  label: 'React',
  fileMatches({ path, content }) {
    if (!/\.(?:t|j)sx?$/.test(path)) return false;
    // Cheap pre-filter: skip files that show no sign of React.
    const lower = content;
    for (const needle of FAST_FILTER_NEEDLES) {
      if (lower.includes(needle)) return true;
    }
    return false;
  },
  extract(input): IExtractOutput {
    const nodes: INode[] = [];
    const edges: IEdge[] = [];
    const sf = parse(input);
    if (!sf) return { nodes, edges };

    const components: { id: string; name: string; node: ts.Node }[] = [];
    const hookNames = new Set<string>();

    // First pass: identify components at the top level.
    for (const stmt of sf.statements) {
      visitTopLevel(stmt, input, components);
    }

    // Second pass: walk every node, collect hook usages, attribute them
    // to enclosing components when possible.
    const enclosingComponent = (n: ts.Node): string | undefined => {
      for (const c of components) {
        if (isAncestor(c.node, n)) return c.id;
      }
      return undefined;
    };
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && HOOK_NAME_RE.test(n.expression.text)) {
        const hookName = n.expression.text;
        hookNames.add(hookName);
        const compId = enclosingComponent(n);
        if (compId) {
          const hookId = `framework:react:hook-usage:${input.filePath}#${hookName}`;
          edges.push(edge(compId, hookId, EdgeKind.UsesHook, { hook: hookName }));
        }
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(sf, visit);

    for (const c of components) {
      const node: INode = {
        id: c.id,
        kind: NodeKind.FrameworkEntity,
        label: c.name,
        path: input.filePath,
        tags: ['react', 'component'],
        data: { framework: 'react', subtype: 'component', name: c.name },
      };
      nodes.push(node);
      edges.push(edge(input.fileNodeId, c.id, EdgeKind.FrameworkDeclares, { subtype: 'component' }));
    }
    for (const hook of hookNames) {
      const node: INode = {
        id: `framework:react:hook-usage:${input.filePath}#${hook}`,
        kind: NodeKind.FrameworkEntity,
        label: hook,
        path: input.filePath,
        tags: ['react', 'hook-usage'],
        data: { framework: 'react', subtype: 'hook-usage', hook },
      };
      nodes.push(node);
      edges.push(edge(input.fileNodeId, node.id, EdgeKind.FrameworkDeclares, { subtype: 'hook-usage' }));
    }
    return { nodes, edges };
  },
};

function visitTopLevel(
  stmt: ts.Node,
  input: IExtractInput,
  out: { id: string; name: string; node: ts.Node }[],
): void {
  // export const Foo = () => <div />;
  if (ts.isVariableStatement(stmt)) {
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      const name = decl.name.text;
      if (!/^[A-Z]/.test(name)) continue;
      const init = decl.initializer;
      if (!init) continue;
      if (containsJsx(init)) {
        out.push({ id: makeComponentId(input.filePath, name), name, node: init });
      }
    }
    return;
  }
  // function Foo() { return <div />; }
  if (ts.isFunctionDeclaration(stmt) && stmt.name && /^[A-Z]/.test(stmt.name.text)) {
    if (containsJsx(stmt)) {
      out.push({ id: makeComponentId(input.filePath, stmt.name.text), name: stmt.name.text, node: stmt });
    }
    return;
  }
  // export default function () { return <div />; }  (anonymous declaration)
  if (ts.isFunctionDeclaration(stmt) && !stmt.name && isExportDefault(stmt) && containsJsx(stmt)) {
    const name = defaultComponentName(input.filePath);
    out.push({ id: makeComponentId(input.filePath, name), name, node: stmt });
    return;
  }
  // export default function Foo() {} / export default () => <div />
  if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
    const expr = stmt.expression;
    if (ts.isFunctionExpression(expr)) {
      const name = expr.name?.text ?? defaultComponentName(input.filePath);
      if (/^[A-Z]/.test(name) && containsJsx(expr)) {
        out.push({ id: makeComponentId(input.filePath, name), name, node: expr });
      }
      return;
    }
    if (ts.isArrowFunction(expr) && containsJsx(expr)) {
      const name = defaultComponentName(input.filePath);
      out.push({ id: makeComponentId(input.filePath, name), name, node: expr });
      return;
    }
    return;
  }
  // class Foo extends React.Component { render() { return <div />; } }
  if (ts.isClassDeclaration(stmt) && stmt.name && /^[A-Z]/.test(stmt.name.text)) {
    if (extendsComponent(stmt) || containsJsx(stmt)) {
      out.push({ id: makeComponentId(input.filePath, stmt.name.text), name: stmt.name.text, node: stmt });
    }
    return;
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

function extendsComponent(cls: ts.ClassDeclaration): boolean {
  if (!cls.heritageClauses) return false;
  for (const h of cls.heritageClauses) {
    if (h.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    for (const t of h.types) {
      const text = t.expression.getText();
      if (text === 'Component' || text === 'React.Component' || text === 'PureComponent' || text === 'React.PureComponent') {
        return true;
      }
    }
  }
  return false;
}

function isAncestor(ancestor: ts.Node, descendant: ts.Node): boolean {
  let cur: ts.Node | undefined = descendant;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parent;
  }
  return false;
}

function makeComponentId(path: string, name: string): string {
  return `framework:react:component:${path}#${name}`;
}

/** True when a function declaration carries both `export` and `default`. */
function isExportDefault(node: ts.FunctionDeclaration): boolean {
  const mods = node.modifiers;
  if (!mods) return false;
  let hasExport = false;
  let hasDefault = false;
  for (const m of mods) {
    if (m.kind === ts.SyntaxKind.ExportKeyword) hasExport = true;
    else if (m.kind === ts.SyntaxKind.DefaultKeyword) hasDefault = true;
  }
  return hasExport && hasDefault;
}

/**
 * Deterministic PascalCase component name for a nameless default export,
 * derived from the file basename (`home-page.tsx` → `HomePage`). Falls
 * back to `Default` when the basename yields nothing usable.
 */
function defaultComponentName(filePath: string): string {
  const base = nodePath.basename(filePath).replace(/\.[^.]+$/, '');
  const pascal = base
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
  return /^[A-Za-z]/.test(pascal) ? pascal : 'Default';
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
    source: REACT_EXTRACTOR_SOURCE,
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
