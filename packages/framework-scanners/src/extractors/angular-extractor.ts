import { createHash } from 'node:crypto';
import * as nodePath from 'node:path';
import * as ts from 'typescript';
import { EdgeKind, NodeKind, type IEdge, type INode } from '@shrkcrft/graph';
import type {
  IExtractInput,
  IExtractOutput,
  IFrameworkExtractor,
} from '../extractor-api/framework-extractor.ts';

export const ANGULAR_EXTRACTOR_SOURCE = 'angular-extractor@v1';

const FAST_FILTER_NEEDLES = [
  "from '@angular/core'",
  'from "@angular/core"',
  '@Component',
  '@Directive',
  '@NgModule',
  '@Injectable',
  '@Pipe',
];

const DECORATOR_TO_SUBTYPE: Readonly<Record<string, string>> = {
  Component: 'component',
  Directive: 'directive',
  Pipe: 'pipe',
  Injectable: 'service',
  NgModule: 'module',
};

/**
 * Angular extractor.
 *
 * Detects classes carrying any of the @Component / @Directive / @Pipe /
 * @Injectable / @NgModule decorators. Emits one `FrameworkEntity` per
 * decorated class, with the subtype derived from the decorator name.
 *
 * Component-specific metadata (selector, standalone, templateUrl) is
 * lifted into `data` so the agent / dashboard can render it without a
 * second AST walk.
 *
 * Out of scope (Wave 7 follow-up): template parsing, DI graph between
 * services, route configurations. Each is its own pass.
 */
export const angularExtractor: IFrameworkExtractor = {
  framework: 'angular',
  label: 'Angular',
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
        for (const d of decorators) {
          const subtype = DECORATOR_TO_SUBTYPE[d.name];
          if (!subtype) continue;
          const extra = extractDecoratorMetadata(d, subtype);
          const entity = makeEntity(input, node.name.text, subtype, extra);
          nodes.push(entity);
          edges.push(edge(input.fileNodeId, entity.id, EdgeKind.FrameworkDeclares, { subtype }));
          // A class can only carry one Angular role decorator in
          // practice; if a future class somehow has two we'd over-count
          // but the IDs are deterministic so duplicates collapse.
          break;
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

function extractDecoratorMetadata(d: IDecoratorInfo, subtype: string): Readonly<Record<string, unknown>> {
  if (!d.callArguments || d.callArguments.length === 0) return {};
  const arg0 = d.callArguments[0];
  if (!arg0 || !ts.isObjectLiteralExpression(arg0)) return {};
  const out: Record<string, unknown> = {};
  for (const prop of arg0.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    if (!ts.isIdentifier(prop.name)) continue;
    const key = prop.name.text;
    const value = prop.initializer;
    // Lift the most useful string fields. Arrays of identifiers (e.g.
    // `imports: [CommonModule, MyOtherModule]`) become arrays of names.
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
      if (subtype === 'component' && (key === 'selector' || key === 'templateUrl' || key === 'styleUrl')) {
        out[key] = value.text;
      } else if (subtype === 'directive' && key === 'selector') {
        out[key] = value.text;
      } else if (subtype === 'pipe' && key === 'name') {
        out[key] = value.text;
      }
    } else if (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword) {
      if (key === 'standalone') out['standalone'] = value.kind === ts.SyntaxKind.TrueKeyword;
    } else if (ts.isArrayLiteralExpression(value)) {
      if (subtype === 'module' && (key === 'imports' || key === 'declarations' || key === 'providers' || key === 'exports')) {
        out[key] = arrayOfIdentifierNames(value);
      } else if (subtype === 'component' && key === 'imports') {
        out[key] = arrayOfIdentifierNames(value);
      }
    }
  }
  return out;
}

function arrayOfIdentifierNames(arr: ts.ArrayLiteralExpression): string[] {
  const out: string[] = [];
  for (const el of arr.elements) {
    if (ts.isIdentifier(el)) out.push(el.text);
  }
  return out;
}

function makeEntity(
  input: IExtractInput,
  className: string,
  subtype: string,
  extra: Readonly<Record<string, unknown>>,
): INode {
  return {
    id: `framework:angular:${subtype}:${input.filePath}#${className}`,
    kind: NodeKind.FrameworkEntity,
    label: className,
    path: input.filePath,
    tags: ['angular', subtype],
    data: { framework: 'angular', subtype, className, ...extra },
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
    source: ANGULAR_EXTRACTOR_SOURCE,
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
