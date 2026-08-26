import { describe, expect, test } from 'bun:test';
import type { IWiringRule } from '@shrkcrft/core';
import {
  collectSinkBindings,
  deriveImportTemplate,
  insertImportStatement,
  renderImport,
} from '../wiring/sink-imports.ts';
import { planWiringFix } from '../wiring/plan-wiring-fix.ts';
import type { IWiringViolation } from '../wiring/evaluate-wiring.ts';

/**
 * The bug this file exists to prevent: `--fix` appended a token to a registry
 * array whose members are IMPORTED, turning the wiring gate green while leaving
 * the file referencing an unbound symbol. A gate that goes green by breaking
 * the build is the exact inverse of the point.
 */

describe('collectSinkBindings', () => {
  test('binds named, aliased, default and namespace imports', () => {
    const content = [
      "import A from './a';",
      "import * as NS from './ns';",
      "import { B, C as D } from './bc';",
      "import E, { F } from './ef';",
    ].join('\n');
    const byLocal = new Map(collectSinkBindings(content).map((b) => [b.local, b] as const));
    expect(byLocal.get('A')?.kind).toBe('default-import');
    expect(byLocal.get('NS')?.kind).toBe('namespace-import');
    expect(byLocal.get('B')?.kind).toBe('named-import');
    expect(byLocal.get('D')?.imported).toBe('C');
    expect(byLocal.get('E')?.kind).toBe('default-import');
    expect(byLocal.get('F')?.kind).toBe('named-import');
  });

  test('a type-only import binds NO value', () => {
    // Writing an array element that resolves to a type erases at compile time —
    // treating this as a binding would reintroduce the non-compiling edit.
    const bindings = collectSinkBindings("import type { T } from './t';\nimport { type U, V } from './uv';");
    expect(bindings.map((b) => b.local)).toEqual(['V']);
  });

  test('multi-line import blocks are parsed', () => {
    const content = 'import {\n  A,\n  B,\n} from "./ab";\n';
    expect(collectSinkBindings(content).map((b) => b.local).sort()).toEqual(['A', 'B']);
  });

  test('local declarations count as bindings', () => {
    const content = 'const A = 1;\nexport const B = 2;\nfunction C() {}\nclass D {}\n';
    const locals = collectSinkBindings(content).filter((b) => b.kind === 'local').map((b) => b.local);
    expect(locals.sort()).toEqual(['A', 'B', 'C', 'D']);
  });
});

describe('deriveImportTemplate', () => {
  const uniform = "import { A_H } from './A_H';\nimport { B_H } from './B_H';\n";

  test('derives the template when the specifier is a function of the member name', () => {
    const t = deriveImportTemplate(uniform, ['A_H', 'B_H']);
    expect(t?.specifierTemplate).toBe('./{}');
    expect(t?.derivedFrom).toBe(2);
    expect(renderImport(t!, 'C_H')).toBe("import { C_H } from './C_H';");
  });

  test('refuses a BARREL — one specifier for many members is not a function of the name', () => {
    expect(deriveImportTemplate("import { A_H, B_H } from './handlers';", ['A_H', 'B_H'])).toBeUndefined();
  });

  test('refuses MIXED paths', () => {
    const mixed = "import { A_H } from './a/A_H';\nimport { B_H } from './b/B_H';\n";
    expect(deriveImportTemplate(mixed, ['A_H', 'B_H'])).toBeUndefined();
  });

  test('refuses an ALIASED import — the exported name is not the written name', () => {
    const aliased = "import { A_H as A } from './A_H';\n";
    expect(deriveImportTemplate(aliased, ['A'])).toBeUndefined();
  });

  test('refuses a DEFAULT-import convention — the renderer only emits named imports', () => {
    // Emitting `import { X } from …` into a file whose members arrive as
    // default imports would not compile, so this shape must refuse rather than
    // render the wrong form.
    expect(deriveImportTemplate("import A_H from './A_H';\n", ['A_H'])).toBeUndefined();
  });

  test('refuses a NAMESPACE-import convention for the same reason', () => {
    expect(deriveImportTemplate("import * as A_H from './A_H';\n", ['A_H'])).toBeUndefined();
  });

  test('mirrors the file\'s quote style and semicolon usage', () => {
    const doubleNoSemi = 'import { A_H } from "./A_H"\n';
    const t = deriveImportTemplate(doubleNoSemi, ['A_H']);
    expect(renderImport(t!, 'C_H')).toBe('import { C_H } from "./C_H"');
  });
});

describe('insertImportStatement', () => {
  test('appends after the LAST import, moving no existing line', () => {
    const content = "import { A } from './a';\nimport { B } from './b';\n\nexport const X = [A, B];\n";
    const out = insertImportStatement(content, "import { C } from './c';")!;
    expect(out.nextContent).toBe(
      "import { A } from './a';\nimport { B } from './b';\nimport { C } from './c';\n\nexport const X = [A, B];\n",
    );
    expect(out.line).toBe(3);
  });

  test('returns undefined when the file has no imports to extend', () => {
    expect(insertImportStatement('export const X = [];\n', "import { C } from './c';")).toBeUndefined();
  });
});

describe('planWiringFix — import-aware', () => {
  const RULE: IWiringRule = {
    id: 'handlers',
    declared: { files: ['src/*_H.ts'], extract: 'export-names', match: '_H$' },
    registered: { files: ['src/registry.ts'], extract: 'array-members', anchor: 'HANDLERS' },
  };
  const violation = (token: string, file: string): IWiringViolation =>
    ({ ruleId: 'handlers', token, file, line: 1, direction: 'declared-missing', severity: 'error' }) as IWiringViolation;

  test('plans BOTH edits when the import specifier is derivable and resolves', () => {
    const files = [
      {
        path: 'src/registry.ts',
        content: "import { A_H } from './A_H';\n\nexport const HANDLERS = [A_H];\n",
      },
      { path: 'src/C_H.ts', content: 'export const C_H = 1;\n' },
    ];
    const plan = planWiringFix(RULE, [violation('C_H', 'src/C_H.ts')], files);
    expect(plan.skipped).toHaveLength(0);
    expect(plan.edits).toHaveLength(1);
    expect(plan.edits[0]!.importInsert).toBe("import { C_H } from './C_H';");
    // The written content must contain BOTH halves — that is what compiles.
    expect(plan.edits[0]!.nextContent).toContain("import { C_H } from './C_H';");
    expect(plan.edits[0]!.nextContent).toContain('[A_H, C_H]');
  });

  test('REFUSES with needs-import when the sink imports via a barrel', () => {
    const files = [
      {
        path: 'src/registry.ts',
        content: "import { A_H } from './handlers';\n\nexport const HANDLERS = [A_H];\n",
      },
      { path: 'src/C_H.ts', content: 'export const C_H = 1;\n' },
    ];
    const plan = planWiringFix(RULE, [violation('C_H', 'src/C_H.ts')], files);
    expect(plan.edits).toHaveLength(0);
    expect(plan.skipped[0]!.reason).toBe('needs-import');
  });

  test('REFUSES when the derived specifier does not resolve to the declaring file', () => {
    // The template fits the existing members but would point the new import at
    // a file that does not declare the token. Writing it would compile-fail —
    // this is the check that makes the derived path trustworthy, not merely
    // plausible.
    const files = [
      {
        path: 'src/registry.ts',
        content: "import { A_H } from './other/A_H';\n\nexport const HANDLERS = [A_H];\n",
      },
      { path: 'src/C_H.ts', content: 'export const C_H = 1;\n' },
    ];
    const plan = planWiringFix(RULE, [violation('C_H', 'src/C_H.ts')], files);
    expect(plan.edits).toHaveLength(0);
    expect(plan.skipped[0]!.reason).toBe('needs-import');
    expect(plan.skipped[0]!.detail).toContain('does not resolve to src/C_H.ts');
  });

  test('catches a template whose member name also appears in its own directory', () => {
    // `./Handler/Handler` splits on "Handler" into `./{}/{}`, which renders
    // `./Other/Other` for the next token — a path that does not exist. A pure
    // template approach would write it; the resolution check is what turns this
    // from a plausible guess into a refusal.
    const files = [
      {
        path: 'src/registry.ts',
        content: "import { A_H } from './A_H/A_H';\n\nexport const HANDLERS = [A_H];\n",
      },
      { path: 'src/C_H.ts', content: 'export const C_H = 1;\n' },
    ];
    const plan = planWiringFix(RULE, [violation('C_H', 'src/C_H.ts')], files);
    expect(plan.edits).toHaveLength(0);
    expect(plan.skipped[0]!.reason).toBe('needs-import');
    expect(plan.skipped[0]!.detail).toContain('./C_H/C_H');
  });

  test('resolves a specifier that carries an explicit extension', () => {
    const files = [
      {
        path: 'src/registry.ts',
        content: "import { A_H } from './h/A_H.ts';\n\nexport const HANDLERS = [A_H];\n",
      },
      { path: 'src/h/C_H.ts', content: 'export const C_H = 1;\n' },
    ];
    const plan = planWiringFix(RULE, [violation('C_H', 'src/h/C_H.ts')], files);
    expect(plan.skipped).toHaveLength(0);
    expect(plan.edits[0]!.importInsert).toBe("import { C_H } from './h/C_H.ts';");
  });

  test('two tokens each get their own import, accumulated into one buffer', () => {
    const files = [
      {
        path: 'src/registry.ts',
        content: "import { A_H } from './A_H';\n\nexport const HANDLERS = [\n  A_H,\n];\n",
      },
      { path: 'src/B_H.ts', content: 'export const B_H = 1;\n' },
      { path: 'src/C_H.ts', content: 'export const C_H = 2;\n' },
    ];
    const plan = planWiringFix(
      RULE,
      [violation('B_H', 'src/B_H.ts'), violation('C_H', 'src/C_H.ts')],
      files,
    );
    expect(plan.skipped).toHaveLength(0);
    expect(plan.edits).toHaveLength(2);
    // The LAST edit carries every earlier insertion — that is what gets written.
    const final = plan.edits[1]!.nextContent;
    expect(final).toContain("import { B_H } from './B_H';");
    expect(final).toContain("import { C_H } from './C_H';");
    expect(final).toContain('  A_H,\n  B_H,\n  C_H,\n');
  });

  test('a sink whose members are ALSO unbound is appended to — no false refusal', () => {
    // The check is an INCONSISTENCY check, not a resolvability check. If the
    // existing members are unbound too (ambient globals, a `/// <reference>`),
    // whatever makes them resolve applies equally to the new one, and the
    // append does not make the file any worse. Refusing here would block the
    // fix on files the edit is perfectly safe for.
    const files = [
      { path: 'src/registry.ts', content: 'export const HANDLERS = [A_H];\n' },
      { path: 'src/C_H.ts', content: 'export const C_H = 1;\n' },
    ];
    const plan = planWiringFix(RULE, [violation('C_H', 'src/C_H.ts')], files);
    expect(plan.skipped).toHaveLength(0);
    expect(plan.edits[0]!.importInsert).toBeUndefined();
    expect(plan.edits[0]!.nextContent).toContain('[A_H, C_H]');
  });

  test('a MIXED sink — one member imported — still follows the import convention', () => {
    // One import is enough to establish that external members arrive by import,
    // so a new external token must too.
    const files = [
      {
        path: 'src/registry.ts',
        content: "import { A_H } from './handlers';\nconst B_H = 2;\n\nexport const HANDLERS = [A_H, B_H];\n",
      },
      { path: 'src/C_H.ts', content: 'export const C_H = 1;\n' },
    ];
    const plan = planWiringFix(RULE, [violation('C_H', 'src/C_H.ts')], files);
    expect(plan.edits).toHaveLength(0);
    expect(plan.skipped[0]!.reason).toBe('needs-import');
  });

  test('REFUSES when the declaring file does not EXPORT the token', () => {
    // A rule can find a token with any extractor — `regex-capture` over
    // `const (\w+)` matches un-exported locals too. Being declared somewhere
    // does not mean being importable from there.
    const files = [
      {
        path: 'src/registry.ts',
        content: "import { A_H } from './A_H';\n\nexport const HANDLERS = [A_H];\n",
      },
      { path: 'src/C_H.ts', content: 'const C_H = 1;\n' }, // declared, NOT exported
    ];
    const plan = planWiringFix(RULE, [violation('C_H', 'src/C_H.ts')], files);
    expect(plan.edits).toHaveLength(0);
    expect(plan.skipped[0]!.reason).toBe('needs-import');
    expect(plan.skipped[0]!.detail).toContain('not exported from it');
  });

  test('an INLINE registry (members declared locally) is still fixed — no false refusal', () => {
    const files = [
      {
        path: 'src/registry.ts',
        content: 'const A_H = 1;\nconst C_H = 2;\n\nexport const HANDLERS = [A_H];\n',
      },
    ];
    const plan = planWiringFix(RULE, [violation('C_H', 'src/C_H.ts')], files);
    expect(plan.skipped).toHaveLength(0);
    expect(plan.edits[0]!.importInsert).toBeUndefined();
    expect(plan.edits[0]!.nextContent).toContain('[A_H, C_H]');
  });

  test('a STRING-member array needs no import at all', () => {
    const stringRule: IWiringRule = {
      ...RULE,
      declared: { files: ['src/*.ts'], extract: 'regex-capture', pattern: "id: '(\\w+)'" },
    };
    const files = [
      { path: 'src/registry.ts', content: "export const HANDLERS = ['a'];\n" },
    ];
    const plan = planWiringFix(stringRule, [violation('b', 'src/b.ts')], files);
    expect(plan.skipped).toHaveLength(0);
    expect(plan.edits[0]!.nextContent).toContain("['a', 'b']");
    expect(plan.edits[0]!.importInsert).toBeUndefined();
  });
});
