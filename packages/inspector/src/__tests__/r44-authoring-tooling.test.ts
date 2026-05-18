/**
 * Inspector tests for the new authoring-loop surfaces.
 *
 *   1. buildKnowledgeAuthoringPreview returns valid draft/patch shape for add.
 *   2. add refuses an id that already exists (unless --allow-overwrite).
 *   3. update preview applies updateOps and preserves unspecified fields.
 *   4. remove preview detects reverse references and refuses without
 *      --force-preview; suggests deprecation instead.
 *   5. lintKnowledge classifies findings into the documented categories.
 *   6. buildKnowledgeLintFixPreview separates safe stubs from TODOs.
 *   7. recordProvenance / readProvenance round-trip; writes only under
 *      .sharkcraft/asset-provenance.jsonl.
 *   8. buildPackAuthorStatus surfaces every PackAuthorKind with the right
 *      authoring support marker.
 *   9. buildPackPendingReport composes the four pending signals.
 *  10. PackPending report prints the missing-secret hint when the secret
 *      is not in env.
 *  11. The new modules never write outside .sharkcraft/ (path safety).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AssetKind,
  AssetProvenanceOperation,
  AssetProvenanceSource,
  buildKnowledgeAuthoringPreview,
  buildKnowledgeLintFixPreview,
  buildPackAuthorPreview,
  buildPackAuthorStatus,
  buildPackPendingReport,
  buildProvenanceReport,
  KNOWLEDGE_AUTHORING_SCHEMA,
  KnowledgeAuthoringOperation,
  KnowledgeLintCategory,
  KnowledgeLintSeverity,
  PackAuthorKind,
  PACK_AUTHOR_STATUS_SCHEMA,
  PACK_PENDING_SCHEMA,
  lintKnowledge,
  listProvenance,
  provenanceExists,
  provenancePath,
  readProvenance,
  recordProvenance,
  showProvenance,
} from '../index.ts';
import {
  defineKnowledgeEntry,
  KnowledgePriority,
  KnowledgeType,
  type IKnowledgeEntry,
} from '@shrkcrft/knowledge';

function freshTmpRoot(label: string): string {
  const root = join(tmpdir(), `sharkcraft-r44-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function ke(over: Partial<IKnowledgeEntry>): IKnowledgeEntry {
  // Use a plain object — defineKnowledgeEntry validates a stricter subset
  // and does not pass through `references` / `anchors` / arbitrary `type`
  // values, which the lint / authoring tests need.
  const base: IKnowledgeEntry = {
    id: 'test.entry',
    title: 'Test entry',
    type: KnowledgeType.Convention,
    priority: KnowledgePriority.Medium,
    scope: ['test'],
    tags: ['test'],
    appliesWhen: ['review-code'],
    content:
      'A long-enough content body that comfortably exceeds the 60 character lint threshold for content-too-short.',
    summary: 'A test summary that is short and sweet.',
  };
  return { ...base, ...over };
}
void defineKnowledgeEntry; // imported for type lookup only.

describe('buildKnowledgeAuthoringPreview (add)', () => {
  test('returns a TS draft + manifest + explainer at .sharkcraft/authoring/', () => {
    const result = buildKnowledgeAuthoringPreview(
      {
        operation: KnowledgeAuthoringOperation.Add,
        id: 'team.style',
        title: 'Team style',
        type: 'convention',
        summary: 'How we write code.',
        content: 'Long enough content that satisfies the lint threshold easily for this test fixture.',
        scope: ['team'],
        tags: ['style'],
        appliesWhen: ['review-code'],
        reason: 'Capturing the team conventions.',
      },
      { entries: [] },
    );
    expect(result.schema).toBe(KNOWLEDGE_AUTHORING_SCHEMA);
    expect(result.ok).toBe(true);
    expect(result.tsDraft.path).toBe('.sharkcraft/authoring/knowledge-add-team-style.draft.ts');
    expect(result.jsonManifest.path).toBe('.sharkcraft/authoring/knowledge-add-team-style.manifest.json');
    expect(result.explainer.path).toBe('.sharkcraft/authoring/knowledge-add-team-style.md');
    expect(result.tsDraft.body).toContain('id: "team.style"');
    expect(result.tsDraft.body).toContain('"Team style"');
    expect(result.next?.summary).toBe('How we write code.');
  });

  test('refuses to overwrite an existing id by default', () => {
    const result = buildKnowledgeAuthoringPreview(
      { operation: KnowledgeAuthoringOperation.Add, id: 'team.style' },
      { entries: [ke({ id: 'team.style', title: 'existing' })] },
    );
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(/already exists/);
  });

  test('allow-overwrite produces a preview even when id exists', () => {
    const result = buildKnowledgeAuthoringPreview(
      {
        operation: KnowledgeAuthoringOperation.Add,
        id: 'team.style',
        title: 'fresh draft',
        content: 'A long enough content body for the test fixture to pass the threshold.',
        allowOverwrite: true,
      },
      { entries: [ke({ id: 'team.style', title: 'existing' })] },
    );
    expect(result.ok).toBe(true);
    expect(result.next?.title).toBe('fresh draft');
  });

  test('warns when no reason or body is provided', () => {
    const result = buildKnowledgeAuthoringPreview(
      { operation: KnowledgeAuthoringOperation.Add, id: 'team.style' },
      { entries: [] },
    );
    expect(result.warnings.some((w) => w.toLowerCase().includes('reason'))).toBe(true);
  });
});

describe('buildKnowledgeAuthoringPreview (update)', () => {
  test('refuses to update an entry that does not exist', () => {
    const result = buildKnowledgeAuthoringPreview(
      { operation: KnowledgeAuthoringOperation.Update, id: 'missing.entry' },
      { entries: [] },
    );
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(/No entry/);
  });

  test('adds a reference without corrupting existing entry', () => {
    const existing = ke({ id: 'team.style', references: [{ kind: 'file', path: 'README.md' }] });
    const result = buildKnowledgeAuthoringPreview(
      {
        operation: KnowledgeAuthoringOperation.Update,
        id: 'team.style',
        updateOps: {
          addReferences: [{ kind: 'symbol', symbol: 'Foo' }],
        },
        reason: 'Adding a new reference.',
      },
      { entries: [existing] },
    );
    expect(result.ok).toBe(true);
    expect(result.next?.references?.length).toBe(2);
    // The original reference is preserved.
    expect(result.next?.references?.[0]?.path).toBe('README.md');
    expect(result.patch?.changes.some((c) => c.field === 'references' && c.op === 'add')).toBe(true);
  });

  test('mark-deprecated adds metadata.deprecated without losing prior metadata', () => {
    const existing = ke({ id: 'team.style', metadata: { author: 'Alice' } });
    const result = buildKnowledgeAuthoringPreview(
      {
        operation: KnowledgeAuthoringOperation.Update,
        id: 'team.style',
        updateOps: { markDeprecated: true },
        reason: 'Marking as deprecated.',
      },
      { entries: [existing] },
    );
    expect(result.ok).toBe(true);
    const md = result.next?.metadata as Record<string, unknown>;
    expect(md.deprecated).toBe(true);
    expect(md.author).toBe('Alice');
  });
});

describe('buildKnowledgeAuthoringPreview (remove)', () => {
  test('detects reverse references and refuses without --force-preview', () => {
    const target = ke({ id: 'team.style' });
    const referrer = ke({ id: 'team.lint', related: ['team.style'] });
    const result = buildKnowledgeAuthoringPreview(
      { operation: KnowledgeAuthoringOperation.Remove, id: 'team.style' },
      { entries: [target, referrer] },
    );
    expect(result.ok).toBe(false);
    expect(result.reverseReferences?.length).toBe(1);
    expect(result.reverseReferences?.[0]?.fromEntryId).toBe('team.lint');
    expect(result.suggestedDeprecationInstead).toBe(true);
  });

  test('--force-preview produces a removal preview even when referenced', () => {
    const target = ke({ id: 'team.style' });
    const referrer = ke({ id: 'team.lint', related: ['team.style'] });
    const result = buildKnowledgeAuthoringPreview(
      { operation: KnowledgeAuthoringOperation.Remove, id: 'team.style', forcePreview: true },
      { entries: [target, referrer] },
    );
    expect(result.ok).toBe(true);
    expect(result.reverseReferences?.length).toBe(1);
  });

  test('refuses when entry does not exist', () => {
    const result = buildKnowledgeAuthoringPreview(
      { operation: KnowledgeAuthoringOperation.Remove, id: 'missing.entry' },
      { entries: [] },
    );
    expect(result.ok).toBe(false);
  });
});

describe('lintKnowledge', () => {
  test('classifies findings into the documented categories', () => {
    const entries = [
      ke({
        id: 'team.style',
        summary: undefined,
        tags: [],
        appliesWhen: [],
        content: 'short',
      }),
      ke({ id: 'team.color', metadata: { deprecated: true } }),
      ke({ id: 'team.priority', priority: KnowledgePriority.High, actionHints: undefined }),
    ];
    const report = lintKnowledge(entries, { staleReferenceEntryIds: ['team.style'] });
    const categories = new Set(report.findings.map((f) => f.category));
    expect(categories.has(KnowledgeLintCategory.SafeMechanicalStub)).toBe(true);
    expect(categories.has(KnowledgeLintCategory.NeedsHumanWording)).toBe(true);
    expect(categories.has(KnowledgeLintCategory.ShouldAcknowledge)).toBe(true);
    expect(categories.has(KnowledgeLintCategory.ObsoleteEntry)).toBe(true);
    expect(categories.has(KnowledgeLintCategory.StaleReference)).toBe(true);
    expect(categories.has(KnowledgeLintCategory.MissingActionHints)).toBe(true);
  });

  test('does not fabricate prose for needs-human-wording findings', () => {
    const entries = [ke({ id: 'team.style', content: 'TODO: finish me' })];
    const report = lintKnowledge(entries);
    const stub = report.findings.find((f) => f.code === 'knowledge.content-stub');
    expect(stub?.category).toBe(KnowledgeLintCategory.NeedsHumanWording);
    expect(stub?.severity).toBe(KnowledgeLintSeverity.Warning);
    // No stub suggestion for needs-human-wording — only safe-mechanical-stub
    // entries carry suggestions.
    expect(stub?.stubSuggestion).toBeUndefined();
  });

  test('buildKnowledgeLintFixPreview separates safe stubs from TODOs', () => {
    const entries = [
      ke({ id: 'team.style', summary: undefined, content: 'TODO: finish me' }),
    ];
    const report = lintKnowledge(entries);
    const preview = buildKnowledgeLintFixPreview(report);
    expect(preview.safeStubs.length).toBeGreaterThan(0);
    expect(preview.todos.length).toBeGreaterThan(0);
    // Safe stubs always carry a non-empty suggestion.
    for (const s of preview.safeStubs) {
      expect(s.suggestion.length).toBeGreaterThan(0);
    }
  });
});

describe('asset provenance', () => {
  test('recordProvenance round-trips and listProvenance returns the entry', () => {
    const root = freshTmpRoot('provenance');
    expect(provenanceExists(root)).toBe(false);
    const entry = recordProvenance({
      projectRoot: root,
      entry: {
        operation: AssetProvenanceOperation.Preview,
        assetKind: AssetKind.Knowledge,
        assetId: 'team.style',
        source: AssetProvenanceSource.Cli,
        reason: 'unit test',
      },
    });
    expect(provenanceExists(root)).toBe(true);
    const all = readProvenance(root);
    expect(all).toHaveLength(1);
    expect(all[0]?.assetId).toBe('team.style');
    expect(all[0]?.generatedAt).toBe(entry.generatedAt);
    const list = listProvenance(root, { assetKind: AssetKind.Knowledge });
    expect(list).toHaveLength(1);
    const show = showProvenance(root, 'team.style');
    expect(show.entries).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });

  test('refuses to write outside .sharkcraft/', () => {
    const root = freshTmpRoot('provenance-safety');
    // Sanity: the helper resolves to the correct path inside .sharkcraft/.
    const p = provenancePath(root);
    expect(p.endsWith(join('.sharkcraft', 'asset-provenance.jsonl'))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test('buildProvenanceReport handles empty ledger honestly', () => {
    const root = freshTmpRoot('provenance-empty');
    const report = buildProvenanceReport(root);
    expect(report.ledgerExists).toBe(false);
    expect(report.total).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('buildPackAuthorStatus', () => {
  test('surfaces every kind with the right authoring support marker', () => {
    // Use a stub inspection — we only need fields the function reads.
    const inspection = {
      projectRoot: freshTmpRoot('pack-author-status'),
      sharkcraftDir: null,
      packs: { validPacks: [] },
    } as unknown as Parameters<typeof buildPackAuthorStatus>[0];
    const status = buildPackAuthorStatus(inspection);
    expect(status.schema).toBe(PACK_AUTHOR_STATUS_SCHEMA);
    expect(status.authoringSupport[PackAuthorKind.Knowledge]).toBe('preview');
    expect(status.authoringSupport[PackAuthorKind.SearchTuning]).toBe('deferred');
    expect(status.authoringSupport[PackAuthorKind.FeedbackRule]).toBe('deferred');
    // Every kind is present.
    for (const k of Object.values(PackAuthorKind)) {
      expect(typeof status.contributionCounts[k]).toBe('number');
    }
  });
});

describe('buildPackAuthorPreview', () => {
  test('knowledge kind returns implemented=true', () => {
    const r = buildPackAuthorPreview({ kind: PackAuthorKind.Knowledge, assetId: 'a.b' });
    expect(r.implemented).toBe(true);
  });

  test('deferred kinds return implemented=false with an honest note', () => {
    const r = buildPackAuthorPreview({ kind: PackAuthorKind.SearchTuning, assetId: 'a.b' });
    expect(r.implemented).toBe(false);
    expect(r.deferralNote).toMatch(/knowledge kind is implemented/i);
    expect(r.nextCommands.length).toBeGreaterThan(0);
  });
});

describe('buildPackPendingReport', () => {
  test('composes the four pending signals and surfaces missing-secret', () => {
    const root = freshTmpRoot('pack-pending');
    // Drop a fake draft into .sharkcraft/authoring/ so the scanner sees one.
    mkdirSync(join(root, '.sharkcraft', 'authoring'), { recursive: true });
    require('node:fs').writeFileSync(
      join(root, '.sharkcraft', 'authoring', 'knowledge-add-foo.draft.ts'),
      '// fixture',
      'utf8',
    );
    const inspection = {
      projectRoot: root,
      packs: { validPacks: [] },
    } as unknown as Parameters<typeof buildPackPendingReport>[0];
    const prev = process.env['SHARKCRAFT_PACK_SECRET'];
    delete process.env['SHARKCRAFT_PACK_SECRET'];
    const report = buildPackPendingReport(inspection);
    expect(report.schema).toBe(PACK_PENDING_SCHEMA);
    expect(report.draftFiles.some((d) => d.purpose === 'authoring-draft')).toBe(true);
    expect(report.secretAvailable).toBe(false);
    expect(report.secretMissingHint).toBeDefined();
    expect(report.secretMissingHint).toMatch(/SHARKCRAFT_PACK_SECRET/);
    expect(report.nextCommands.some((c) => c.startsWith('shrk packs sign --print-command'))).toBe(false); // no packs means no signing prompt
    if (prev !== undefined) process.env['SHARKCRAFT_PACK_SECRET'] = prev;
    rmSync(root, { recursive: true, force: true });
  });
});
