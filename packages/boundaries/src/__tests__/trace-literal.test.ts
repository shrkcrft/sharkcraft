import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRACE_SCHEMA, TraceRole, traceLiteral } from '../wiring/trace-literal.ts';

const LITERAL = 'user.created';

/**
 * A literal duplicated across a fence: declared as a const, registered into a
 * collection, and consumed in a guard — plus a const-alias use.
 */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-trace-literal-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'events.ts'), "export const USER_CREATED = 'user.created';\n");
  writeFileSync(
    join(root, 'src', 'registry.ts'),
    "import { USER_CREATED } from './events';\nregister('user.created');\nconst list = [USER_CREATED];\n",
  );
  writeFileSync(
    join(root, 'src', 'handler.ts'),
    "export function handle(evt: string) {\n  if (evt === 'user.created') return true;\n  return false;\n}\n",
  );
  return root;
}

describe('traceLiteral', () => {
  test('classifies declare / register / consume sites of a cross-fence literal', () => {
    const root = fixture();
    try {
      const report = traceLiteral(root, LITERAL);
      expect(report.schema).toBe(TRACE_SCHEMA);
      expect(report.literal).toBe(LITERAL);

      // const USER_CREATED = 'user.created' → declare.
      expect(report.byRole[TraceRole.Declare].some((s) => s.file === 'src/events.ts')).toBe(true);
      // register('user.created') → register.
      expect(report.byRole[TraceRole.Register].some((s) => s.file === 'src/registry.ts')).toBe(true);
      // evt === 'user.created' → consume.
      expect(report.byRole[TraceRole.Consume].some((s) => s.file === 'src/handler.ts')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('resolves a const alias and classifies its use sites (viaAlias)', () => {
    const root = fixture();
    try {
      const report = traceLiteral(root, LITERAL);
      expect(report.aliases).toContain('USER_CREATED');
      // `const list = [USER_CREATED]` → an array element reached via the alias.
      const aliasUse = report.byRole[TraceRole.Register].find((s) => s.viaAlias === 'USER_CREATED');
      expect(aliasUse).toBeDefined();
      expect(aliasUse!.file).toBe('src/registry.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('--no-aliases (resolveAliases:false) omits alias use-sites', () => {
    const root = fixture();
    try {
      const report = traceLiteral(root, LITERAL, { resolveAliases: false });
      // The binding itself is still found (it contains the literal), but no
      // viaAlias use-site is reported.
      const allSites = [
        ...report.byRole[TraceRole.Declare],
        ...report.byRole[TraceRole.Register],
        ...report.byRole[TraceRole.Consume],
        ...report.byRole[TraceRole.Reference],
      ];
      expect(allSites.every((s) => s.viaAlias === undefined)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reports an alias use that shares a line with a literal occurrence', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-trace-coloc-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      // Line 2 has BOTH a literal 'user' (=== guard) AND a use of the alias ID.
      // A line-granular skip used to drop the ID use because the line also
      // contained a literal; only the binding occurrence should be skipped.
      writeFileSync(
        join(root, 'src', 'a.ts'),
        "const ID = 'user';\nexport const pick = (v: string) => (v === 'user' ? ID : null);\n",
      );
      const report = traceLiteral(root, 'user');
      expect(report.aliases).toContain('ID');
      const aliasUse = report.byRole[TraceRole.Reference].find(
        (s) => s.viaAlias === 'ID' && s.line === 2,
      );
      expect(aliasUse).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not count member/enum accesses (`X.NAME`) as alias uses (over-match)', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-trace-member-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      // ADMIN is a const alias bound to the traced literal 'admin'.
      writeFileSync(join(root, 'src', 'perm.ts'), "export const ADMIN = 'admin';\n");
      // A GENUINE bare use of the alias → a viaAlias site.
      writeFileSync(join(root, 'src', 'use.ts'), "import { ADMIN } from './perm';\ngrant(ADMIN);\n");
      // Member/enum accessors that merely spell the same name → must NOT count:
      // `Role.ADMIN` / `config.ADMIN` are properties of other objects, unrelated
      // to the string literal. The `.` before ADMIN excludes them.
      writeFileSync(
        join(root, 'src', 'role.ts'),
        'if (user.role === Role.ADMIN) allow();\nlog(config.ADMIN);\n',
      );
      const report = traceLiteral(root, 'admin');
      expect(report.aliases).toContain('ADMIN');
      const aliasSites = Object.values(report.byRole)
        .flat()
        .filter((s) => s.viaAlias === 'ADMIN');
      // The bare use in use.ts is counted ...
      expect(aliasSites.some((s) => s.file === 'src/use.ts')).toBe(true);
      // ... but neither `Role.ADMIN` nor `config.ADMIN` in role.ts is.
      expect(aliasSites.some((s) => s.file === 'src/role.ts')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('classifies JSX/template/render sites as Render, leaving declare/register/consume intact', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-trace-render-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      // The existing declare → register → consume chain for 'greeting' ...
      writeFileSync(join(root, 'src', 'msg.ts'), "export const GREETING = 'greeting';\n");
      writeFileSync(join(root, 'src', 'reg.ts'), "register('greeting');\n");
      writeFileSync(join(root, 'src', 'guard.ts'), "if (k === 'greeting') ok();\n");
      // ... plus three render/handle sites that used to fall to `reference`:
      // JSX child interpolation, template interpolation, and a render() call.
      writeFileSync(
        join(root, 'src', 'view.tsx'),
        "export const View = () => <div>{'greeting'}</div>;\n",
      );
      writeFileSync(join(root, 'src', 'tpl.ts'), "const s = `${'greeting'}`;\n");
      writeFileSync(join(root, 'src', 'server.ts'), "res.render('greeting');\n");

      const report = traceLiteral(root, 'greeting');

      // The three render sites are captured as Render ...
      const renderFiles = new Set(report.byRole[TraceRole.Render].map((s) => s.file));
      expect(renderFiles.has('src/view.tsx')).toBe(true);
      expect(renderFiles.has('src/tpl.ts')).toBe(true);
      expect(renderFiles.has('src/server.ts')).toBe(true);
      // ... and none of them leaked into the `reference` catch-all.
      expect(report.byRole[TraceRole.Reference].length).toBe(0);

      // The higher-precision roles are UNCHANGED — Render never steals from them.
      expect(report.byRole[TraceRole.Declare].some((s) => s.file === 'src/msg.ts')).toBe(true);
      expect(report.byRole[TraceRole.Register].some((s) => s.file === 'src/reg.ts')).toBe(true);
      expect(report.byRole[TraceRole.Consume].some((s) => s.file === 'src/guard.ts')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('matches the EXACT literal only, never a substring of a longer string', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-trace-exact-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      // 'user.created.v2' must NOT match a trace of 'user.created'.
      writeFileSync(join(root, 'src', 'a.ts'), "const x = 'user.created.v2';\nconst y = 'user.created';\n");
      const report = traceLiteral(root, 'user.created');
      expect(report.total).toBe(1);
      const all = Object.values(report.byRole).flat();
      expect(all[0]!.line).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
