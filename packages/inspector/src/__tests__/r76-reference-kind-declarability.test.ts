/**
 * r76 — every kind THE resolver answers for is DECLARABLE, and every probed
 * id field is BOUND to such a kind (round 12, 12.3c).
 *
 * `list ≡ resolve` (r73) proves the resolver reads what the `list` verb
 * prints — over ids that already exist, so a kind whose registry nothing can
 * fill passes vacuously. That is how a registration hint's `profileIds` came to
 * pin the self-config doctor at NOT VERIFIED forever. A declarability lock
 * alone would NOT have caught it, though: the field was bound to
 * `migration-profile`, which IS declarable — the defect was the binding. So
 * this lock has both halves:
 *
 *   (i)   every resolvable kind has a REFERENCE_KIND_DECLARATIONS row with at
 *         least one path;
 *   (ii)  every pack key is a consumed contribution slot, every config key is
 *         in the strict config schema;
 *   (iii) for EVERY (kind, path) row, a real temp project declaring one id
 *         through exactly that path (a real pack under node_modules for a pack
 *         key) makes the resolver list it — a row cannot name a path that
 *         fills nothing (it found the unwarmed TS-decision path);
 *   (iv)  every `*Ids` field of IConventionAppliesTo / IRegistrationHintDiscovery
 *         / template metadata has a PROBED_ID_FIELDS row naming a declarable
 *         kind, the doctor reads that table, and nothing relabels a target.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SharkCraftConfigSchema } from '@shrkcrft/config';
import { CONTRIBUTION_FILE_KEYS, FUTURE_CONTRIBUTION_FILE_KEYS } from '@shrkcrft/plugin-api';
import { inspectSharkcraft } from '../sharkcraft-inspector.ts';
import {
  ALL_ID_REFERENCE_KINDS,
  emptyReferenceKinds,
  referenceIdsFor,
  warmReferenceRegistries,
  type IdReferenceKind,
} from '../reference-registry.ts';
import {
  formatReferenceKindDeclaration,
  isReferenceKindDeclarable,
  REFERENCE_KIND_DECLARATIONS,
  referenceKindDeclarationPaths,
} from '../reference-kind-declarations.ts';
import { PROBED_ID_FIELDS } from '../probed-id-fields.ts';
import { ProbedIdSource } from '../probed-id-source.ts';
import { ROUTING_RECOMMENDS_CHANNELS } from '../routing-recommends-channels.ts';
import { buildSelfConfigDoctorReportV2 } from '../self-config-doctor-v2.ts';

const TIMEOUT_MS = 120_000;
const SRC = join(import.meta.dir, '..');
const PACKAGES = join(import.meta.dir, '..', '..', '..');
const roots: string[] = [];

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

function project(files: Readonly<Record<string, string>>, config = "export default { projectName: 'fx' };\n"): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r76-declare-'));
  roots.push(root);
  write(root, 'package.json', JSON.stringify({ name: 'fx', version: '0.0.0' }));
  write(root, 'sharkcraft/sharkcraft.config.ts', config);
  write(root, 'src/a.ts', 'export const a = 1;\n');
  for (const [rel, body] of Object.entries(files)) write(root, rel, body);
  return root;
}

/** A REAL pack: package.json → sharkcraft.manifest → contributions[packKey] → the asset file. */
function addPack(root: string, packKey: string, assetRel: string, body: string): void {
  const pack = join(root, 'node_modules', '@r76', 'decl');
  write(pack, 'package.json', JSON.stringify({ name: '@r76/decl', version: '0.0.1', sharkcraft: { manifest: './manifest.json' } }));
  write(
    pack,
    'manifest.json',
    JSON.stringify({
      schema: 'sharkcraft.pack/v1',
      info: { name: '@r76/decl', version: '0.0.1' },
      contributions: { [packKey]: [`./${assetRel}`] },
    }),
  );
  write(pack, assetRel, body);
}

const knowledge = (id: string, type: string): string =>
  `export default [{ id: '${id}', title: '${id}', type: '${type}', priority: 'low', scope: [], tags: [], appliesWhen: [], content: 'Fixture ${id}.' }];\n`;

/**
 * One valid declaration module per kind. A kind with a declared (non-builtin)
 * path and no body here fails the lock — a path nobody proved is not a path.
 */
const MINIMAL: Readonly<Partial<Record<IdReferenceKind, (id: string) => string>>> = {
  template: (id) =>
    `export default [{ id: '${id}', name: 'Fixture template', description: 'd', tags: [], scope: [], appliesWhen: [], variables: [], targetPath: () => 'src/x.ts', content: () => 'x' }];\n`,
  pipeline: (id) =>
    `export default [{ id: '${id}', title: 'Fixture pipeline', description: 'd', tags: [], steps: [{ id: 's1', type: 'manual', description: 'Do it.' }] }];\n`,
  playbook: (id) => `export default [{ id: '${id}', title: 'Fixture playbook', steps: [{ id: 's1', title: 'Step', commands: [] }] }];\n`,
  policy: (id) =>
    `export default [{ id: '${id}', title: 'Fixture policy', severity: 'warning', checkType: 'path', evaluate() { return null; } }];\n`,
  construct: (id) =>
    `export default [{ id: '${id}', type: 'service', title: 'Fixture construct', files: ['src/a.ts'], publicApi: ['src/a.ts'] }];\n`,
  helper: (id) =>
    `export default [{ id: '${id}', title: 'Fixture helper', description: 'h', variables: [], safety: { outputKind: 'checklist' }, manualChecklist: ['do it'] }];\n`,
  'boundary-rule': (id) =>
    `export default [{ id: '${id}', title: 'Fixture boundary', severity: 'warning', from: ['src/**'], forbiddenImports: ['@scope/ui'] }];\n`,
  'path-convention': (id) => knowledge(id, 'path'),
  rule: (id) => knowledge(id, 'rule'),
  knowledge: (id) => knowledge(id, 'technical'),
  decision: (id) => `export default [{ id: '${id}', title: 'Fixture decision' }];\n`,
  convention: (id) => `export default [{ id: '${id}', title: 'Fixture convention', kind: 'naming', severity: 'warning', rules: [] }];\n`,
  'contract-template': (id) => `export default [{ id: '${id}', title: 'Fixture contract', defaultForbiddenFilesDetailed: [] }];\n`,
  'migration-profile': (id) => `export default [{ id: '${id}', title: 'Fixture migration', checks: [] }];\n`,
  'routing-hint': (id) =>
    `export default [{ id: '${id}', title: 'Fixture hint', match: { keywords: ['zzqfixture'] }, recommends: { commands: [] } }];\n`,
  'registration-hint': (id) =>
    `export default [{ id: '${id}', title: 'Fixture hint', discovery: { targetFile: 'src/a.ts' }, operations: [{ kind: 'append', snippet: 'x' }] }];\n`,
  'scaffold-pattern': (id) =>
    `export default [{ id: '${id}', title: 'Fixture pattern', description: 'd', templateId: 'fx.none', matchPaths: ['src/**/*.ts'], variables: [], appliesWhen: ['infer-template'], confidence: 'high' }];\n`,
};

/** Markdown twin, for a `*.md` local path (decision records). */
const MINIMAL_MD: Readonly<Partial<Record<IdReferenceKind, (id: string) => string>>> = {
  decision: (id) => `---\nid: ${id}\ntitle: Fixture decision\nstatus: accepted\n---\n\n# Fixture decision\n`,
};

interface IDeclCase {
  readonly kind: IdReferenceKind;
  readonly via: 'local' | 'config' | 'pack';
  readonly path: string;
}

const CASES: readonly IDeclCase[] = ALL_ID_REFERENCE_KINDS.flatMap((kind): IDeclCase[] => {
  const d = REFERENCE_KIND_DECLARATIONS[kind];
  return [
    ...(d.localFiles ?? []).map((path) => ({ kind, via: 'local' as const, path })),
    ...(d.configKeys ?? []).map((key) => ({ kind, via: 'config' as const, path: String(key) })),
    ...(d.packKeys ?? []).map((key) => ({ kind, via: 'pack' as const, path: key })),
  ];
});

describe('(i) completeness — a referenceable kind is a declarable kind', () => {
  test('every ALL_ID_REFERENCE_KINDS kind has a row with at least one declaration path', () => {
    const undeclarable = ALL_ID_REFERENCE_KINDS.filter((k) => !isReferenceKindDeclarable(k));
    expect(undeclarable).toEqual([]);
    for (const kind of ALL_ID_REFERENCE_KINDS) {
      const d = REFERENCE_KIND_DECLARATIONS[kind];
      const paths =
        (d.builtin ? 1 : 0) + (d.configKeys?.length ?? 0) + (d.localFiles?.length ?? 0) + (d.packKeys?.length ?? 0);
      expect({ kind, paths: paths > 0 }).toEqual({ kind, paths: true });
      expect(d.listVerb.startsWith('shrk ')).toBe(true);
    }
    // The table has no row for a kind the resolver does not list.
    expect(Object.keys(REFERENCE_KIND_DECLARATIONS).sort()).toEqual([...ALL_ID_REFERENCE_KINDS].sort());
  });

  test('a kind with no row (not an id registry) is reported undeclarable, never guessed', () => {
    expect(isReferenceKindDeclarable('command')).toBe(false);
    expect(isReferenceKindDeclarable('file')).toBe(false);
    expect(referenceKindDeclarationPaths('url')).toEqual([]);
    expect(formatReferenceKindDeclaration('migration-profile')).toBe(
      'pack key migrationProfileFiles · sharkcraft/migration-profiles.ts · sharkcraft/migration-profiles/index.ts',
    );
    expect(formatReferenceKindDeclaration('workspace-profile')).toBe('builtin (always populated)');
  });
});

describe('(ii) every named path exists in the contract', () => {
  test('pack keys are CONSUMED contribution slots; config keys are in the strict config schema', () => {
    const consumed = new Set<string>(CONTRIBUTION_FILE_KEYS);
    const future = new Set<string>(FUTURE_CONTRIBUTION_FILE_KEYS);
    const schemaKeys = new Set(Object.keys(SharkCraftConfigSchema.shape));
    const bad: string[] = [];
    for (const kind of ALL_ID_REFERENCE_KINDS) {
      const d = REFERENCE_KIND_DECLARATIONS[kind];
      for (const k of d.packKeys ?? []) if (!consumed.has(k) || future.has(k)) bad.push(`${kind}: pack key ${k}`);
      for (const k of d.configKeys ?? []) if (!schemaKeys.has(String(k))) bad.push(`${kind}: config key ${String(k)}`);
    }
    expect(bad).toEqual([]);
  });
});

describe('(iii) every declared path fills the resolver (real registries)', () => {
  test('every kind with a declared file path has a fixture body — a path nobody proved fails', () => {
    const missing = [...new Set(CASES.map((c) => c.kind))].filter((kind) => MINIMAL[kind] === undefined);
    expect(missing).toEqual([]);
    expect(CASES.length).toBeGreaterThan(40);
  });

  test.each(CASES.map((c) => [`${c.kind} via ${c.via} ${c.path}`, c] as const))(
    '%s',
    async (_label, c) => {
      const id = `r76.${c.kind}.${c.via}`;
      const isMd = c.path.endsWith('.md');
      const body = (isMd ? MINIMAL_MD[c.kind] : MINIMAL[c.kind])?.(id);
      expect(body).toBeDefined();
      let root: string;
      if (c.via === 'local') {
        root = project({ [c.path.replace('*', id)]: body! });
      } else if (c.via === 'config') {
        const file = `r76-${c.kind}.ts`;
        root = project(
          { [`sharkcraft/${file}`]: body! },
          `export default { projectName: 'fx', ${c.path}: ['${file}'] };\n`,
        );
      } else {
        root = project({});
        addPack(root, c.path, 'asset.ts', body!);
      }
      const insp = await inspectSharkcraft({ cwd: root });
      await warmReferenceRegistries(insp);
      expect({ path: c.path, listed: referenceIdsFor(insp, c.kind).includes(id) }).toEqual({ path: c.path, listed: true });
      expect(emptyReferenceKinds(insp, [c.kind])).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test('a builtin kind is populated in an EMPTY project — before any warm', async () => {
    const insp = await inspectSharkcraft({ cwd: project({}) });
    for (const kind of ALL_ID_REFERENCE_KINDS.filter((k) => REFERENCE_KIND_DECLARATIONS[k].builtin)) {
      expect({ kind, n: referenceIdsFor(insp, kind).length > 0 }).toEqual({ kind, n: true });
      expect(emptyReferenceKinds(insp, [kind])).toEqual([]);
    }
  }, TIMEOUT_MS);
});

/** `*Ids` string-list fields declared in `header`'s block of `file` (source text — a new field cannot hide). */
function idsFieldsOf(file: string, header: string, close: string): string[] {
  const text = readFileSync(file, 'utf8');
  const start = text.indexOf(header);
  expect(start).toBeGreaterThanOrEqual(0);
  const body = text.slice(start + header.length, text.indexOf(close, start + header.length));
  // Optional OR required (round 12 review, T5): a future required `*Ids` field must not slip past.
  return [...body.matchAll(/(\w+Ids)\??:/g)].map((m) => m[1]!);
}

describe('(iv) binding — every probed id field names a declarable kind', () => {
  test('every *Ids field of the three shapes has a PROBED_ID_FIELDS row', () => {
    const declared = [
      ...idsFieldsOf(join(PACKAGES, 'plugin-api/src/convention.ts'), 'export interface IConventionAppliesTo {', '\n}').map(
        (f) => `${ProbedIdSource.Convention}:appliesTo.${f}`,
      ),
      ...idsFieldsOf(
        join(PACKAGES, 'plugin-api/src/registration-hint.ts'),
        'export interface IRegistrationHintDiscovery {',
        '\n}',
      ).map((f) => `${ProbedIdSource.RegistrationHint}:discovery.${f}`),
      ...idsFieldsOf(join(PACKAGES, 'templates/src/template-definition.ts'), '  metadata?: {', '\n  };').map(
        (f) => `${ProbedIdSource.Template}:metadata.${f}`,
      ),
    ];
    // Not blind: the three shapes carry 7 id-list fields today.
    expect(declared.length).toBeGreaterThanOrEqual(7);
    const bound = new Set(PROBED_ID_FIELDS.map((r) => `${r.source}:${r.field}`));
    expect(declared.filter((d) => !bound.has(d))).toEqual([]);
    // …and no row binds a field that does not exist.
    expect([...bound].filter((b) => !declared.includes(b))).toEqual([]);
  });

  test('every binding (and every routing channel) names a resolvable, declarable kind', () => {
    const kinds = new Set<string>(ALL_ID_REFERENCE_KINDS);
    for (const row of PROBED_ID_FIELDS) {
      expect({ row: row.field, ok: kinds.has(row.kind) && isReferenceKindDeclarable(row.kind) }).toEqual({ row: row.field, ok: true });
    }
    for (const [channel, spec] of Object.entries(ROUTING_RECOMMENDS_CHANNELS)) {
      if (spec.kind === 'command') continue;
      expect({ channel, ok: kinds.has(spec.kind) && isReferenceKindDeclarable(spec.kind) }).toEqual({ channel, ok: true });
    }
    // The applicability filters bind to THE WorkspaceProfile vocabulary.
    expect(PROBED_ID_FIELDS.filter((r) => r.field.endsWith('rofileIds')).map((r) => r.kind)).toEqual([
      'workspace-profile',
      'workspace-profile',
      'workspace-profile',
    ]);
  });

  test('the doctor relabels no target', () => {
    const doctor = readFileSync(join(SRC, 'self-config-doctor-v2.ts'), 'utf8');
    // The 12.3 relabel: a finding named a kind (`profile`) no registry or list verb has.
    expect(doctor).not.toMatch(/\?\s*'profile'/);
    expect(doctor).not.toMatch(/targetKind:\s*'profile'/);
    expect(doctor).not.toMatch(/lookups\.migrationProfiles/);
  });

  /**
   * The doctor PROBES every bound field against its bound kind — behaviourally
   * (round 12 review, T5). The old grep for literal `probeIds(inspection,
   * '<kind>'` could never fail (every call site passes `row.kind`), and two
   * rows had no test at all. Per row: a real project declaring ONE id of
   * `row.kind` (so its registry is not empty) and a typo in `row.field` must
   * yield exactly one `*-missing` finding whose `targetKind` is `row.kind`.
   */
  const TYPO = 'zzq-r76-typo';
  const sourceFile = (row: (typeof PROBED_ID_FIELDS)[number]): [string, string] => {
    const leaf = row.field.split('.')[1]!;
    switch (row.source) {
      case ProbedIdSource.Template:
        return [
          'sharkcraft/templates.ts',
          `export default [{ id: 'tpl.src', name: 'Src', description: 'd', tags: [], scope: [], appliesWhen: [], variables: [], targetPath: () => 'src/x.ts', content: () => 'x', metadata: { ${leaf}: ['${TYPO}'] } }];\n`,
        ];
      case ProbedIdSource.RegistrationHint:
        return [
          'sharkcraft/registration-hints.ts',
          `export default [{ id: 'rh.src', title: 'Src', discovery: { targetFile: 'src/a.ts', ${leaf}: ['${TYPO}'] }, operations: [{ kind: 'append', snippet: 'x' }] }];\n`,
        ];
      default:
        return [
          'sharkcraft/conventions.ts',
          `export default [{ id: 'cv.src', title: 'Src', kind: 'naming', severity: 'warning', rules: [], appliesTo: { ${leaf}: ['${TYPO}'] } }];\n`,
        ];
    }
  };

  test.each(PROBED_ID_FIELDS.map((row) => [`${row.source}:${row.field} → ${row.kind}`, row] as const))(
    'a typo in %s is exactly one *-missing finding against the bound kind',
    async (_label, row) => {
      const files: Record<string, string> = {};
      const decl = REFERENCE_KIND_DECLARATIONS[row.kind];
      if (!decl.builtin) {
        const local = (decl.localFiles ?? []).find((p) => p.endsWith('.ts') && !p.includes('*'));
        expect({ kind: row.kind, local }).toEqual({ kind: row.kind, local: expect.any(String) });
        files[local!] = MINIMAL[row.kind]!(`r76.${row.kind}.declared`);
      }
      const [rel, body] = sourceFile(row);
      expect({ kind: row.kind, clash: files[rel] !== undefined }).toEqual({ kind: row.kind, clash: false });
      files[rel] = body;
      const insp = await inspectSharkcraft({ cwd: project(files) });
      await warmReferenceRegistries(insp);
      expect(emptyReferenceKinds(insp, [row.kind])).toEqual([]);
      const report = await buildSelfConfigDoctorReportV2(insp);
      const hits = report.findings.filter((f) => f.targetId === TYPO && f.code.endsWith('-missing'));
      expect(hits.map((f) => [f.code.endsWith(`-${row.label}-missing`), f.targetKind])).toEqual([[true, row.kind]]);
    },
    TIMEOUT_MS,
  );
});

describe('the loud skip names how to fill the empty kind', () => {
  test('an empty migration-profile registry: the unverified reason names its pack key and local file', async () => {
    const root = project({
      'sharkcraft/task-routing-hints.ts': `export default [{ id: 'rt.mig', title: 'Mig', match: { keywords: ['zzqmig'] }, recommends: { profiles: ['mig.x'] } }];\n`,
    });
    const report = await buildSelfConfigDoctorReportV2(await inspectSharkcraft({ cwd: root }));
    const rec = report.coverage.find((c) => c.subject === 'routing hints' && c.unit === 'recommended ids');
    expect(rec).toMatchObject({ expected: 1, examined: 0 });
    expect(rec!.reason).toContain("their kind's registry is empty in this workspace");
    expect(rec!.reason).toContain('migrationProfileFiles');
    expect(rec!.reason).toContain('sharkcraft/migration-profiles.ts');
    // The label names the kind resolved against (round 12 review, T4): `profile`
    // was ambiguous once `workspace-profile` existed.
    expect(rec!.unexamined).toEqual(['rt.mig → migration-profile mig.x']);
  }, TIMEOUT_MS);
});
