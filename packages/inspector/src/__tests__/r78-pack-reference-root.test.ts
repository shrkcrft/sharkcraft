/**
 * r78 — pack reference roots (round 15 follow-up, F7).
 *
 * A pack's reference resolved against the CONSUMER's root only, so a pack doc
 * referencing a file the pack itself ships read STALE in every consumer
 * (`File missing: docs/guide.md`) with a hint to rename a file the consumer
 * does not own. `root: pack` resolves a path-based reference against the
 * contributing pack's package directory (from THE discovered pack list), and
 * `package:` resolves the contributing pack's own name for that pack's
 * entries. `root: pack` on a local entry is a validation error and an INVALID
 * row — never a silent fallback to the project root.
 *
 * Real inspection, real loaders, a real pack under the fixture's node_modules.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { KnowledgeReferenceRoot } from '@shrkcrft/core';
import {
  buildKnowledgeStaleReport,
  ReferenceCheckOutcome,
  type IKnowledgeReferenceCheck,
  type IKnowledgeStaleReport,
} from '../knowledge-stale.ts';
import { KnowledgeEntryVerdict } from '../knowledge-entry-verdict.ts';
import { ReferenceAssetKind } from '../reference-asset-kind.ts';
import { ReferenceFailure } from '../reference-failure.ts';
import { warmReferenceRegistries } from '../reference-registry.ts';
import { inspectSharkcraft, type ISharkcraftInspection } from '../sharkcraft-inspector.ts';

const PACK = '@r78/rootpack';
const PACK_DIR = `node_modules/${PACK}`;
const root = mkdtempSync(join(tmpdir(), 'shrk-r78-packroot-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function md(frontmatter: string): string {
  return `---\n${frontmatter}\n---\n# Guide\n\nAbout the pack.\n`;
}

let insp: ISharkcraftInspection;
let report: IKnowledgeStaleReport;

beforeAll(async () => {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'r78-packroot-consumer', version: '0.0.0', private: true }),
    'src/a.ts': 'export class Foo {}\n',
    'sharkcraft/knowledge.ts':
      'export default [\n' +
      "  { id: 'k.local.ok', title: 'Ok', type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: 'x', references: [{ kind: 'file', path: 'src/a.ts' }] },\n" +
      "  { id: 'k.local.rootpack', title: 'Root pack', type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: 'x', references: [{ kind: 'file', path: 'src/a.ts', root: 'pack' }] },\n" +
      `  { id: 'k.local.pkg', title: 'Pkg', type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: 'x', references: [{ kind: 'package', id: '${PACK}' }] },\n` +
      '];\n',
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'r78-packroot', knowledgeFiles: ['knowledge.ts'] };\n",
    [`${PACK_DIR}/package.json`]: JSON.stringify({ name: PACK, version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }),
    [`${PACK_DIR}/manifest.json`]: JSON.stringify({
      schema: 'sharkcraft.pack/v1',
      info: { name: PACK, version: '0.0.1' },
      contributions: {
        docsFiles: ['./docs/guide.md', './docs/unrooted.md'],
        knowledgeFiles: ['./knowledge.ts'],
        boundaryFiles: ['./boundaries.ts'],
        policyCheckFiles: ['./policies.ts'],
      },
    }),
    [`${PACK_DIR}/docs/guide.md`]: md('id: pack.guide.rooted\nreferences:\n  - kind: file\n    path: docs/guide.md\n    root: pack'),
    [`${PACK_DIR}/docs/unrooted.md`]: md('id: pack.guide.unrooted\nreferences: [file:docs/guide.md]'),
    [`${PACK_DIR}/src/thing.ts`]: 'export class PackThing {}\n',
    [`${PACK_DIR}/knowledge.ts`]:
      'export default [\n' +
      "  { id: 'pack.ts.symbol', title: 'Symbol', type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: 'x', references: [{ kind: 'symbol', symbol: 'PackThing', path: 'src/thing.ts', contains: 'export class PackThing', root: 'pack' }] },\n" +
      "  { id: 'pack.ts.gone', title: 'Gone', type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: 'x', references: [{ kind: 'file', path: 'docs/gone.md', root: 'pack' }] },\n" +
      `  { id: 'pack.ts.self', title: 'Self', type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: 'x', references: [{ kind: 'package', id: '${PACK}' }] },\n` +
      "  { id: 'pack.ts.count', title: 'Count', type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: 'x', references: [{ kind: 'directory', path: 'src', root: 'pack', count: { source: { files: ['src/*.ts'], pattern: 'export class (\\\\w+)' }, expected: 1 } }] },\n" +
      '];\n',
    [`${PACK_DIR}/boundaries.ts`]:
      "export default [{ id: 'pack-rule', title: 'Pack rule', from: ['src/**'], forbiddenImports: ['lodash'], references: [{ kind: 'file', path: 'docs/guide.md', root: 'pack' }] }];\n",
    // A policy check is known only by its declaring FILE — its pack is the valid pack whose directory holds it.
    [`${PACK_DIR}/policies.ts`]:
      "export default [{ id: 'pack-policy', title: 'Pack policy', references: [{ kind: 'file', path: 'docs/guide.md', root: 'pack' }] }];\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  insp = await inspectSharkcraft({ cwd: root });
  await warmReferenceRegistries(insp);
  report = buildKnowledgeStaleReport(insp);
});

function checkOf(entryId: string, r: IKnowledgeStaleReport = report): IKnowledgeReferenceCheck {
  const c = r.referenceChecks.find((x) => x.entryId === entryId);
  if (!c) throw new Error(`no check for ${entryId}: ${r.referenceChecks.map((x) => x.entryId).join(', ')}`);
  return c;
}

function verdictOf(entryId: string, r: IKnowledgeStaleReport = report): string | undefined {
  return r.entryVerdicts.find((v) => v.entryId === entryId)?.verdict;
}

describe('r78 root: pack resolves against the contributing pack directory', () => {
  test('a pack Markdown doc referencing its OWN file verifies with root: pack — the row names the root', () => {
    const c = checkOf('pack.guide.rooted');
    expect(c.outcome).toBe(ReferenceCheckOutcome.Ok);
    expect(c.reference).toMatchObject({ kind: 'file', path: 'docs/guide.md', root: KnowledgeReferenceRoot.Pack });
    expect(c.message).toBe(`File exists: docs/guide.md (root: pack — ${PACK} at ${PACK_DIR})`);
    expect(verdictOf('pack.guide.rooted')).toBe(KnowledgeEntryVerdict.Verified);
  });

  test('the SAME path without root resolves against the consumer root — STALE, and the hint names root: pack', () => {
    const c = checkOf('pack.guide.unrooted');
    expect(c.outcome).toBe(ReferenceCheckOutcome.Stale);
    expect(c.failure).toBe(ReferenceFailure.PathMissing);
    expect(c.suggestion).toContain(`docs/guide.md is shipped inside pack ${PACK} (${PACK_DIR}/docs/guide.md)`);
    expect(c.suggestion).toContain('declare root: pack on this reference');
    // A consumer-tree candidate is never a pack reference's rename.
    expect(c.replaceWith).toBeUndefined();
  });

  test('a pinned symbol + contains, and a count, are read IN the pack', () => {
    expect(checkOf('pack.ts.symbol').outcome).toBe(ReferenceCheckOutcome.Ok);
    const count = checkOf('pack.ts.count');
    expect(count.outcome).toBe(ReferenceCheckOutcome.Ok);
    expect(count.actual).toBe(1);
  });

  test('a missing pack-rooted path is STALE with the root in the row and a fix-it-in-the-pack hint', () => {
    const c = checkOf('pack.ts.gone');
    expect(c.outcome).toBe(ReferenceCheckOutcome.Stale);
    expect(c.message).toContain(`(root: pack — ${PACK} at ${PACK_DIR})`);
    expect(c.suggestion).toContain(`missing from pack ${PACK}`);
    expect(c.replaceWith).toBeUndefined();
  });

  test('a pack boundary rule gets the same resolution (one checker for every asset kind)', () => {
    const c = report.assetReferenceChecks.find((x) => x.entryId === 'pack-rule' && x.implicit !== true);
    expect(c).toMatchObject({ assetKind: ReferenceAssetKind.BoundaryRule, outcome: ReferenceCheckOutcome.Ok });
  });

  test('a pack policy check too — its pack found from the file that declares it', () => {
    const c = report.assetReferenceChecks.find((x) => x.entryId === `pack:${PACK}:pack-policy` && x.implicit !== true);
    expect(c).toMatchObject({ assetKind: ReferenceAssetKind.Policy, outcome: ReferenceCheckOutcome.Ok });
    expect(c?.message).toBe(`File exists: docs/guide.md (root: pack — ${PACK} at ${PACK_DIR})`);
  });
});

describe('r78 package: resolves the contributing pack’s own name for that pack’s entries', () => {
  test('a pack entry naming its own pack is Ok (installed by definition)', () => {
    const c = checkOf('pack.ts.self');
    expect(c.outcome).toBe(ReferenceCheckOutcome.Ok);
    expect(c.message).toBe(`Package exists: ${PACK} (the contributing pack, installed at ${PACK_DIR})`);
  });

  test('a LOCAL entry naming the same pack still reads the consumer root package.json — stale', () => {
    expect(checkOf('k.local.pkg').outcome).toBe(ReferenceCheckOutcome.Stale);
  });
});

describe('r78 root: pack on a local entry is a validation issue and an INVALID row', () => {
  test('the inspection validator reports it (error) and keeps the entry; pack entries carry no root issue', () => {
    const issues = insp.validationIssues.filter((i) => i.message.includes('root: pack'));
    expect(issues.map((i) => [i.entryId, i.code, i.severity])).toEqual([['k.local.rootpack', 'invalid-reference', 'error']]);
    expect(insp.knowledgeEntries.some((e) => e.id === 'k.local.rootpack')).toBe(true);
  });

  test('the stale-check reads the SAME predicate: INVALID / malformed, never the project-root file', () => {
    const c = checkOf('k.local.rootpack');
    expect(c.outcome).toBe(ReferenceCheckOutcome.Invalid);
    expect(c.failure).toBe(ReferenceFailure.Malformed);
    expect(c.message).toContain('sets root: pack, but no pack contributes this entry');
    expect(verdictOf('k.local.rootpack')).toBe(KnowledgeEntryVerdict.Unverifiable);
  });
});

describe('r78 the changeset scope sees a pack-rooted path where it lives', () => {
  test('a change to the pack file puts the root: pack entry in scope; the unrooted one is not', () => {
    const r = buildKnowledgeStaleReport(insp, { changedFiles: [`${PACK_DIR}/docs/thing-not-declaring.md`, `${PACK_DIR}/docs/guide.md`] });
    const inScope = r.entryVerdicts.map((v) => v.entryId);
    expect(inScope).toContain('pack.guide.rooted');
    expect(inScope).not.toContain('pack.guide.unrooted');
  });

  test('a pack file a root: pack reference names — not the entry’s own source — scopes the entry in', () => {
    // pack.ts.symbol is declared in knowledge.ts; only its pack-rooted reference names src/thing.ts.
    const r = buildKnowledgeStaleReport(insp, { changedFiles: [`${PACK_DIR}/src/thing.ts`] });
    expect(r.entryVerdicts.map((v) => v.entryId)).toContain('pack.ts.symbol');
    const consumerSide = buildKnowledgeStaleReport(insp, { changedFiles: ['src/thing.ts'] });
    expect(consumerSide.entryVerdicts.map((v) => v.entryId)).not.toContain('pack.ts.symbol');
  });

  test('a pack-rooted count source is scoped where it is measured — the pack’s tree, never the consumer’s', () => {
    // pack.ts.count counts `src/*.ts` INSIDE the pack; its reference path is the pack's `src` dir too, so
    // pin the glob: a consumer `src/b.ts` matches `src/*.ts` literally, and must not scope the pack's count in.
    const consumerSide = buildKnowledgeStaleReport(insp, { changedFiles: ['src/b.ts'] });
    expect(consumerSide.entryVerdicts.map((v) => v.entryId)).not.toContain('pack.ts.count');
    const packSide = buildKnowledgeStaleReport(insp, { changedFiles: [`${PACK_DIR}/src/other.ts`] });
    expect(packSide.entryVerdicts.map((v) => v.entryId)).toContain('pack.ts.count');
  });

  test('a consumer file at the same relative path touches the project-rooted reference only', () => {
    const r = buildKnowledgeStaleReport(insp, { changedFiles: ['docs/guide.md'] });
    const inScope = r.entryVerdicts.map((v) => v.entryId);
    expect(inScope).toContain('pack.guide.unrooted');
    expect(inScope).not.toContain('pack.guide.rooted');
  });
});
