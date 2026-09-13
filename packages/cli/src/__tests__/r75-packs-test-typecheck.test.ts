/**
 * Round 11 §1.4#b — `packs test --typecheck` type-checks the manifest and every
 * TS contribution the manifest declares (the pack build is transpile-only, so
 * nothing else does). A pack with nothing to check exits 2 — never a pass.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ParsedArgs } from '../command-registry.ts';
import { packsTestCommand } from '../commands/packs-new.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

async function run(root: string, flags: Record<string, string | boolean>): Promise<{ code: number; out: string }> {
  const a: ParsedArgs = {
    positional: ['.'],
    flags: new Map<string, string | boolean>([['cwd', root], ...Object.entries(flags)]),
    multiFlags: new Map(),
  };
  const orig = process.stdout.write.bind(process.stdout);
  let out = '';
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    out += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    return { code: await packsTestCommand.run(a), out };
  } finally {
    process.stdout.write = orig;
  }
}

function pack(contributions: Record<string, readonly string[]>, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-ptc-'));
  roots.push(root);
  write(root, 'package.json', JSON.stringify({ name: '@r75/tc', version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }));
  write(
    root,
    'manifest.json',
    JSON.stringify({ schema: 'sharkcraft.pack/v1', info: { name: '@r75/tc', version: '0.0.1' }, contributions }),
  );
  for (const [rel, body] of Object.entries(files)) write(root, rel, body);
  return root;
}

const ENTRY = `export default [{ id: 'k1', title: 'K', type: 'technical', priority: 'low', scope: [], tags: [], appliesWhen: [], content: 'c' }];\n`;
const TYPE_ERRORS = [
  'const PRIORITIES = { high: 1, low: 2 };',
  'export function weight(p) {',
  '  return PRIORITIES[p];',
  '}',
  'export function lookup(key: string) {',
  '  return PRIORITIES[key];',
  '}',
  ENTRY,
].join('\n');

describe('packs test --typecheck', () => {
  test('an implicit-any parameter and a closed literal indexed by string → exit 1, located', async () => {
    const root = pack({ knowledgeFiles: ['./src/knowledge.ts'] }, { 'src/knowledge.ts': TYPE_ERRORS });
    const r = await run(root, { typecheck: true, json: true });
    expect(r.code).toBe(1);
    const report = JSON.parse(r.out) as { issues: { code: string; message: string }[]; typecheck: { ran: boolean } };
    expect(report.typecheck.ran).toBe(true);
    const messages = report.issues.filter((i) => i.code === 'typecheck-error').map((i) => i.message);
    expect(messages.some((m) => m.startsWith('src/knowledge.ts:2:') && m.includes('TS7006'))).toBe(true);
    expect(messages.some((m) => m.startsWith('src/knowledge.ts:6:') && m.includes('TS7053'))).toBe(true);
  });

  test('a clean pack → 0; the declared contribution files — not a hard-coded list — are what is checked', async () => {
    const root = pack({ knowledgeFiles: ['./assets/k.ts'] }, { 'assets/k.ts': ENTRY });
    const r = await run(root, { typecheck: true, load: true, json: true });
    const report = JSON.parse(r.out) as { exitCode: number; issues: unknown[]; typecheck: { checkedFiles: string[] } };
    expect(report.issues).toEqual([]);
    expect(report.typecheck.checkedFiles).toEqual(['assets/k.ts']);
    expect(r.code).toBe(0);
  });

  test('a pack with only markdown contributions examined 0 TS files → exit 2, NOT VERIFIED', async () => {
    const root = pack({ docsFiles: ['./docs/a.md'] }, { 'docs/a.md': '# A\n' });
    const r = await run(root, { typecheck: true });
    expect(r.code).toBe(2);
    expect(r.out).toContain('NOT VERIFIED');
    expect(r.out).toContain('0 TS files');
    expect(r.out).not.toMatch(/\.\s*✓/);
    const json = await run(root, { typecheck: true, json: true });
    expect(json.code).toBe(2);
    expect((JSON.parse(json.out) as { exitCode: number }).exitCode).toBe(2);
  });

  test('a package.json with no sharkcraft.manifest is an error — discovery would report the pack INVALID', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-r75-ptc-nomanifest-'));
    roots.push(root);
    write(root, 'package.json', JSON.stringify({ name: '@r75/none', version: '0.0.1', sharkcraft: { kind: 'generic' } }));
    const r = await run(root, { json: true });
    expect(r.code).toBe(1);
    expect((JSON.parse(r.out) as { issues: { code: string }[] }).issues.map((i) => i.code)).toContain('no-manifest');
  });
});
