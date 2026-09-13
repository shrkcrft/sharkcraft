/**
 * Round 11, 1.2#4 — a corpus check that LOADED NOTHING is a configuration
 * failure, never a pass.
 *
 * Run from a nested workspace member (its own package.json, no sharkcraft/
 * folder), discovery binds to that member, loads 0 entries, and the check used
 * to print `ok=0 stale=0` with exit 0 — in this very repo, from packages/cli.
 * Now it refuses (2), names the root it resolved and the configured ancestor to
 * rerun from, and `--allow-empty` accepts ONLY a genuinely empty corpus — never
 * a missing folder or a config that failed to load.
 *
 * Also: the CLI verb warms the registries, so a correct playbook reference is
 * ok (1.1#warm, end to end).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ParsedArgs } from '../command-registry.ts';
import { knowledgeListCommand, knowledgeStaleCheckCommand } from '../commands/knowledge.command.ts';
import { ExitCode } from '../exit-codes.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** ParsedArgs exactly as `parseArgs` builds them: every string flag also lands in `multiFlags`. */
function args(cwd: string, flags: Record<string, string | boolean> = {}): ParsedArgs {
  return {
    positional: [],
    flags: new Map<string, string | boolean>([['cwd', cwd], ...Object.entries(flags)]),
    multiFlags: new Map(
      Object.entries(flags)
        .filter((kv): kv is [string, string] => typeof kv[1] === 'string')
        .map(([k, v]) => [k, [v]]),
    ),
  };
}

async function run(
  h: { run(a: ParsedArgs): Promise<number> | number },
  a: ParsedArgs,
): Promise<{ code: number; out: string; err: string }> {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = '';
  let err = '';
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    out += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array): boolean => {
    err += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await h.run(a), out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-kdisc-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const ONE_ENTRY =
  "export default [{ id: 'k.one', title: 'One', type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: 'x', references: [{ kind: 'file', path: 'src/a.ts' }] }];\n";

function configured(extra: Record<string, string> = {}): string {
  return tree({
    'package.json': JSON.stringify({ name: 'top', version: '0.0.0' }),
    'src/a.ts': 'export const A = 1;\n',
    'sharkcraft/knowledge.ts': ONE_ENTRY,
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'top', knowledgeFiles: ['knowledge.ts'] };\n",
    ...extra,
  });
}

describe('loading 0 entries from the wrong root is not a pass', () => {
  test('from a nested package: 2, the resolved root and the configured ancestor are named', async () => {
    const top = configured({ 'packages/sub/package.json': JSON.stringify({ name: 'sub' }) });
    const sub = join(top, 'packages', 'sub');
    const r = await run(knowledgeStaleCheckCommand, args(sub));
    expect(r.code).toBe(ExitCode.NotVerified);
    expect(r.out).toContain('Loaded 0 knowledge entries.');
    expect(r.out).toContain(`resolved root:       ${sub}`);
    expect(r.out).toContain('sharkcraft/ folder:  missing');
    expect(r.out).toContain(`configured ancestor: ${top} — rerun with --cwd ${top}`);
    expect(r.out).toContain('NOT VERIFIED');
    // --json carries where discovery landed.
    const j = JSON.parse((await run(knowledgeStaleCheckCommand, args(sub, { json: true }))).out);
    expect(j.discovery).toMatchObject({ resolvedRoot: sub, entriesLoaded: 0, configuredAncestor: top, sharkcraftDir: null });
    expect(j.gate.exit).toBe(ExitCode.NotVerified);
    // --allow-empty NEVER clears a missing folder.
    expect((await run(knowledgeStaleCheckCommand, args(sub, { 'allow-empty': true }))).code).toBe(ExitCode.NotVerified);
    // The same root from the configured ancestor is an earned pass.
    expect((await run(knowledgeStaleCheckCommand, args(top))).code).toBe(ExitCode.VerifiedPass);
    // `knowledge list` keeps its exit (a query) but warns where it looked.
    const list = await run(knowledgeListCommand, args(sub));
    expect(list.code).toBe(0);
    expect(list.err).toContain('loaded 0 knowledge entries');
  }, 60_000);

  test('a config that fails to load is never a green — --allow-empty does not clear it', async () => {
    const root = tree({
      'package.json': JSON.stringify({ name: 'bad', version: '0.0.0' }),
      'sharkcraft/knowledge.ts': ONE_ENTRY,
      'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'bad', bogusKey: 1 };\n",
    });
    const r = await run(knowledgeStaleCheckCommand, args(root));
    expect(r.code).toBe(ExitCode.NotVerified);
    expect(r.out).toContain('failed to load');
    expect((await run(knowledgeStaleCheckCommand, args(root, { 'allow-empty': true }))).code).toBe(
      ExitCode.NotVerified,
    );
  }, 60_000);
});

describe('--allow-empty is honoured only for a legitimately empty scope', () => {
  test('a configured repo with no knowledge: 2, and 0 with --allow-empty (printed)', async () => {
    const root = tree({
      'package.json': JSON.stringify({ name: 'empty', version: '0.0.0' }),
      'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'empty' };\n",
    });
    const r = await run(knowledgeStaleCheckCommand, args(root));
    expect(r.code).toBe(ExitCode.NotVerified);
    expect(r.out).toContain('Pass --allow-empty');
    const ok = await run(knowledgeStaleCheckCommand, args(root, { 'allow-empty': true }));
    expect(ok.code).toBe(ExitCode.VerifiedPass);
    expect(ok.out).toContain('accepted by --allow-empty');
  }, 60_000);

  test('a changeset no entry references: 2, and 0 with --allow-empty', async () => {
    const root = configured({ 'README.md': '# readme\n' });
    const r = await run(knowledgeStaleCheckCommand, args(root, { files: 'README.md', json: true }));
    const j = JSON.parse(r.out);
    expect(r.code).toBe(ExitCode.NotVerified);
    expect(j.entries).toBe(1);
    expect(j.entriesInScope).toBe(0);
    expect(
      (await run(knowledgeStaleCheckCommand, args(root, { files: 'README.md', 'allow-empty': true }))).code,
    ).toBe(ExitCode.VerifiedPass);
  }, 60_000);
});

describe('the verb warms before it resolves', () => {
  test('a correct playbook reference is ok — never "playbook not found"', async () => {
    const root = tree({
      'package.json': JSON.stringify({ name: 'pb', version: '0.0.0' }),
      'sharkcraft/playbooks.ts': "export default [{ id: 'pb.real', title: 'Real', steps: [] }];\n",
      'sharkcraft/knowledge.ts':
        "export default [{ id: 'k.pb', title: 'PB', type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: 'x', references: [{ kind: 'playbook', id: 'pb.real' }] }];\n",
      'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'pb', knowledgeFiles: ['knowledge.ts'] };\n",
    });
    const r = await run(knowledgeStaleCheckCommand, args(root, { json: true }));
    const j = JSON.parse(r.out);
    expect(j.referenceChecks[0].outcome).toBe('ok');
    expect(r.code).toBe(ExitCode.VerifiedPass);
  }, 60_000);
});
