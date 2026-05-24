import * as ts from 'typescript';
import type {
  ICallExpressionPattern,
  IClassDeclarationPattern,
  IDecoratorPattern,
  IIdentifierPattern,
  IImportDeclarationPattern,
  INewExpressionPattern,
  IStringLiteralPattern,
  StructuralPattern,
} from '../schema/pattern.ts';

/**
 * Test a single AST node against a pattern. Returns true when the node
 * is the kind the pattern targets AND every declared constraint holds.
 *
 * Patterns are intentionally narrow — a missing constraint never blocks
 * a match (only constraint failure does). The walker calls
 * `matchPattern` for every node; the matcher dispatches by `kind`.
 */
export function matchPattern(node: ts.Node, pattern: StructuralPattern): boolean {
  switch (pattern.kind) {
    case 'Identifier':
      return ts.isIdentifier(node) && matchIdentifier(node, pattern);
    case 'StringLiteral':
      return ts.isStringLiteral(node) && matchStringLiteral(node, pattern);
    case 'CallExpression':
      return ts.isCallExpression(node) && matchCallExpression(node, pattern);
    case 'NewExpression':
      return ts.isNewExpression(node) && matchNewExpression(node, pattern);
    case 'ImportDeclaration':
      return ts.isImportDeclaration(node) && matchImportDeclaration(node, pattern);
    case 'ClassDeclaration':
      return ts.isClassDeclaration(node) && matchClassDeclaration(node, pattern);
    case 'Decorator':
      return ts.isDecorator(node) && matchDecorator(node, pattern);
    default:
      return false;
  }
}

function matchIdentifier(node: ts.Identifier, pat: IIdentifierPattern): boolean {
  if (pat.name && pat.name !== '*' && node.text !== pat.name) return false;
  if (pat.nameRegex) {
    const re = new RegExp(pat.nameRegex);
    if (!re.test(node.text)) return false;
  }
  return true;
}

function matchStringLiteral(node: ts.StringLiteral, pat: IStringLiteralPattern): boolean {
  if (pat.text !== undefined && node.text !== pat.text) return false;
  if (pat.textRegex) {
    const re = new RegExp(pat.textRegex);
    if (!re.test(node.text)) return false;
  }
  return true;
}

function matchCallExpression(node: ts.CallExpression, pat: ICallExpressionPattern): boolean {
  if (pat.callee) {
    const callee = unwrapCallee(node.expression);
    if (!callee || !ts.isIdentifier(callee)) return false;
    if (!matchIdentifier(callee, pat.callee)) return false;
  }
  if (pat.argCount !== undefined && node.arguments.length !== pat.argCount) return false;
  if (pat.minArgs !== undefined && node.arguments.length < pat.minArgs) return false;
  return true;
}

function matchNewExpression(node: ts.NewExpression, pat: INewExpressionPattern): boolean {
  if (pat.callee) {
    const callee = unwrapCallee(node.expression);
    if (!callee || !ts.isIdentifier(callee)) return false;
    if (!matchIdentifier(callee, pat.callee)) return false;
  }
  return true;
}

function matchImportDeclaration(node: ts.ImportDeclaration, pat: IImportDeclarationPattern): boolean {
  if (!ts.isStringLiteral(node.moduleSpecifier)) return false;
  const spec = node.moduleSpecifier.text;
  if (pat.from !== undefined && spec !== pat.from) return false;
  if (pat.fromRegex) {
    const re = new RegExp(pat.fromRegex);
    if (!re.test(spec)) return false;
  }
  if (pat.sideEffectOnly === true) {
    if (node.importClause) return false;
  }
  if (pat.importedName) {
    const clause = node.importClause;
    if (!clause) return false;
    if (
      clause.namedBindings &&
      ts.isNamedImports(clause.namedBindings) &&
      clause.namedBindings.elements.some(
        (e) => e.name.text === pat.importedName || (e.propertyName && e.propertyName.text === pat.importedName),
      )
    ) {
      return true;
    }
    if (clause.name && clause.name.text === pat.importedName) return true;
    return false;
  }
  return true;
}

function matchClassDeclaration(node: ts.ClassDeclaration, pat: IClassDeclarationPattern): boolean {
  if (pat.name !== undefined) {
    if (!node.name || node.name.text !== pat.name) return false;
  }
  if (pat.nameRegex) {
    if (!node.name) return false;
    const re = new RegExp(pat.nameRegex);
    if (!re.test(node.name.text)) return false;
  }
  if (pat.hasDecoratorNamed) {
    const mods = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
    if (!mods || mods.length === 0) return false;
    const found = mods.some((d) => decoratorIdentifierName(d) === pat.hasDecoratorNamed);
    if (!found) return false;
  }
  return true;
}

function matchDecorator(node: ts.Decorator, pat: IDecoratorPattern): boolean {
  const name = decoratorIdentifierName(node);
  if (pat.name !== undefined && name !== pat.name) return false;
  if (pat.isCall !== undefined) {
    const isCall = ts.isCallExpression(node.expression);
    if (pat.isCall !== isCall) return false;
  }
  return true;
}

function decoratorIdentifierName(d: ts.Decorator): string | undefined {
  const expr = d.expression;
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) return expr.expression.text;
  return undefined;
}

function unwrapCallee(expr: ts.Expression): ts.Expression | undefined {
  // Allow `Foo.bar(...)` to match callee Identifier `bar`.
  if (ts.isPropertyAccessExpression(expr)) return expr.name;
  return expr;
}
