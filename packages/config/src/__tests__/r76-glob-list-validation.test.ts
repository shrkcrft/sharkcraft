/**
 * Round 12 (12.2b) — a malformed glob list is a validation error, on every plane.
 *
 * A bare `!`, a `!!x`, a list of negations only, and a `!` in an exemption list
 * all used to LOAD and then select (or exempt) nothing: a rule that could never
 * enforce anything, reported at best as a "stale selector" — the wrong
 * diagnosis. Each now fails at load, on the field the author has to change,
 * through core's `globListProblem` / `exemptionListProblem` (beside the one `!`
 * parser). The schema and `validateWiringSource` are the same checks the
 * pack-plane merge seam runs, so a pack element is held to the identical rule.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exemptionListProblem, globListProblem, validateWiringSource } from '@shrkcrft/core';
import { SharkCraftConfigSchema, WiringRuleSchema } from '../config-schema.ts';
import { loadProjectConfig } from '../config-loader.ts';

const GOOD = ['src/**/*.ts', '!src/**/*.spec.ts'];

/** [label, list, the problem sentence]. */
const BAD: readonly (readonly [string, readonly string[], string])[] = [
  ['a bare "!"', ['src/**/*.ts', '!'], '"!" is not a glob (an empty negation)'],
  [
    'a double negation',
    ['src/**/*.ts', '!!src/a.ts'],
    'double negation "!!src/a.ts" is not supported — write the inclusion glob',
  ],
  [
    'a negation-only list',
    ['!src/**/*.spec.ts'],
    'needs at least one inclusion glob (entries starting with "!" exclude from what the others select)',
  ],
];

const source = (files: readonly string[]): Record<string, unknown> => ({ files, extract: 'export-names' });

/**
 * Every glob-list field of every gate plane: [label, config builder, the issue
 * path, the prefix the problem carries there].
 */
const FIELDS: readonly (readonly [string, (files: readonly string[]) => unknown, string, string])[] = [
  [
    'wiring declared.files',
    (files) => ({ wiringRules: [{ id: 'w', declared: source(files), registered: source(['src/reg.ts']) }] }),
    'wiringRules.0.declared.files',
    '`files` ',
  ],
  [
    'wiring registered.files',
    (files) => ({ wiringRules: [{ id: 'w', declared: source(['src/a.ts']), registered: source(files) }] }),
    'wiringRules.0.registered.files',
    '`files` ',
  ],
  [
    'import-edges to.files',
    (files) => ({
      wiringRules: [
        {
          id: 'w',
          declared: { files: ['src/**/*.ts'], extract: 'import-edges', to: { files } },
          registered: source(['src/reg.ts']),
        },
      ],
    }),
    'wiringRules.0.declared.to.files',
    '`to.files` ',
  ],
  ['registry source.files', (files) => ({ registries: [{ name: 'r', source: source(files) }] }), 'registries.0.source.files', '`files` '],
  [
    'registration declared.files',
    (files) => ({
      registrationGraph: [{ name: 'i', declared: source(files), provided: source(['a.ts']), consumed: source(['b.ts']) }],
    }),
    'registrationGraph.0.declared.files',
    '`files` ',
  ],
  ['a named extractor', (files) => ({ extractors: { e: source(files) } }), 'extractors.e.files', '`files` '],
  [
    'an extractor baseline source',
    (files) => ({ baselines: [{ id: 'b', baseline: 'b.json', compute: { kind: 'extractor', source: source(files) } }] }),
    'baselines.0.compute.source.files',
    '`files` ',
  ],
  [
    'baseline watchFiles',
    (files) => ({ baselines: [{ id: 'b', baseline: 'b.json', compute: { kind: 'command', run: 'echo' }, watchFiles: files }] }),
    'baselines.0.watchFiles',
    '',
  ],
  [
    'policy files',
    (files) => ({ policyRules: [{ id: 'p', surface: 'ts', files, pattern: 'x', message: 'm' }] }),
    'policyRules.0.files',
    '',
  ],
  [
    'doc-reference files',
    (files) => ({ docReferences: [{ id: 'd', files, tokenPattern: 'x', resolvesAs: ['template'] }] }),
    'docReferences.0.files',
    '',
  ],
  [
    'generatedGlob',
    (files) => ({ generatedArtifacts: [{ id: 'g', generatedGlob: files, provenanceHeader: { mustMatch: 'GEN' } }] }),
    'generatedArtifacts.0.generatedGlob',
    '',
  ],
  [
    'generated sources[].glob',
    (files) => ({
      generatedArtifacts: [
        { id: 'g', generatedGlob: ['gen/**'], sources: [{ regen: 'gen.sh {TMP}', glob: files }], provenanceHeader: { mustMatch: 'GEN' } },
      ],
    }),
    'generatedArtifacts.0.sources.0.glob',
    '',
  ],
  [
    'provenanceHeader.outsideGlob',
    (files) => ({
      generatedArtifacts: [
        { id: 'g', generatedGlob: ['gen/**'], provenanceHeader: { mustMatch: 'GEN', forbidOutside: true, outsideGlob: files } },
      ],
    }),
    'generatedArtifacts.0.provenanceHeader.outsideGlob',
    '',
  ],
];

function issuesOf(config: unknown): string[] {
  const r = SharkCraftConfigSchema.safeParse(config);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

describe('the list-shape rules (core)', () => {
  test('globListProblem names each malformed shape; a well-formed list and an empty one pass', () => {
    for (const [, list, problem] of BAD) expect(globListProblem(list)).toBe(problem);
    expect(globListProblem(GOOD)).toBeUndefined();
    expect(globListProblem([])).toBeUndefined();
  });

  test('an exemption list takes plain globs', () => {
    expect(exemptionListProblem(['src/a.ts', '!src/b.ts'])).toBe(
      '"!src/b.ts": an exemption list takes plain globs — "!" here would mean "exempt everything else"',
    );
    expect(exemptionListProblem(['src/a.ts'])).toBeUndefined();
  });

  test('validateWiringSource rejects each shape on `files` and on `to.files`', () => {
    for (const [, list, problem] of BAD) {
      expect(validateWiringSource({ files: list, extract: 'export-names' })).toBe(`\`files\` ${problem}`);
      expect(validateWiringSource({ files: ['src/**/*.ts'], extract: 'import-edges', to: { files: list } })).toBe(
        `\`to.files\` ${problem}`,
      );
    }
    expect(validateWiringSource({ files: GOOD, extract: 'export-names' })).toBeUndefined();
  });
});

describe('the config schema — every glob-list field of every plane', () => {
  for (const [label, build, path, prefix] of FIELDS) {
    test(`${label}: each malformed shape fails at load on that field; a mixed list loads`, () => {
      for (const [, list, problem] of BAD) {
        expect(issuesOf(build(list))).toEqual([`${path}: ${prefix}${problem}`]);
      }
      expect(issuesOf(build(GOOD))).toEqual([]);
    });
  }

  test('a "!" in an exemption list (policy exemptFiles, generated handMaintained) is rejected', () => {
    const problem = '"!src/a.ts": an exemption list takes plain globs — "!" here would mean "exempt everything else"';
    expect(
      issuesOf({ policyRules: [{ id: 'p', surface: 'ts', files: GOOD, exemptFiles: ['!src/a.ts'], pattern: 'x', message: 'm' }] }),
    ).toEqual([`policyRules.0.exemptFiles: ${problem}`]);
    expect(
      issuesOf({
        generatedArtifacts: [
          { id: 'g', generatedGlob: ['src/**'], handMaintained: ['!src/a.ts'], provenanceHeader: { mustMatch: 'GEN' } },
        ],
      }),
    ).toEqual([`generatedArtifacts.0.handMaintained: ${problem}`]);
  });
});

describe('the element schema — a `$use` source that spells its OWN glob list (the pack-plane seam path, round 12 review R12-X3)', () => {
  // A locally spelled list REPLACES the extractor's, so its shape is judged
  // standalone by the SAME element schema the merge seam and `packs test
  // --load` run on a pack element — which never passes through the loader.
  const REGISTERED = { files: ['src/reg.ts'], extract: 'array-members', anchor: 'H' };
  const issues = (declared: Record<string, unknown>): string[] => {
    const r = WiringRuleSchema.safeParse({ id: 'w', declared, registered: REGISTERED });
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  };

  test('a negation-only / bare-"!" `files` or `to.files` override is rejected on the field', () => {
    for (const [, list, problem] of BAD) {
      expect(issues({ $use: 'handlers', files: list })).toEqual([`declared.files: \`files\` ${problem}`]);
      expect(issues({ $use: 'handlers', to: { files: list } })).toEqual([`declared.to.files: \`to.files\` ${problem}`]);
    }
  });

  test('a well-formed override, or none, still defers to the merged-shape check', () => {
    expect(issues({ $use: 'handlers', files: GOOD })).toEqual([]);
    expect(issues({ $use: 'handlers' })).toEqual([]);
    // Only the MERGED shape can be wrong here (a call-args kind needs an anchor the extractor may supply).
    expect(issues({ $use: 'handlers', extract: 'call-args' })).toEqual([]);
  });
});

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe('the loader — a `$use` source is judged on its MERGED shape', () => {
  test('a consumer overriding an extractor with a negation-only `files` fails config load', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-r76-globval-'));
    roots.push(root);
    mkdirSync(join(root, 'sharkcraft'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
    writeFileSync(
      join(root, 'sharkcraft', 'sharkcraft.config.ts'),
      `export default ${JSON.stringify(
        {
          extractors: { handlers: { files: ['src/**/*.ts'], extract: 'export-names' } },
          wiringRules: [
            {
              id: 'w',
              declared: { $use: 'handlers', files: ['!src/**/*.spec.ts'] },
              registered: { files: ['src/reg.ts'], extract: 'array-members', anchor: 'H' },
            },
          ],
        },
        null,
        2,
      )};\n`,
    );
    const loaded = await loadProjectConfig(root);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.message).toContain('`files` needs at least one inclusion glob');
  });
});
