/**
 * Round 12 (R12-5.2 / R12-5.3 / R12-5.6) — the boundary authoring signals, end
 * to end: the real loader, THE orchestrator behind `check boundaries` and MCP
 * `check_boundaries`, and `boundaries explain`, over local AND pack rule files.
 *
 *   - R12-5.2: a specifier pattern that cannot mean what it says is an ERRORED
 *     rule (exit 1). `forbiddenImports: ['@scope/pkg/']` used to print
 *     `Verdict: OK — no boundary violations. ✓` at exit 0 over two imports of
 *     `@scope/pkg`.
 *   - R12-5.3: an allowance a bare forbidden package shadows is a dead unit —
 *     named on the exit-0 verdict line, exit 1 under `--fail-on-dead-units`.
 *   - R12-5.6: a redundant `pkg/**` next to `pkg` is INFO — a `note:` line and
 *     `subsumedBy` — and never changes an exit, with or without
 *     `--fail-on-dead-units`.
 *
 * Real temp workspaces, real rule files, a real pack under node_modules, the
 * real command handlers and the real registered MCP handler.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '@shrkcrft/mcp-server';
import { boundariesExplainCommand } from '../commands/boundaries.command.ts';
import { checkCommand } from '../commands/check.command.ts';
import type { ParsedArgs } from '../command-registry.ts';

const SLOW = 60_000;

function args(root: string, positional: string[], flags: Record<string, string | boolean> = {}): ParsedArgs {
  return {
    positional,
    flags: new Map<string, string | boolean>([['cwd', root], ...Object.entries(flags)]),
    multiFlags: new Map(),
  };
}

async function run(
  h: { run(a: ParsedArgs): Promise<number> | number },
  a: ParsedArgs,
): Promise<{ code: number; out: string }> {
  const orig = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = '';
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    out += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return { code: await h.run(a), out };
  } finally {
    process.stdout.write = orig;
    process.stderr.write = origErr;
  }
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** `@scope/pkg` is a declared dependency: a "never adopt it" guard on it is resolvable, never dead by reach. */
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r76-authoring-'));
  roots.push(root);
  const all: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0', dependencies: { '@scope/pkg': '1.0.0' } }),
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const LOCAL_CONFIG = "export default { projectName: 'fx', boundaryFiles: ['boundaries.ts'] };\n";
const local = (rules: string, files: Record<string, string>): string =>
  project({ 'sharkcraft/sharkcraft.config.ts': LOCAL_CONFIG, 'sharkcraft/boundaries.ts': rules, ...files });

const PACK = '@r76/slash-pack';
const packed = (rules: string, files: Record<string, string>): string =>
  project({
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx' };\n",
    [`node_modules/${PACK}/package.json`]: JSON.stringify({
      name: PACK,
      version: '0.0.1',
      type: 'module',
      sharkcraft: { manifest: './manifest.json' },
    }),
    [`node_modules/${PACK}/manifest.json`]: JSON.stringify({
      schema: 'sharkcraft.pack/v1',
      info: { name: PACK, version: '0.0.1' },
      contributions: { boundaryFiles: ['./boundaries.ts'] },
    }),
    [`node_modules/${PACK}/boundaries.ts`]: rules,
    ...files,
  });

const checkBoundaries = (tool: string) => {
  const t = ALL_TOOLS.find((x) => x.name === tool);
  if (!t) throw new Error(`MCP tool ${tool} is not registered`);
  return t;
};

const T_TS = "import { a } from '@scope/pkg';\nimport { b } from '@scope/pkg/sub';\nexport const t = [a, b];\n";
const TRAILING = "export default [{ id: 't.trailing-slash', title: 'No pkg', from: ['packages/t/**'], forbiddenImports: ['@scope/pkg/'] }];\n";

describe('R12-5.2 — an unmatchable specifier pattern is an errored rule, never a silent ✓', () => {
  for (const [origin, make] of [
    ['local', local],
    ['pack', packed],
  ] as const) {
    test(
      `${origin}: a trailing-slash forbidden pattern fails validation — exit 1 on the CLI and over MCP, the fix in the output`,
      async () => {
        const root = make(TRAILING, { 'packages/t/src/t.ts': T_TS });
        const text = await run(checkCommand, args(root, ['boundaries']));
        expect(text.code).toBe(1);
        expect(text.out).toContain("rule 't.trailing-slash' failed validation — NOT evaluated");
        expect(text.out).toContain("forbiddenImports[0]: '@scope/pkg/': a trailing '/' matches only an import written with that slash");
        expect(text.out).toContain("write '@scope/pkg' (the package and every subpath");
        expect(text.out).not.toContain('✓');

        const json = JSON.parse((await run(checkCommand, args(root, ['boundaries'], { json: true }))).out) as {
          exitCode: number;
          gate: { exit: number };
          loadIssues: { kind: string; ruleId?: string; origin: string; issues: string[] }[];
        };
        expect({ exit: json.exitCode, gate: json.gate.exit }).toEqual({ exit: 1, gate: 1 });
        expect(json.loadIssues.map((i) => [i.kind, i.ruleId, i.origin, i.issues[0]!.split(':')[0]])).toEqual([
          ['invalid-rule', 't.trailing-slash', origin, 'forbiddenImports[0]'],
        ]);

        const inspection = await inspectSharkcraft({ cwd: root });
        const mcp = (await checkBoundaries('check_boundaries').handler({}, { inspection, cwd: root })).data as {
          verdict: string;
          exitCode: number;
          loadIssues: { ruleId?: string }[];
        };
        expect([mcp.verdict, mcp.exitCode, mcp.loadIssues.map((i) => i.ruleId)]).toEqual(['fail', 1, ['t.trailing-slash']]);
      },
      SLOW,
    );
  }

  test(
    "a '!' specifier entry is errored with the carve-out advice — never 'typo or retired target?'",
    async () => {
      const root = local(
        "export default [{ id: 'n.negated', title: 'No pkg but public', from: ['packages/t/**'], forbiddenImports: ['@scope/pkg', '!@scope/pkg/public/**'] }];\n",
        { 'packages/t/src/t.ts': "import { p } from '@scope/pkg/public/x';\n" },
      );
      const r = await run(checkCommand, args(root, ['boundaries']));
      expect(r.code).toBe(1);
      expect(r.out).toContain("forbiddenImports[1]: '!@scope/pkg/public/**': negation is only supported in `from`");
      expect(r.out).toContain('exceptions[{ path, target, reason }]');
      expect(r.out).not.toContain('typo or retired target');
    },
    SLOW,
  );
});

describe('R12-5.3 — a shadowed allowance is a dead unit on the real surfaces', () => {
  const SHADOW =
    "export default [{ id: 'c.shadow', title: 'Only other', from: ['packages/c/**'], forbiddenImports: ['@scope/pkg'], allowedImports: ['@scope/pkg/public/**', '@scope/other'] }];\n";
  const C_TS = "import { o } from '@scope/other';\nexport const c = o;\n";

  test(
    'the default run keeps its exit (0) and names the dead unit on the verdict line; --fail-on-dead-units makes it 1',
    async () => {
      const root = local(SHADOW, { 'packages/c/src/c.ts': C_TS });
      const plain = await run(checkCommand, args(root, ['boundaries']));
      expect(plain.code).toBe(0);
      expect(plain.out).toContain("• [allowed] c.shadow: @scope/pkg/public/** — shadowed by forbidden '@scope/pkg'");
      expect(plain.out).toContain(
        'Verdict: no boundary violations — 1 dead selector unit(s) reported above (--fail-on-dead-units to fail on dead units).',
      );
      expect(plain.out).not.toContain('✓');

      const strict = await run(checkCommand, args(root, ['boundaries'], { 'fail-on-dead-units': true }));
      expect(strict.code).toBe(1);
      expect(strict.out).toContain('1 dead unit(s) (--fail-on-dead-units)');

      const json = JSON.parse((await run(checkCommand, args(root, ['boundaries'], { json: true }))).out) as {
        deadUnits: { unit: string; selector: string; cause?: string }[];
        coverage: { allowed: { pattern: string; shadowedBy?: string }[] }[];
      };
      expect(json.deadUnits.map((d) => [d.unit, d.selector, d.cause])).toEqual([['allowed', '@scope/pkg/public/**', 'shadowed']]);
      expect(json.coverage[0]!.allowed.map((a) => [a.pattern, a.shadowedBy])).toEqual([
        ['@scope/pkg/public/**', '@scope/pkg'],
        ['@scope/other', undefined],
      ]);

      const explain = await run(boundariesExplainCommand, args(root, ['c.shadow']));
      expect(explain.out).toContain("allowed '@scope/pkg/public/**' can never admit an import — forbidden '@scope/pkg' is checked first");
    },
    SLOW,
  );
});

describe('R12-5.6 — the pkg + pkg/** helper is reported redundant, and never changes an exit', () => {
  const HELPER =
    "export default [{ id: 'e.helper-shape', title: 'No pkg', from: ['packages/e/**'], forbiddenImports: ['@scope/pkg', '@scope/pkg/**'] }];\n";

  test(
    'a clean run: exit 0 with and without --fail-on-dead-units, the ✓ kept, one note line, subsumedBy in the JSON',
    async () => {
      const root = local(HELPER, { 'packages/e/src/e.ts': "import r from 'react';\nexport const e = r;\n" });
      const plain = await run(checkCommand, args(root, ['boundaries']));
      const strict = await run(checkCommand, args(root, ['boundaries'], { 'fail-on-dead-units': true }));
      expect([plain.code, strict.code]).toEqual([0, 0]);
      expect(plain.out).toContain(
        "note: 1 forbidden pattern(s) already covered by a sibling pattern of the same rule — redundant, safe to delete (e.g. e.helper-shape: '@scope/pkg/**' is covered by '@scope/pkg')",
      );
      expect(plain.out).toContain('Verdict: OK — no boundary violations. ✓');

      const json = JSON.parse((await run(checkCommand, args(root, ['boundaries'], { json: true }))).out) as {
        deadUnits: unknown[];
        coverage: { forbidden: { pattern: string; subsumedBy?: string }[] }[];
      };
      expect(json.deadUnits).toEqual([]);
      expect(json.coverage[0]!.forbidden.map((f) => [f.pattern, f.subsumedBy])).toEqual([
        ['@scope/pkg', undefined],
        ['@scope/pkg/**', '@scope/pkg'],
      ]);
    },
    SLOW,
  );

  test(
    'with a subpath import: exit 1 either way, attributed to the bare pattern; explain and MCP get_boundary_rule say which pattern to delete',
    async () => {
      const root = packed(HELPER, { 'packages/e/src/e.ts': "import { s } from '@scope/pkg/sub';\nexport const e = s;\n" });
      const plain = JSON.parse((await run(checkCommand, args(root, ['boundaries'], { json: true }))).out) as {
        exitCode: number;
        violations: { importSpecifier: string; matchedForbidden?: string; matchKind?: string }[];
      };
      const strict = await run(checkCommand, args(root, ['boundaries'], { 'fail-on-dead-units': true }));
      expect([plain.exitCode, strict.code]).toEqual([1, 1]);
      expect(plain.violations.map((v) => [v.importSpecifier, v.matchedForbidden, v.matchKind])).toEqual([
        ['@scope/pkg/sub', '@scope/pkg', 'subpath'],
      ]);

      const explainText = await run(boundariesExplainCommand, args(root, ['e.helper-shape']));
      expect(explainText.out).toContain("'@scope/pkg/**' is covered by '@scope/pkg' (package semantics) — redundant; safe to delete");
      const explainJson = JSON.parse((await run(boundariesExplainCommand, args(root, ['e.helper-shape'], { json: true }))).out) as {
        redundantForbidden: unknown[];
        shadowedAllowed: unknown[];
      };
      const inspection = await inspectSharkcraft({ cwd: root });
      const got = (await checkBoundaries('get_boundary_rule').handler({ id: 'e.helper-shape' }, { inspection, cwd: root })).data as {
        redundantForbidden: unknown[];
        shadowedAllowed: unknown[];
      };
      const expected = [{ pattern: '@scope/pkg/**', coveredBy: '@scope/pkg' }];
      expect([explainJson.redundantForbidden, explainJson.shadowedAllowed]).toEqual([expected, []]);
      expect([got.redundantForbidden, got.shadowedAllowed]).toEqual([expected, []]);
    },
    SLOW,
  );
});
