/**
 * Round 11 §4.6 — the custom-checks registry skipped every declaration it did
 * not read WITHOUT A TRACE: `metadata.checks` on a non-rule entry, a Markdown
 * rule (whose loader drops `metadata`), a non-array value. `checks list` then
 * said "no checks declared" next to declarations the author could see.
 *
 * Each is now reported — `ignored` / `invalid`, with the file and why — and the
 * set of rules scanned is `isRuleEntry`, the same predicate `shrk rules list`
 * reads (one authority, asserted here as a property).
 *
 * Real registries: a temp workspace with a real config, loaded by the real
 * inspector.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isRuleEntry } from '@shrkcrft/rules';
import {
  buildCustomChecksRegistry,
  customCheckScanSurface,
  declaredCustomCheckCount,
  doctorCustomChecks,
} from '../custom-checks.ts';
import { inspectSharkcraft, type ISharkcraftInspection } from '../sharkcraft-inspector.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function workspace(config: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-checks-'));
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

const FILES: Record<string, string> = {
  'sharkcraft/rules.ts':
    'export default [\n' +
    `  ${entry('r.valid', 'rule', ", metadata: { checks: [{ id: 'check.valid', command: 'echo ok', kind: 'text-shape', safety: 'read-only' }] }")},\n` +
    `  ${entry('r.non-array', 'rule', ", metadata: { checks: { id: 'obj-check', command: 'echo' } }")},\n` +
    `  ${entry('r.plain', 'rule')},\n` +
    '];\n',
  'sharkcraft/knowledge.ts':
    'export default [\n' +
    `  ${entry('k.convention-with-checks', 'convention', ", metadata: { checks: [{ id: 'on-convention', command: 'echo' }] }")},\n` +
    `  ${entry('k.note', 'technical')},\n` +
    '];\n',
  'sharkcraft/md-rule.md':
    '---\nid: md.rule-with-checks\ntitle: MD rule with checks\ntype: rule\n' +
    'metadata: {"checks": [{"id": "md-check", "command": "echo"}]}\n---\n# MD rule with checks\n\nBody.\n',
  'sharkcraft/md-plain.md': '---\nid: md.plain-rule\ntitle: MD plain rule\ntype: rule\n---\n# MD plain\n\nBody.\n',
};

let insp: ISharkcraftInspection;
beforeAll(async () => {
  const root = workspace("ruleFiles: ['rules.ts', 'md-rule.md', 'md-plain.md'], knowledgeFiles: ['knowledge.ts']", FILES);
  insp = await inspectSharkcraft({ cwd: root });
});

describe('every declaration the registry does not read is reported', () => {
  test('one valid check registers; the non-array rule is invalid; the convention and Markdown rule are ignored', () => {
    const reg = buildCustomChecksRegistry(insp.knowledgeEntries, { projectRoot: insp.projectRoot });
    expect(reg.entries.map((e) => e.descriptor.id)).toEqual(['check.valid']);
    expect(reg.invalid).toEqual([
      { ruleId: 'r.non-array', reason: 'metadata.checks must be an array (got object)', source: 'sharkcraft/rules.ts' },
    ]);
    const byId = new Map(reg.ignored.map((i) => [i.entryId, i] as const));
    expect(byId.get('k.convention-with-checks')).toMatchObject({
      entryType: 'convention',
      source: 'sharkcraft/knowledge.ts',
      checkIds: ['on-convention'],
    });
    expect(byId.get('k.convention-with-checks')?.reason).toContain("only type:'rule' entries carry checks");
    expect(byId.get('md.rule-with-checks')).toMatchObject({ entryType: 'rule', source: 'sharkcraft/md-rule.md' });
    expect(byId.get('md.rule-with-checks')?.reason).toContain('Markdown loader does not support metadata');
    // A Markdown rule with no metadata is not a dropped declaration.
    expect(byId.has('md.plain-rule')).toBe(false);
    expect(reg.ignored.length).toBe(2);
  });

  test('the Markdown loader said it dropped the key (inspection.warnings → doctor "Loader warning")', () => {
    expect(insp.warnings.some((w) => w.includes('md-rule.md: frontmatter key "metadata" was dropped'))).toBe(true);
  });

  test('the doctor makes every dropped declaration an error, and counts what was declared', () => {
    const reg = buildCustomChecksRegistry(insp.knowledgeEntries, { projectRoot: insp.projectRoot });
    const report = doctorCustomChecks(reg);
    expect(report.errors).toBe(3);
    // 1 registered + 1 invalid + 1 ignored id (on-convention) + 1 ignored Markdown rule (ids unreadable).
    expect(report.declaredChecks).toBe(4);
    expect(declaredCustomCheckCount(reg)).toBe(4);
    expect(report.details.find((d) => d.ruleId === 'k.convention-with-checks')).toMatchObject({
      checkId: 'on-convention',
      severity: 'error',
      source: 'sharkcraft/knowledge.ts',
    });
  });
});

describe('one authority for "is this a rule"', () => {
  test('the rules the registry scans are exactly the rules `shrk rules list` shows', () => {
    const reg = buildCustomChecksRegistry(insp.knowledgeEntries);
    const listed = insp.ruleService.list().map((r) => r.id).sort();
    expect(reg.scannedRules).toBe(listed.length);
    expect(listed).toEqual(insp.knowledgeEntries.filter((e) => isRuleEntry(e)).map((e) => e.id).sort());
    expect(listed).toEqual(['md.plain-rule', 'md.rule-with-checks', 'r.non-array', 'r.plain', 'r.valid']);
    expect(listed).not.toContain('k.convention-with-checks');
  });
});

describe('the scanned surface is named concretely', () => {
  test('TypeScript rule / knowledge files are scanned; Markdown sources are named apart', () => {
    const s = customCheckScanSurface(insp);
    expect(s.files).toEqual([
      { file: 'sharkcraft/rules.ts', via: 'ruleFiles' },
      { file: 'sharkcraft/knowledge.ts', via: 'knowledgeFiles' },
    ]);
    expect(s.markdownFiles).toEqual(['sharkcraft/md-rule.md', 'sharkcraft/md-plain.md']);
    expect(s.markdownRules).toBe(2);
  });
});
