import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IDocReferenceRule } from '@shrkcrft/core';
import { type ITemplateDefinition, TemplateRegistry } from '@shrkcrft/templates';
import { clearFileReadCache } from '@shrkcrft/boundaries';
import { checkDocReferences } from '../doc-references.ts';
import { nearestIds } from '../nearest-id.ts';
import { referenceIdsFor, warmReferenceRegistries } from '../reference-registry.ts';
import type { ISharkcraftInspection } from '../sharkcraft-inspector.ts';

/**
 * The prose-reference linter.
 *
 * The failure it exists to catch is silent: a "which template for which task"
 * table in a README or an agent skill file drifts from the registry, and no
 * build, type-check or existing gate notices until someone runs the command.
 *
 * The other half of the job is NOT crying wolf — prose legitimately contains
 * id-shaped strings that are not references, and a linter that flags those gets
 * turned off. Most of these tests are about that half.
 */

/**
 * Inspection carrying the registries this plane reads.
 *
 * The playbook is a REAL one, loaded through `warmPlaybookCache` from a real
 * `sharkcraft/playbooks.ts` — not a hand-rolled `playbookRegistry: { list }`
 * stub. The stub is how the round-6 plane shipped broken: production
 * inspections carry no such property, so the fake made a dead code path look
 * alive and every correct playbook citation was reported unresolved.
 */
let INSPECTION: ISharkcraftInspection;

/** A throwaway project whose `sharkcraft/playbooks.ts` registers one playbook. */
let registryRoot: string;

beforeAll(async () => {
  registryRoot = mkdtempSync(join(tmpdir(), 'shrk-docref-registry-'));
  mkdirSync(join(registryRoot, 'sharkcraft'), { recursive: true });
  writeFileSync(
    join(registryRoot, 'sharkcraft', 'playbooks.ts'),
    "export default [{ id: 'nge.migrate-v2', title: 'Migrate to v2', steps: [] }];\n",
  );
  INSPECTION = {
    projectRoot: registryRoot,
    sharkcraftDir: join(registryRoot, 'sharkcraft'),
    config: null,
    packs: { validPacks: [] },
    templateRegistry: new TemplateRegistry([
      { id: 'nge.angular-component' },
      { id: 'nge.sandbox-harness' },
    ] as unknown as ITemplateDefinition[]),
  } as unknown as ISharkcraftInspection;
  await warmReferenceRegistries(INSPECTION);
});

afterAll(() => rmSync(registryRoot, { recursive: true, force: true }));

const RULE: IDocReferenceRule = {
  id: 'doc-ids',
  files: ['docs/**/*.md', '.claude/skills/**/*.md'],
  tokenPattern: '\\bnge[.-][a-z0-9-]+\\b',
  resolvesAs: ['template', 'playbook'],
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shrk-docref-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
  clearFileReadCache();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function doc(rel: string, content: string): void {
  writeFileSync(join(root, rel), content);
  clearFileReadCache();
}

describe('doc references — the drift it exists to catch', () => {
  test('a phantom id is a finding; a real one is not', () => {
    doc('docs/a.md', 'Use `nge.angular-component` or `nge.angular-renderer`.\n');
    const res = checkDocReferences(root, RULE, INSPECTION);
    expect(res.status).toBe('failed');
    expect(res.findings.map((f) => f.token)).toEqual(['nge.angular-renderer']);
    expect(res.findings[0]!.line).toBe(1);
  });

  test('a token resolving in ANY listed registry passes', () => {
    // `nge.migrate-v2` is a playbook, not a template — the rule lists both.
    doc('docs/a.md', 'Run `nge.migrate-v2` first.\n');
    const res = checkDocReferences(root, RULE, INSPECTION);
    expect(res.status).toBe('passed');
    expect(res.tokens[0]!.resolvedAs).toBe('playbook');
  });

  test('it reads DOT-directories a glob explicitly names', () => {
    // The headline case: agent skill files live in `.claude/skills`, which the
    // shared code walker skips by default. A linter that could not see them
    // would miss the surface it was built for.
    doc('.claude/skills/which.md', 'Use `nge.phantom-skill`.\n');
    const res = checkDocReferences(root, RULE, INSPECTION);
    expect(res.filesScanned).toBe(1);
    expect(res.findings.map((f) => f.token)).toEqual(['nge.phantom-skill']);
  });

  test('did-you-mean names the near miss', () => {
    doc('docs/a.md', 'Use `nge.sandbox-harnes`.\n');
    const res = checkDocReferences(root, RULE, INSPECTION);
    expect(res.findings[0]!.didYouMean).toContain('nge.sandbox-harness');
  });

  test('did-you-mean stays SILENT when nothing is close', () => {
    // Printing the alphabetically-first id beside every typo trains people to
    // ignore the line, which costs more than the occasional missed hint.
    doc('docs/a.md', 'Use `nge.zzzz-completely-unrelated-thing`.\n');
    const res = checkDocReferences(root, RULE, INSPECTION);
    expect(res.findings[0]!.didYouMean).toEqual([]);
  });
});

describe('doc references — not crying wolf', () => {
  test('backtick gate (default): plain prose is not a reference', () => {
    doc('docs/a.md', 'Something like nge.made-up-in-prose is only a mention.\n');
    const res = checkDocReferences(root, RULE, INSPECTION);
    expect(res.findings).toEqual([]);
    expect(res.tokens[0]!.skipped).toBe('context');
  });

  test('a FENCED block counts as code even without inline backticks', () => {
    doc('docs/a.md', '```bash\nshrk gen nge.phantom-fenced\n```\n');
    const res = checkDocReferences(root, RULE, INSPECTION);
    expect(res.findings.map((f) => f.token)).toEqual(['nge.phantom-fenced']);
  });

  test('`off` lints every match, including plain prose', () => {
    doc('docs/a.md', 'Something like nge.made-up-in-prose is a mention.\n');
    const res = checkDocReferences(root, { ...RULE, requireContext: 'off' }, INSPECTION);
    expect(res.findings.map((f) => f.token)).toEqual(['nge.made-up-in-prose']);
  });

  test('`after` lints only tokens following a cue word', () => {
    doc('docs/a.md', 'Run shrk gen nge.phantom-after — but nge.phantom-elsewhere is prose.\n');
    const res = checkDocReferences(
      root,
      { ...RULE, requireContext: 'after', afterWords: ['shrk gen'] },
      INSPECTION,
    );
    expect(res.findings.map((f) => f.token)).toEqual(['nge.phantom-after']);
  });

  test('`exempt[]` and `exemptMarker` each suppress their own token', () => {
    doc(
      'docs/a.md',
      'A `nge.example-foo` hypothetical.\nA `nge.marked-one` line. <!-- ref-allow -->\nA real `nge.phantom-live`.\n',
    );
    const res = checkDocReferences(
      root,
      { ...RULE, exempt: ['nge.example-foo'], exemptMarker: 'ref-allow' },
      INSPECTION,
    );
    expect(res.findings.map((f) => f.token)).toEqual(['nge.phantom-live']);
    const skips = new Map(res.tokens.map((t) => [t.token, t.skipped]));
    expect(skips.get('nge.example-foo')).toBe('exempt');
    expect(skips.get('nge.marked-one')).toBe('exempt-marker');
  });

  test('the marker may carry a REASON', () => {
    // An exemption justified by "it was reviewed in a diff" needs somewhere to
    // say why. A byte-exact marker pushes the reason onto a neighbouring line,
    // where the gate cannot see it — so the exemption silently stops applying
    // the moment the paragraph is re-wrapped.
    doc('docs/a.md', 'A `nge.phantom-x` id. <!-- ref-allow: planned, not built yet -->\n');
    const res = checkDocReferences(root, { ...RULE, exemptMarker: 'ref-allow' }, INSPECTION);
    expect(res.findings).toEqual([]);
    expect(res.tokens[0]!.skipped).toBe('exempt-marker');
  });

  test('a DIFFERENT marker does not suppress', () => {
    doc('docs/a.md', 'A `nge.phantom-y` id. <!-- other-allow: nope -->\n');
    const res = checkDocReferences(root, { ...RULE, exemptMarker: 'ref-allow' }, INSPECTION);
    expect(res.findings.map((f) => f.token)).toEqual(['nge.phantom-y']);
  });

  test('the marker is LINE-scoped — a reason on the next line does not carry', () => {
    // Deliberate: the alternative is an exemption whose blast radius depends on
    // paragraph wrapping, which nobody can review.
    doc('docs/a.md', 'A `nge.phantom-z` id.\n<!-- ref-allow: too late -->\n');
    const res = checkDocReferences(root, { ...RULE, exemptMarker: 'ref-allow' }, INSPECTION);
    expect(res.findings.map((f) => f.token)).toEqual(['nge.phantom-z']);
  });
});

describe('doc references — the loud-skip contract', () => {
  test('a stale doc glob FAILS and says so, rather than passing empty', () => {
    const res = checkDocReferences(root, { ...RULE, files: ['moved/**/*.md'] }, INSPECTION);
    expect(res.status).toBe('failed');
    expect(res.skipReason).toContain('0 documents matched');
  });

  test('docs found but every token gated out is reported distinctly', () => {
    // "Your glob is wrong" and "your context gate rejected everything" need
    // different fixes, so they must not share one message.
    doc('docs/a.md', 'Only nge.in-prose here.\n');
    const res = checkDocReferences(root, RULE, INSPECTION);
    expect(res.status).toBe('failed');
    expect(res.skipReason).toContain('no token counted as a reference');
    expect(res.skipReason).toContain('requireContext');
  });

  test('a warning-severity empty rule is a SKIP, not a failure', () => {
    const res = checkDocReferences(
      root,
      { ...RULE, files: ['moved/**/*.md'], severity: 'warning' },
      INSPECTION,
    );
    expect(res.status).toBe('skipped');
  });

  test('an uncompilable tokenPattern is an ERROR, never a silent pass', () => {
    doc('docs/a.md', 'x\n');
    const res = checkDocReferences(root, { ...RULE, tokenPattern: '(' }, INSPECTION);
    expect(res.status).toBe('error');
    expect(res.error).toContain('tokenPattern');
  });
});

describe('nearestIds', () => {
  test('ranks nearest first and breaks ties lexically', () => {
    expect(nearestIds('nge.foo', ['nge.foa', 'nge.fob', 'zzz']).map((n) => n.id)).toEqual([
      'nge.foa',
      'nge.fob',
    ]);
  });

  test('never suggests the query itself', () => {
    expect(nearestIds('nge.foo', ['nge.foo'])).toEqual([]);
  });

  test('drops candidates beyond the distance cutoff', () => {
    expect(nearestIds('ab', ['zzzzzzzzzz'])).toEqual([]);
  });
});
