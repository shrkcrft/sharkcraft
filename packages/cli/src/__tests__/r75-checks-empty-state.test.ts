/**
 * Round 11 §4.6 — `shrk checks` empty states that contradicted their own
 * registry. `checks list` printed "(no checks declared — add metadata.checks[]
 * to a rule)" after a filter excluded everything, next to invalid / dropped
 * declarations text mode never rendered, and on an empty registry without
 * naming the files it reads; `checks doctor` printed "No descriptor issues. ✓"
 * and exited 0 over zero checks.
 *
 * Now: every dropped declaration is named with its file and reason (exit 1); a
 * filter that matches nothing says so; `--rule` must name a rule (exit 3, with
 * a did-you-mean from the reference registry); the empty state names the
 * concrete files; the doctor over nothing is NOT VERIFIED (exit 2).
 *
 * Real workspaces, the real inspector, the real command handlers.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ParsedArgs } from '../command-registry.ts';
import { checksDoctorCommand, checksListCommand, checksRunCommand } from '../commands/checks.command.ts';
import { ExitCode } from '../exit-codes.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function args(root: string, positional: string[] = [], flags: Record<string, string | boolean> = {}): ParsedArgs {
  return {
    positional,
    flags: new Map<string, string | boolean>([['cwd', root], ...Object.entries(flags)]),
    multiFlags: new Map(
      Object.entries(flags)
        .filter((kv): kv is [string, string] => typeof kv[1] === 'string')
        .map(([k, v]) => [k, [v]]),
    ),
  };
}

interface IRun {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function run(h: { run(a: ParsedArgs): Promise<number> | number }, a: ParsedArgs): Promise<IRun> {
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

function workspace(config: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-checks-cli-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(join(root, 'sharkcraft', 'sharkcraft.config.ts'), `export default { projectName: 'fx', ${config} };\n`);
  return root;
}

const entry = (id: string, type: string, extra = ''): string =>
  `{ id: '${id}', title: '${id}', type: '${type}', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: 'x'${extra} }`;
const VALID_CHECK = ", metadata: { checks: [{ id: 'check.valid', command: 'echo ok', kind: 'text-shape', safety: 'read-only' }] }";

/** Only declarations the registry cannot use: object-valued checks, checks on a convention, a Markdown rule. */
const dropped = (): string =>
  workspace("ruleFiles: ['rules.ts', 'md-rule.md'], knowledgeFiles: ['knowledge.ts']", {
    'sharkcraft/rules.ts':
      `export default [\n  ${entry('r.non-array', 'rule', ", metadata: { checks: { id: 'obj-check', command: 'echo' } }")},\n  ${entry('r.plain', 'rule')},\n];\n`,
    'sharkcraft/knowledge.ts':
      `export default [\n  ${entry('k.convention-with-checks', 'convention', ", metadata: { checks: [{ id: 'on-convention', command: 'echo' }] }")},\n];\n`,
    'sharkcraft/md-rule.md':
      '---\nid: md.rule-with-checks\ntitle: MD rule\ntype: rule\nmetadata: {"checks": [{"id": "md-check", "command": "echo"}]}\n---\n# MD rule\n\nBody.\n',
  });

/** One valid check on r.valid; r.plain and a knowledge note declare none. */
const valid = (): string =>
  workspace("ruleFiles: ['rules.ts'], knowledgeFiles: ['knowledge.ts']", {
    'sharkcraft/rules.ts': `export default [\n  ${entry('r.valid', 'rule', VALID_CHECK)},\n  ${entry('r.plain', 'rule')},\n];\n`,
    'sharkcraft/knowledge.ts': `export default [\n  ${entry('k.note', 'technical')},\n];\n`,
  });

/** A rule file whose rule declares no checks at all. */
const empty = (): string =>
  workspace("ruleFiles: ['rules.ts']", { 'sharkcraft/rules.ts': `export default [\n  ${entry('r.plain', 'rule')},\n];\n` });

describe('checks list — never a false "nothing declared"', () => {
  test('only dropped declarations: each is named with its file and reason, exit 1', async () => {
    const root = dropped();
    const r = await run(checksListCommand, args(root));
    expect(r.code).toBe(ExitCode.Failure);
    expect(r.out).not.toMatch(/no checks declared/i);
    for (const s of [
      'r.non-array',
      'sharkcraft/rules.ts',
      'metadata.checks must be an array (got object)',
      'k.convention-with-checks [type:convention]',
      'sharkcraft/knowledge.ts',
      "only type:'rule' entries carry checks",
      'md.rule-with-checks',
      'sharkcraft/md-rule.md',
      'Markdown loader does not support metadata',
    ]) {
      expect({ s, has: r.out.includes(s) }).toEqual({ s, has: true });
    }
    const j = await run(checksListCommand, args(root, [], { json: true }));
    const parsed = JSON.parse(j.out);
    expect([j.code, parsed.exitCode]).toEqual([ExitCode.Failure, ExitCode.Failure]);
    expect(parsed.ignored.map((i: { entryId: string }) => i.entryId).sort()).toEqual([
      'k.convention-with-checks',
      'md.rule-with-checks',
    ]);
    expect(parsed.scannedRules).toBe(3);
  }, 60_000);

  test('a filter that excludes everything says so — declared N, 0 match', async () => {
    const root = valid();
    const byKind = await run(checksListCommand, args(root, [], { kind: 'txt-shape' }));
    expect(byKind.code).toBe(ExitCode.VerifiedPass);
    expect(byKind.out).toContain('1 check declared, 0 match --kind txt-shape');
    expect(byKind.out).toContain('known kinds: import-graph');
    const byRule = await run(checksListCommand, args(root, [], { rule: 'r.plain' }));
    expect(byRule.code).toBe(ExitCode.VerifiedPass);
    expect(byRule.out).toContain('1 check declared, 0 match --rule r.plain');
  }, 60_000);

  test('--rule must name a rule: an unknown id or a non-rule id is a usage error (3)', async () => {
    const root = valid();
    const unknown = await run(checksListCommand, args(root, [], { rule: 'r.does-not-exist' }));
    expect(unknown.code).toBe(ExitCode.UsageError);
    expect(unknown.err).toContain(`no type:'rule' entry has the id "r.does-not-exist"`);
    const typo = await run(checksListCommand, args(root, [], { rule: 'r.vaild' }));
    expect(typo.err).toContain('Did you mean: r.valid');
    const notRule = await run(checksListCommand, args(root, [], { rule: 'k.note' }));
    expect(notRule.code).toBe(ExitCode.UsageError);
    expect(notRule.err).toContain("not a type:'rule' entry");
    expect(notRule.err).toContain('knowledge');
  }, 60_000);

  test('truly empty: names the concrete file it reads and the Markdown limitation, exit 0', async () => {
    const r = await run(checksListCommand, args(empty()));
    expect(r.code).toBe(ExitCode.VerifiedPass);
    expect(r.out).toContain('No checks declared.');
    expect(r.out).toMatch(/ruleFiles\s+sharkcraft\/rules\.ts/);
    expect(r.out).toContain('Markdown rules cannot carry metadata');
    expect(r.out).toContain("Scanned 1 type:'rule' entry");
  }, 60_000);
});

describe('checks doctor — an empty registry is not a validated one', () => {
  test('nothing declared → NOT VERIFIED, exit 2 in text and JSON; --allow-empty accepts it', async () => {
    const root = empty();
    const t = await run(checksDoctorCommand, args(root));
    expect(t.code).toBe(ExitCode.NotVerified);
    expect(t.out).toContain('No checks declared — nothing validated');
    expect(t.out).toContain('NOT VERIFIED');
    expect(t.out).not.toContain('✓');
    expect(t.out).toContain('Pass --allow-empty');
    const j = await run(checksDoctorCommand, args(root, [], { json: true }));
    const parsed = JSON.parse(j.out);
    expect([j.code, parsed.exitCode, parsed.verdict]).toEqual([ExitCode.NotVerified, ExitCode.NotVerified, 'not-verified']);
    expect(parsed.schema).toBe('sharkcraft.custom-checks-doctor/v1');
    expect([parsed.ignored, parsed.scannedRules, parsed.coverage.expected]).toEqual([0, 1, 0]);
    const accepted = await run(checksDoctorCommand, args(root, [], { 'allow-empty': true }));
    expect(accepted.code).toBe(ExitCode.VerifiedPass);
    expect(accepted.out).toContain('No checks declared — accepted.');
    expect(accepted.out).toContain('accepted by --allow-empty');
  }, 60_000);

  test('only dropped declarations → exit 1, each listed as an error', async () => {
    const root = dropped();
    const t = await run(checksDoctorCommand, args(root));
    expect(t.code).toBe(ExitCode.Failure);
    expect(t.out).toContain('Details:');
    expect(t.out).toContain('[on-convention] (k.convention-with-checks) sharkcraft/knowledge.ts');
    const parsed = JSON.parse((await run(checksDoctorCommand, args(root, [], { json: true }))).out);
    expect([parsed.exitCode, parsed.errors, parsed.ignored]).toEqual([ExitCode.Failure, 3, 2]);
  }, 60_000);

  test('a valid registry passes with a clean line', async () => {
    const t = await run(checksDoctorCommand, args(valid()));
    expect(t.code).toBe(ExitCode.VerifiedPass);
    expect(t.out).toContain('1 check descriptor(s) validated — no issues. ✓');
  }, 60_000);
});

describe('checks run — a declared-but-ignored id says where it went', () => {
  test('a check declared on a convention names the entry, its type, its file and why', async () => {
    const r = await run(checksRunCommand, args(dropped(), ['on-convention']));
    expect(r.code).toBe(ExitCode.Failure);
    expect(r.err).toContain(`is declared on k.convention-with-checks (type:'convention', sharkcraft/knowledge.ts)`);
    expect(r.err).toContain("only type:'rule' entries carry checks");
  }, 60_000);

  test('no id is a usage error (3); a registered check previews (0)', async () => {
    expect((await run(checksRunCommand, args(valid()))).code).toBe(ExitCode.UsageError);
    const ok = await run(checksRunCommand, args(valid(), ['check.valid']));
    expect(ok.code).toBe(ExitCode.VerifiedPass);
    expect(ok.out).toContain('Custom check: check.valid');
  }, 60_000);
});
