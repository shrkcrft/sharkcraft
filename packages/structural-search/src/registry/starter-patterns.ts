import type { IPatternEnvelope } from '../schema/pattern.ts';
import { STRUCTURAL_PATTERN_SCHEMA } from '../schema/pattern.ts';

/**
 * Curated starter pattern set. These are intentionally narrow and
 * useful out of the box: they catch real DX issues that a clean repo
 * should have zero of (console.log left in committed code,
 * `@Controller()` decorators without a route argument, etc.).
 *
 * Used by `shrk search-structural registry seed` to populate a fresh
 * registry. Authors are expected to grow / prune the set per project.
 */
export const STARTER_PATTERNS: readonly IPatternEnvelope[] = [
  {
    schema: STRUCTURAL_PATTERN_SCHEMA,
    id: 'starter.no-console-log',
    title: 'No console.log calls',
    description:
      'Catches `console.log(...)` left in committed source. Pair with a rule that allows console.warn / console.error.',
    pattern: {
      kind: 'CallExpression',
      callee: { kind: 'Identifier', nameRegex: '^log$' },
      minArgs: 0,
    },
  },
  {
    schema: STRUCTURAL_PATTERN_SCHEMA,
    id: 'starter.no-debugger',
    title: 'No debugger calls',
    description:
      'Catches `debugger;` statements via a synthetic call shape match. False-positive-prone — use as a quick scan, not a hard gate.',
    pattern: {
      kind: 'Identifier',
      name: 'debugger',
    },
  },
  {
    schema: STRUCTURAL_PATTERN_SCHEMA,
    id: 'starter.nest.bare-controller',
    title: 'NestJS @Controller() decorator without a route argument',
    description:
      'Flags `@Controller()` (no args), which mounts at the app root and is usually a typo. The shape match is callee-only — combine with `argCount: 0` to require zero args.',
    pattern: {
      kind: 'CallExpression',
      callee: { kind: 'Identifier', name: 'Controller' },
      argCount: 0,
    },
  },
  {
    schema: STRUCTURAL_PATTERN_SCHEMA,
    id: 'starter.nest.injectable',
    title: 'NestJS @Injectable() decorator usage',
    description:
      'Locates every `@Injectable()` call. Useful as a starting point for "find every provider in this app".',
    pattern: {
      kind: 'CallExpression',
      callee: { kind: 'Identifier', name: 'Injectable' },
    },
  },
  {
    schema: STRUCTURAL_PATTERN_SCHEMA,
    id: 'starter.react.unsafe-eval',
    title: 'eval() call',
    description:
      'Catches `eval(...)` — almost always a security smell. Pair with a rule that forbids dynamic code in user-input paths.',
    pattern: {
      kind: 'CallExpression',
      callee: { kind: 'Identifier', name: 'eval' },
    },
  },
  {
    schema: STRUCTURAL_PATTERN_SCHEMA,
    id: 'starter.imports.dynamic-require',
    title: 'Dynamic require() with a variable specifier',
    description:
      'Matches `require(...)` callsites. Useful in TypeScript-first repos that should be using `import` exclusively.',
    pattern: {
      kind: 'CallExpression',
      callee: { kind: 'Identifier', name: 'require' },
    },
  },
  {
    schema: STRUCTURAL_PATTERN_SCHEMA,
    id: 'starter.imports.from-internal',
    title: 'Cross-package import from internal/ path',
    description:
      'Locates imports whose source path mentions `/internal/` — usually a private boundary another package should NOT cross. Combine with `shrk arch check` for the layered enforcement.',
    pattern: {
      kind: 'ImportDeclaration',
      fromRegex: '/internal/',
    },
  },
];
