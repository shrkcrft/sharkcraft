/**
 * §2.4 — `gen --typecheck` compiles the emitted files against the detected
 * toolchain BEFORE apply, so a project-template bug fails at generation time
 * instead of at the human's next build.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { genCommand } from '../commands/gen.command.ts';
import type { ParsedArgs } from '../command-registry.ts';

function setupRepo(templateBody: string): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-gen-typecheck-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"gen-demo","version":"0.0.0"}\n');
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', noEmit: true } }, null, 2),
  );
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    ["export default {", "  projectName: 'demo',", "  templateFiles: ['templates.ts'],", "};"].join('\n'),
  );
  writeFileSync(join(root, 'sharkcraft', 'templates.ts'), templateBody);
  return root;
}

function makeArgs(positional: string[], cwd: string, flags: Record<string, string | boolean> = {}): ParsedArgs {
  return {
    positional,
    flags: new Map<string, string | boolean>([['cwd', cwd], ...Object.entries(flags)]),
    multiFlags: new Map<string, string[]>(),
  };
}

function capture(): { restore: () => string } {
  const orig = process.stdout.write.bind(process.stdout);
  let body = '';
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    body += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  return {
    restore() {
      process.stdout.write = orig;
      return body;
    },
  };
}

const VALID_TEMPLATE = [
  'export default [{',
  "  id: 'demo.ok',",
  "  name: 'ok',",
  '  variables: [],',
  "  targetPath: 'src/ok.ts',",
  "  content: 'export const y: number = 1;\\n',",
  '}];',
].join('\n');

const BROKEN_TEMPLATE = [
  'export default [{',
  "  id: 'demo.broken',",
  "  name: 'broken',",
  '  variables: [],',
  "  targetPath: 'src/broken.ts',",
  // A type error the emitted file will not survive a typecheck for.
  '  content: \'export const x: number = "not a number";\\n\',',
  '}];',
].join('\n');

describe('gen --typecheck (§2.4)', () => {
  test('a valid template passes the typecheck gate (exit 0)', async () => {
    const root = setupRepo(VALID_TEMPLATE);
    try {
      const cap = capture();
      const code = await genCommand.run(makeArgs(['demo.ok', 'inst'], root, { typecheck: true, json: true }));
      const out = JSON.parse(cap.restore());
      expect(code).toBe(0);
      expect(out.typecheck.ran).toBe(true);
      expect(out.typecheck.errors.length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a template that emits non-compiling code FAILS at generation time (exit 1)', async () => {
    const root = setupRepo(BROKEN_TEMPLATE);
    try {
      const cap = capture();
      const code = await genCommand.run(makeArgs(['demo.broken', 'inst'], root, { typecheck: true, json: true }));
      const out = JSON.parse(cap.restore());
      expect(code).toBe(1);
      expect(out.typecheck.ran).toBe(true);
      expect(out.typecheck.errors.length).toBeGreaterThan(0);
      expect(out.typecheck.errors[0].file).toContain('broken.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('--write --typecheck REFUSES the write on a broken template (nothing lands on disk)', async () => {
    const root = setupRepo(BROKEN_TEMPLATE);
    try {
      const cap = capture();
      // Ask to WRITE and typecheck together — the typecheck must gate the write.
      const code = await genCommand.run(makeArgs(['demo.broken', 'inst'], root, { write: true, typecheck: true, json: true }));
      const out = JSON.parse(cap.restore());
      expect(code).toBe(1);
      expect(out.writeRefused).toBe(true);
      expect(out.written).toEqual([]);
      // The non-compiling file must NOT exist on disk — the gate ran PRE-write.
      expect(existsSync(join(root, 'src', 'broken.ts'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('--write --typecheck DOES write when the emitted files compile', async () => {
    const root = setupRepo(VALID_TEMPLATE);
    try {
      const cap = capture();
      const code = await genCommand.run(makeArgs(['demo.ok', 'inst'], root, { write: true, typecheck: true, json: true }));
      const out = JSON.parse(cap.restore());
      expect(code).toBe(0);
      expect(out.writeRefused).toBeUndefined();
      expect(out.written).toContain('src/ok.ts');
      expect(existsSync(join(root, 'src', 'ok.ts'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
