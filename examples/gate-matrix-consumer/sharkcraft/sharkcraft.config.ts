/**
 * A synthetic consumer that exercises every awkward real gate shape AT ONCE.
 *
 * Every defect the improvement rounds surfaced was invisible to unit tests and
 * only appeared when a real consumer drove the tool. This fixture is that
 * consumer, committed: `r71-gate-matrix.test.ts` runs the whole matrix against
 * it and asserts exit codes AND key messages, so the edge-case class that
 * slipped through each round is caught by CI forever.
 *
 * It is DELIBERATELY not clean. Several rules are expected to fail — that is
 * what proves they still fire.
 */
export default {
  projectName: 'gate-matrix-consumer',
  templateFiles: ['templates.ts'],

  // One selector, three consumers — the DRY guarantee under test.
  extractors: {
    handlers: {
      files: ['src/handlers/*_HANDLER.ts'],
      extract: 'export-names',
      match: '_HANDLER$',
    },
    viewImports: {
      files: ['apps/**/*.ts'],
      extract: 'import-edges',
      to: { module: '@x/generated', match: '^Nge.*View$' },
    },
  },

  wiringRules: [
    {
      // DERIVABLE import sink: `--fix` can complete this one (adds the import).
      id: 'handlers-registered',
      declared: { $use: 'handlers' },
      registered: { files: ['src/registry/derivable.ts'], extract: 'array-members', anchor: 'HANDLERS' },
      message: '{id} is declared but not in HANDLERS',
    },
    {
      // BARREL sink: `--fix` must REFUSE (needs-import) and write nothing.
      id: 'barrel-handlers-registered',
      declared: { $use: 'handlers' },
      registered: { files: ['src/registry/barrel.ts'], extract: 'array-members', anchor: 'BARREL_HANDLERS' },
    },
    {
      // ALIASED sink: `--fix` must refuse here too. The local name differs from
      // the exported one, so the import specifier for a new member is not
      // derivable from the name that would be written.
      id: 'aliased-handlers-registered',
      declared: { $use: 'handlers' },
      registered: {
        files: ['src/registry/aliased.ts'],
        extract: 'array-members',
        anchor: 'ALIASED_HANDLERS',
      },
      severity: 'warning',
    },
    {
      // MULTI-HOP: declared → listed in HANDLERS → actually booted. One rule
      // covers two seams and says WHICH hop broke, where two separate rules
      // would each blame their own side.
      id: 'handler-chain',
      description: 'Every handler is declared, registered in HANDLERS, and bootstrapped.',
      chain: [
        { $use: 'handlers' },
        { files: ['src/registry/derivable.ts'], extract: 'array-members', anchor: 'HANDLERS' },
        { files: ['src/registry/bootstrap.ts'], extract: 'array-members', anchor: 'BOOTSTRAPPED' },
      ],
    },
    {
      // Companion-file parity: every handler const has a sibling file.
      id: 'handler-has-file',
      declared: { $use: 'handlers' },
      registered: { files: ['src/handlers/*_HANDLER.ts'], extract: 'filenames' },
      mode: 'parity',
    },
    {
      // Orphan detection through the import graph — dead generated code a
      // byte-drift gate cannot see.
      id: 'no-orphan-views',
      declared: { files: ['src/generated/index.ts'], extract: 'export-names', match: '^Nge.*View$' },
      registered: { $use: 'viewImports', emit: 'symbol' },
    },
  ],

  registries: [
    { name: 'handlers', source: { $use: 'handlers' } },
    {
      // The BARREL trap: `to.files` matches an import's directly-resolved path,
      // and `@x/ui` resolves to the barrel index — so this yields 0 edges and
      // must carry the self-correcting hint rather than a bare "stale selector".
      name: 'barrel-by-files',
      source: {
        files: ['apps/**/*.ts'],
        extract: 'import-edges',
        to: { files: ['libs/ui/generated/**'] },
      },
    },
    {
      // The same intent, expressed the way that actually works.
      name: 'barrel-by-module',
      source: {
        files: ['apps/**/*.ts'],
        extract: 'import-edges',
        to: { module: '@x/ui', match: 'View$' },
      },
    },
  ],

  registrationGraph: [
    {
      name: 'handler-di',
      declared: { $use: 'handlers' },
      provided: { files: ['src/registry/derivable.ts'], extract: 'array-members', anchor: 'HANDLERS' },
      consumed: { files: ['src/registry/*.ts'], extract: 'array-members', anchor: 'BARREL_HANDLERS' },
    },
  ],

  baselines: [
    {
      // EXTRACTOR compute.
      id: 'handler-roster',
      baseline: 'baselines/handlers.json',
      compute: { kind: 'extractor', source: { $use: 'handlers' } },
      direction: 'two-way',
    },
    {
      // COMMAND compute — exercises the `gates coverage` watchFiles probe.
      id: 'handler-count',
      baseline: 'baselines/handler-count.txt',
      compute: { kind: 'command', run: 'ls src/handlers | grep -c _HANDLER' },
      watchFiles: ['src/handlers/*.ts'],
    },
    {
      // COMMAND compute whose watchFiles glob is STALE — the probe must say so.
      id: 'stale-watch',
      baseline: 'baselines/stale.txt',
      compute: { kind: 'command', run: 'echo 0' },
      watchFiles: ['moved-away/*.ts'],
      severity: 'warning',
    },
    {
      // Adoption ledger over the import graph: a LOST edge is a de-adoption.
      id: 'adoption-ledger',
      baseline: 'baselines/adoption.json',
      compute: { kind: 'extractor', source: { $use: 'viewImports' } },
      direction: 'two-way',
    },
    {
      // Targeted fence: appA must never be graph-connected to appB. An EMPTY
      // set is the passing state, which is what `expectEmpty` declares.
      id: 'fence-a-to-b',
      baseline: 'baselines/fence.json',
      compute: {
        kind: 'extractor',
        source: { files: ['appA/**/*.ts'], extract: 'import-edges', to: { files: ['appB/**'] } },
      },
      direction: 'additions-only',
      expectEmpty: true,
      hint: 'appA must not import from appB.',
    },
  ],

  generatedArtifacts: [
    {
      // MIXED tree: two writers, a config-listed hand file, a marker-blessed
      // hand file, and one deliberately un-headered file that MUST fail.
      id: 'views',
      generatedGlob: ['src/generated/*.ts'],
      sources: [
        { id: 'views', regen: 'sh tools/gen-views.sh {TMP}', glob: ['src/generated/*View.ts'] },
        { id: 'dtos', regen: 'sh tools/gen-dtos.sh {TMP}', glob: ['src/generated/*Dto.ts'] },
      ],
      handMaintained: ['src/generated/CannotEditThis.ts'],
      handMaintainedMarker: 'HAND-AUTHORED, NOT GENERATED',
      provenanceHeader: { mustMatch: 'GENERATED .* do not edit', withinLines: 5 },
    },
  ],

  // Prose-reference rule: an id cited in a doc must still resolve. The doc
  // deliberately contains a phantom, a real id, a prose mention and a marked
  // example — only the phantom may be reported.
  docReferences: [
    {
      id: 'doc-handler-ids',
      description: 'Every gmc.* id cited in docs must be a registered template.',
      files: ['docs/**/*.md'],
      tokenPattern: '\\bgmc[.-][a-z0-9-]+\\b',
      // BOTH registries: `gmc.add-handler` is a playbook, the rest templates.
      // Covering only templates is how the playbook resolver shipped broken.
      resolvesAs: ['template', 'playbook'],
      requireContext: 'backtick',
      exemptMarker: 'ref-allow',
      severity: 'warning',
      hint: 'Run `shrk templates list` and cite a registered id.',
    },
  ],

  policyRules: [
    {
      id: 'no-todo-in-generated',
      surface: 'ts',
      files: ['src/generated/*.ts'],
      pattern: 'TODO',
      message: 'generated files must not carry TODOs',
      failOnEmpty: false,
    },
  ],
};
