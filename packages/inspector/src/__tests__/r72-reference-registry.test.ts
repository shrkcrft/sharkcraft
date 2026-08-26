import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IDocReferenceRule } from '@shrkcrft/core';
import { type ITemplateDefinition, TemplateRegistry } from '@shrkcrft/templates';
import { type IPipelineDefinition, PipelineRegistry } from '@shrkcrft/pipelines';
import { clearFileReadCache } from '@shrkcrft/boundaries';
import { checkDocReferences } from '../doc-references.ts';
import { buildKnowledgeStaleReport, ReferenceCheckOutcome } from '../knowledge-stale.ts';
import { listConstructs } from '../construct-registry.ts';
import { listPlaybooks } from '../playbook-registry.ts';
import { listPolicyIds } from '../policy-registry.ts';
import {
  emptyReferenceKinds,
  referenceIdExists,
  referenceIdsFor,
  warmReferenceRegistries,
  type DocReferenceKind,
} from '../reference-registry.ts';
import type { ISharkcraftInspection } from '../sharkcraft-inspector.ts';

/**
 * `list` and `resolve` must agree — the class of bug, not one instance.
 *
 * The round-6 doc-reference plane reported CORRECT playbook ids as unresolved.
 * The cause was not a missing wire-up but an unchecked structural cast: five
 * call sites read `inspection.playbookRegistry`, a property no production code
 * ever assigns. A cast to a hoped-for shape type-checks perfectly and then
 * answers "nothing exists" forever, so a gate confidently flags correct usage —
 * the fastest possible way to get a gate switched off.
 *
 * These tests hold the property that would have caught it: every id a registry
 * LISTS, the resolver RESOLVES.
 */

let root: string;
let inspection: ISharkcraftInspection;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'shrk-refreg-'));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(
    join(root, 'sharkcraft', 'playbooks.ts'),
    "export default [\n" +
      "  { id: 'nge.add-renderer-feature', title: 'Add a renderer feature', steps: [] },\n" +
      "  { id: 'nge.migrate-v2', title: 'Migrate to v2', steps: [] },\n" +
      '];\n',
  );
  writeFileSync(
    join(root, 'sharkcraft', 'constructs.ts'),
    "export default [{ id: 'nge.renderer', type: 'feature', title: 'Renderer' }];\n",
  );
  writeFileSync(
    join(root, 'sharkcraft', 'policies.ts'),
    "export default [{ id: 'no-deep-imports', title: 'No deep imports' }];\n",
  );
  inspection = {
    projectRoot: root,
    sharkcraftDir: join(root, 'sharkcraft'),
    config: null,
    packs: { validPacks: [] },
    // The REGISTRIES, because that is what `shrk templates list` /
    // `shrk pipelines list` read. A fixture that supplies only the raw
    // `templates` array tests a source the list verb does not use.
    templateRegistry: new TemplateRegistry([
      { id: 'nge.angular-component' } as unknown as ITemplateDefinition,
    ]),
    pipelineRegistry: new PipelineRegistry([
      { id: 'nge.feature-dev' } as unknown as IPipelineDefinition,
    ]),
    knowledgeEntries: [],
  } as unknown as ISharkcraftInspection;
  await warmReferenceRegistries(inspection);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function doc(rel: string, content: string): void {
  writeFileSync(join(root, rel), content);
  clearFileReadCache();
}

const RULE: IDocReferenceRule = {
  id: 'pb',
  files: ['docs/**/*.md'],
  tokenPattern: '(?<![\\w./-])nge[.-][a-z0-9-]+\\b',
  resolvesAs: ['playbook'],
  requireContext: 'off',
};

describe('list ⟷ resolve agreement', () => {
  test('every id the PLAYBOOK registry lists, the resolver resolves', () => {
    const listed = listPlaybooks(inspection).map((p) => p.id);
    expect(listed).toContain('nge.add-renderer-feature');
    for (const id of listed) {
      expect(referenceIdExists(inspection, 'playbook', id)).toBe(true);
    }
  });

  test('every id the CONSTRUCT registry lists, the resolver resolves', () => {
    const listed = listConstructs(inspection).map((c) => c.id);
    expect(listed).toContain('nge.renderer');
    for (const id of listed) {
      expect(referenceIdExists(inspection, 'construct', id)).toBe(true);
    }
  });

  test('every id the POLICY registry lists, the resolver resolves', () => {
    // Listing must not require RUNNING the checks — `evaluatePolicy` executes
    // each declaration against the tree, which is the wrong price for "does
    // this id exist?" and the wrong side effect for a doc linter.
    const listed = listPolicyIds(inspection);
    // Both names: the id the author declared and cites, and the namespaced one
    // `evaluatePolicy` reports. Listing only the latter makes every reference
    // in the repo read as unknown.
    expect(listed).toContain('no-deep-imports');
    expect(listed).toContain('local:no-deep-imports');
    for (const id of listed) {
      expect(referenceIdExists(inspection, 'policy', id)).toBe(true);
    }
  });

  test('template and pipeline ids agree with the registries the list verbs read', () => {
    for (const id of inspection.templateRegistry.list().map((t) => t.id)) {
      expect(referenceIdExists(inspection, 'template', id)).toBe(true);
    }
    for (const id of inspection.pipelineRegistry.list().map((p) => p.id)) {
      expect(referenceIdExists(inspection, 'pipeline', id)).toBe(true);
    }
  });
});

describe('the round-7 repro', () => {
  test('a doc citing a REAL pack/local playbook passes', () => {
    doc('docs/t.md', 'Run `shrk playbook nge.add-renderer-feature` to extend a plugin.\n');
    const res = checkDocReferences(root, RULE, inspection);
    expect(res.findings).toEqual([]);
    expect(res.status).toBe('passed');
    expect(res.tokens.find((t) => t.token === 'nge.add-renderer-feature')?.resolvedAs).toBe(
      'playbook',
    );
  });

  test('a PHANTOM playbook still fails, and did-you-mean names the real one', () => {
    doc('docs/t.md', 'Run `shrk playbook nge.migrate-v3`.\n');
    const res = checkDocReferences(root, RULE, inspection);
    expect(res.findings.map((f) => f.token)).toEqual(['nge.migrate-v3']);
    expect(res.findings[0]!.didYouMean).toContain('nge.migrate-v2');
  });

  test('the STRUCTURED reference shares the same resolver', () => {
    // The doc claims "there is one definition of does-this-id-exist, not two".
    // A knowledge entry citing the same playbook must therefore agree with the
    // prose linter — this half was broken too, and silently.
    const withRefs = {
      ...inspection,
      knowledgeEntries: [
        {
          id: 'k1',
          title: 'K',
          references: [
            { kind: 'playbook', id: 'nge.add-renderer-feature' },
            { kind: 'playbook', id: 'nge.does-not-exist' },
          ],
        },
      ],
    } as unknown as ISharkcraftInspection;
    const report = buildKnowledgeStaleReport(withRefs);
    const byId = new Map(report.referenceChecks.map((c) => [c.reference.id, c.outcome]));
    expect(byId.get('nge.add-renderer-feature')).toBe(ReferenceCheckOutcome.Ok);
    expect(byId.get('nge.does-not-exist')).not.toBe(ReferenceCheckOutcome.Ok);
  });
});

describe('the empty-registry guard', () => {
  test('a rule whose every registry is EMPTY refuses instead of flagging correct ids', () => {
    // `helper` has no registered ids at all, so nothing can resolve against
    // it. Emitting an "unresolved" finding per token would be a page of
    // confident lies; the honest answer is "I cannot validate this".
    doc('docs/t.md', 'See `nge.add-renderer-feature`.\n');
    const res = checkDocReferences(root, { ...RULE, resolvesAs: ['helper'] }, inspection);
    expect(res.status).toBe('error');
    expect(res.findings).toEqual([]);
    expect(res.error).toContain('nothing could resolve');
  });

  test('an UNWARMED playbook cache is caught by the guard, not reported as bad ids', () => {
    // The exact shape of the original bug: a sync resolver reading a cache an
    // async load populates. If someone forgets to warm it, the guard must say
    // so rather than declare every correct citation unresolved.
    const cold = {
      ...inspection,
      projectRoot: join(root, 'never-warmed'),
    } as unknown as ISharkcraftInspection;
    doc('docs/t.md', 'See `nge.add-renderer-feature`.\n');
    const res = checkDocReferences(root, RULE, cold);
    expect(res.status).toBe('error');
    expect(res.error).toContain('warmReferenceRegistries');
    expect(res.findings).toEqual([]);
  });

  test('a partially-populated rule still lints — only ALL-empty refuses', () => {
    doc('docs/t.md', 'See `nge.add-renderer-feature` and `nge.phantom`.\n');
    const res = checkDocReferences(root, { ...RULE, resolvesAs: ['playbook', 'helper'] }, inspection);
    expect(res.status).toBe('failed');
    expect(res.findings.map((f) => f.token)).toEqual(['nge.phantom']);
  });

  test('emptyReferenceKinds exempts `command`, whose check is shape-based', () => {
    // `command` deliberately has no list (the catalog lives above this layer),
    // so it resolves by shape. Calling it "empty" would refuse every rule that
    // mentions it.
    expect(emptyReferenceKinds(inspection, ['command'])).toEqual([]);
    expect(referenceIdExists(inspection, 'command', 'shrk gen')).toBe(true);
  });
});

describe('the phantom cast cannot come back', () => {
  test('no production source reads a registry off an inspection by structural cast', () => {
    // This is the lock. `inspection as { playbookRegistry?: ... }` compiles,
    // reads `undefined` forever, and no test notices unless the test itself
    // fakes the property — which is exactly what happened. Resolution goes
    // through the registry accessors, which the compiler can actually check.
    const src = join(import.meta.dir, '..');
    const offenders: string[] = [];
    for (const file of readdirSync(src)) {
      if (!file.endsWith('.ts')) continue;
      const text = readFileSync(join(src, file), 'utf8');
      for (const [i, line] of text.split('\n').entries()) {
        if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) continue;
        // Both halves of the anti-pattern: reading the property, and the cast
        // that invents it. `commandCatalog` is exempt — the CLI really does
        // attach it (explore.command.ts), so it is a genuine optional field.
        if (/\.(playbookRegistry|constructRegistry)\b/.test(line)) {
          offenders.push(`${file}:${i + 1} reads a phantom registry property`);
        }
        if (/as\s*\{\s*(playbookRegistry|constructRegistry|constructs|policyChecks)\?:/.test(line)) {
          offenders.push(`${file}:${i + 1} casts an inspection to a shape it never has`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('every ID kind either lists ids or documents why it cannot', () => {
    // A kind that can never resolve is a trap for whoever puts it in
    // `resolvesAs`. Only the two with a stated reason may be list-less.
    const listless: DocReferenceKind[] = [];
    for (const kind of ['template', 'pipeline', 'playbook', 'construct'] as DocReferenceKind[]) {
      if (referenceIdsFor(inspection, kind).length === 0) listless.push(kind);
    }
    expect(listless).toEqual([]);
  });
});
