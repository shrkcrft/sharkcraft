import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { importModuleViaLoader, type IVerdictCoverage } from '@shrkcrft/core';
import {
  formatEntryRejection,
  readPackManifest,
  rejectedEntryTypecheckHint,
  typecheckPackAssets,
  validateContributionFile,
  type ContributionKind,
  type ITypecheckFilesResult,
} from '@shrkcrft/inspector';
import {
  CONTRIBUTION_FILE_KEYS,
  FUTURE_CONTRIBUTION_FILE_KEYS,
  validatePackManifest,
  type ISharkCraftPackManifest,
} from '@shrkcrft/plugin-api';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';
import { settleVerdict } from '../gates/settle-verdict.ts';
import { verdictLine } from '../gates/verdict-line.ts';
import { ALLOW_EMPTY_FLAG, allowEmptyValve } from '../gates/allow-empty.ts';

export type PackKind = 'generic' | 'framework' | 'architecture' | 'enterprise';

const VALID_KINDS = new Set<PackKind>([
  'generic',
  'framework',
  'architecture',
  'enterprise',
]);

interface IScaffoldFile {
  /** Path relative to the new pack root. */
  relativePath: string;
  body: string;
}

export interface IScaffoldPackInput {
  name: string;
  outDir: string;
  scope?: string;
  kind: PackKind;
  preset?: string;
  withExamples?: boolean;
  force?: boolean;
}

export interface IScaffoldPackResult {
  files: IScaffoldFile[];
  packageJson: Record<string, unknown>;
  packRoot: string;
}

/** The manifest path the scaffold declares in package.json — a source-loaded pack. */
const MANIFEST_REL = './src/sharkcraft.plugin.ts';

interface IEntryRow {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly priority: string;
  readonly content: string;
}

/**
 * Pure: compute the file set to write. No IO.
 *
 * The scaffold is a VALID, discoverable, type-clean pack:
 *   - `package.json` `sharkcraft.manifest` points at `src/sharkcraft.plugin.ts`
 *     (discovery reads nothing else — without it the pack is INVALID);
 *   - that file default-exports a real `ISharkCraftPackManifest` (`satisfies`,
 *     with a TYPE-ONLY import, so there is no runtime plugin-api coupling);
 *   - every asset it emits is declared in the manifest and non-empty (a file
 *     the manifest does not list is never loaded — so none is emitted);
 *   - every asset is annotated with `satisfies` against the SDK types, and
 *     `tsc -p tsconfig.json` (noEmit) type-checks clean.
 */
export function planPackScaffold(input: IScaffoldPackInput): IScaffoldPackResult {
  const fullName = input.scope ? `${input.scope}/${input.name}` : input.name;
  const withTemplates = input.kind === 'framework' || input.withExamples === true;
  const withBoundaries = input.kind === 'architecture' || input.withExamples === true;
  const knowledgeRows = knowledgeRowsFor(input.kind);
  const contributions: Record<string, readonly string[]> = {
    knowledgeFiles: ['./src/assets/knowledge.ts'],
    ruleFiles: ['./src/assets/rules.ts'],
    pathFiles: ['./src/assets/paths.ts'],
    ...(withTemplates
      ? { templateFiles: ['./src/assets/templates.ts'], pipelineFiles: ['./src/assets/pipelines.ts'] }
      : {}),
    ...(input.preset ? { presetFiles: ['./src/assets/presets.ts'] } : {}),
    ...(withBoundaries ? { boundaryFiles: ['./src/assets/boundaries.ts'] } : {}),
    docsFiles: ['./src/assets/docs/overview.md'],
  };
  const packageJson: Record<string, unknown> = {
    name: fullName,
    version: '0.0.1',
    description: `SharkCraft pack scaffolded as ${input.kind}.`,
    type: 'module',
    main: MANIFEST_REL,
    sharkcraft: {
      kind: input.kind,
      ...(input.preset ? { preset: input.preset } : {}),
      manifest: MANIFEST_REL,
    },
    scripts: {
      typecheck: 'tsc -p tsconfig.json',
      test: 'shrk packs test . --load --typecheck',
      'release-check': 'shrk packs release-check . --typecheck',
    },
    // Type-only dependencies: the assets `import type` from the SDK, which is
    // erased at runtime — they are needed only for `npm run typecheck`.
    devDependencies: {
      '@shrkcrft/plugin-api': '*',
      typescript: '^5.6.0',
    },
    files: ['src', 'README.md', 'SECURITY.md', 'package.json'],
  };
  const files: IScaffoldFile[] = [];
  files.push({ relativePath: 'package.json', body: JSON.stringify(packageJson, null, 2) + '\n' });
  files.push({ relativePath: 'README.md', body: renderReadme(input, fullName, contributions) });
  files.push({ relativePath: 'SECURITY.md', body: renderSecurity(input) });
  files.push({
    relativePath: 'tsconfig.json',
    body:
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            noEmit: true,
            allowImportingTsExtensions: true,
            skipLibCheck: true,
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ) + '\n',
  });
  files.push({ relativePath: 'src/sharkcraft.plugin.ts', body: renderManifest(input, fullName, contributions) });
  files.push({
    relativePath: 'src/assets/knowledge.ts',
    body: entriesAsset('Knowledge entries contributed by this pack.', knowledgeRows),
  });
  files.push({
    relativePath: 'src/assets/rules.ts',
    body: entriesAsset('Rules contributed by this pack (knowledge entries of type "rule").', rulesRowsFor(input.kind)),
  });
  files.push({
    relativePath: 'src/assets/paths.ts',
    body: entriesAsset('Path conventions contributed by this pack (knowledge entries of type "path").', [
      {
        id: `${slug(input.name)}.path.source-layout`,
        title: 'Source layout',
        type: 'path',
        priority: 'medium',
        content: 'Source files live under src/; pack assets live under src/assets/.',
      },
    ]),
  });
  if (withTemplates) {
    files.push({ relativePath: 'src/assets/templates.ts', body: renderTemplatesAsset() });
    files.push({ relativePath: 'src/assets/pipelines.ts', body: renderPipelinesAsset() });
  }
  if (input.preset) {
    files.push({
      relativePath: 'src/assets/presets.ts',
      body: renderPresetsAsset(input.preset, knowledgeRows[0]!.id),
    });
  }
  if (withBoundaries) {
    files.push({ relativePath: 'src/assets/boundaries.ts', body: renderBoundariesAsset() });
  }
  files.push({ relativePath: 'src/assets/docs/overview.md', body: renderDocsOverview(input, fullName) });
  if (input.kind === 'enterprise') {
    files.push({ relativePath: 'docs/review-workflow.md', body: renderEnterpriseReviewDocs() });
    files.push({ relativePath: 'docs/security-baseline.md', body: renderEnterpriseSecurityDocs() });
  }
  return { files, packageJson, packRoot: input.outDir };
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'pack';
}

function knowledgeRowsFor(kind: PackKind): IEntryRow[] {
  if (kind === 'enterprise') {
    return [
      { id: 'security.baseline', title: 'Security baseline', type: 'security', priority: 'high', content: 'Document the security baseline this pack enforces.' },
      { id: 'review.workflow', title: 'Code review workflow', type: 'workflow', priority: 'high', content: 'How code review gets done in this organisation.' },
    ];
  }
  if (kind === 'architecture') {
    return [
      { id: 'architecture.layering', title: 'Layering rules', type: 'architecture', priority: 'high', content: 'Describe lower -> higher layers that cannot be inverted.' },
      { id: 'architecture.coverage', title: 'Coverage targets', type: 'architecture', priority: 'medium', content: 'Coverage axes you care about.' },
    ];
  }
  if (kind === 'framework') {
    return [
      { id: 'framework.overview', title: 'Framework overview', type: 'technical', priority: 'high', content: 'What this framework is for.' },
    ];
  }
  return [
    { id: 'pack.overview', title: 'Pack overview', type: 'technical', priority: 'medium', content: 'Short overview of what this pack contributes.' },
  ];
}

function rulesRowsFor(kind: PackKind): IEntryRow[] {
  if (kind === 'enterprise') {
    return [
      { id: 'rule.review-required', title: 'All changes require code review', type: 'rule', priority: 'critical', content: 'All changes require code review.' },
      { id: 'rule.no-secrets-in-source', title: 'Secrets must never be committed', type: 'rule', priority: 'critical', content: 'Secrets must never be committed.' },
    ];
  }
  if (kind === 'architecture') {
    return [
      { id: 'rule.boundary-enforcement', title: 'Respect layer boundaries', type: 'rule', priority: 'high', content: 'Respect layer boundaries.' },
    ];
  }
  return [{ id: 'rule.example', title: 'Example rule for this pack', type: 'rule', priority: 'medium', content: 'Example rule for this pack.' }];
}

/**
 * A knowledge-shaped asset: `import type` (erased at runtime) + `satisfies`, so
 * a misspelled field or a missing required one fails `npm run typecheck` where
 * it is written, while the file still loads against every plugin-api version.
 */
function entriesAsset(comment: string, rows: readonly IEntryRow[]): string {
  const lines: string[] = [];
  lines.push(`// ${comment}`);
  lines.push(`// \`import type\` is erased at runtime; \`satisfies\` type-checks every entry where it is written.`);
  lines.push(`import type { IKnowledgeEntry } from '@shrkcrft/plugin-api';`);
  lines.push('');
  lines.push('export default [');
  for (const r of rows) {
    lines.push('  {');
    lines.push(`    id: ${JSON.stringify(r.id)},`);
    lines.push(`    title: ${JSON.stringify(r.title)},`);
    lines.push(`    type: ${JSON.stringify(r.type)},`);
    lines.push(`    priority: ${JSON.stringify(r.priority)},`);
    lines.push('    scope: [],');
    lines.push('    tags: [],');
    lines.push("    appliesWhen: ['onboarding'],");
    lines.push(`    content: ${JSON.stringify(r.content)},`);
    lines.push('  },');
  }
  lines.push(`] satisfies readonly Omit<IKnowledgeEntry, 'source'>[];`);
  lines.push('');
  return lines.join('\n');
}

function renderManifest(
  input: IScaffoldPackInput,
  fullName: string,
  contributions: Readonly<Record<string, readonly string[]>>,
): string {
  const lines: string[] = [];
  lines.push(`// SharkCraft pack manifest for ${fullName} — scaffolded as kind=${input.kind}.`);
  lines.push('// package.json `sharkcraft.manifest` points here; discovery reads nothing else.');
  lines.push('// Every file listed under `contributions` is loaded; a file NOT listed is never loaded.');
  lines.push('// `import type` is erased at runtime (no plugin-api version coupling);');
  lines.push('// `satisfies` type-checks the manifest where it is written.');
  lines.push(`import type { ISharkCraftPackManifest } from '@shrkcrft/plugin-api';`);
  lines.push('');
  lines.push('export default {');
  lines.push(`  schema: 'sharkcraft.pack/v1',`);
  lines.push('  info: {');
  lines.push(`    name: ${JSON.stringify(fullName)},`);
  lines.push(`    version: '0.0.1',`);
  lines.push(`    description: ${JSON.stringify(`SharkCraft pack scaffolded as ${input.kind}.`)},`);
  lines.push('  },');
  lines.push('  contributions: {');
  for (const [key, rels] of Object.entries(contributions)) {
    lines.push(`    ${key}: [${rels.map((r) => `'${r}'`).join(', ')}],`);
  }
  lines.push('  },');
  lines.push('} satisfies ISharkCraftPackManifest;');
  lines.push('');
  return lines.join('\n');
}

function renderTemplatesAsset(): string {
  return [
    '// Templates contributed by this pack.',
    '// `satisfies` gives every resolver parameter its type (no implicit any).',
    `import type { ITemplateDefinition } from '@shrkcrft/plugin-api';`,
    '',
    'export default [',
    '  {',
    `    id: 'pack.example.service',`,
    `    name: 'Example service',`,
    `    description: 'Scaffold an example service for this pack.',`,
    `    tags: ['service'],`,
    `    scope: ['ts'],`,
    `    appliesWhen: ['create-service'],`,
    `    variables: [{ name: 'name', required: true, description: 'Service name in kebab-case.', examples: ['user-profile'] }],`,
    `    targetPath: ({ name }) => 'src/services/' + name + '.service.ts',`,
    `    content: ({ name }) =>`,
    `      'export class ' +`,
    `      String(name).split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('') +`,
    `      'Service {}\\n',`,
    '  },',
    '] satisfies readonly ITemplateDefinition[];',
    '',
  ].join('\n');
}

function renderPipelinesAsset(): string {
  return [
    '// Pipelines contributed by this pack (shape: IPipelineDefinition from @shrkcrft/pipelines).',
    'export default [',
    '  {',
    `    id: 'pack.example.pipeline',`,
    `    title: 'Example pipeline',`,
    `    description: 'Reference pipeline for this pack.',`,
    `    appliesWhen: ['create-service'],`,
    '    steps: [',
    `      { id: 'context', type: 'context', description: 'Load the task context.', cliCommands: ['shrk context --task "<task>"'] },`,
    `      { id: 'plan', type: 'generation-plan', description: 'Plan the change (dry-run).', cliCommands: ['shrk gen pack.example.service --var name=<name> --dry-run'] },`,
    `      { id: 'apply', type: 'apply-plan', description: 'Apply the reviewed plan.', humanReview: true },`,
    '    ],',
    '  },',
    '];',
    '',
  ].join('\n');
}

function renderPresetsAsset(preset: string, knowledgeId: string): string {
  return [
    '// Presets contributed by this pack (shape: IPreset from @shrkcrft/presets).',
    'export default [',
    '  {',
    `    id: ${JSON.stringify(preset)},`,
    `    title: ${JSON.stringify(preset)},`,
    `    description: 'Preset for this pack.',`,
    `    includes: { knowledgeIds: [${JSON.stringify(knowledgeId)}] },`,
    '  },',
    '];',
    '',
  ].join('\n');
}

function renderBoundariesAsset(): string {
  return [
    '// Architecture boundary rules contributed by this pack (shape: IBoundaryRule',
    '// from @shrkcrft/boundaries). An empty list is valid; add rules as the pack',
    '// learns the layering of the projects that adopt it.',
    'export default [',
    '  // {',
    `  //   id: 'boundary.layer.example',`,
    `  //   title: 'Example layer boundary',`,
    `  //   severity: 'error',`,
    `  //   from: ['packages/lower/**/*.ts'],`,
    `  //   forbiddenImports: ['@my/higher'],`,
    '  // },',
    '];',
    '',
  ].join('\n');
}

function renderReadme(
  input: IScaffoldPackInput,
  fullName: string,
  contributions: Readonly<Record<string, readonly string[]>>,
): string {
  const assetLines = Object.values(contributions)
    .flat()
    .map((rel) => `  ${rel.replace(/^\.\/src\//, '')}`);
  return [
    `# ${fullName}`,
    '',
    `> SharkCraft pack scaffolded as **${input.kind}**.`,
    '',
    'This pack contributes structured knowledge to SharkCraft. The CLI is the',
    'only write path: MCP tools are read-only by design.',
    '',
    '## Layout',
    '',
    '```',
    'src/',
    '  sharkcraft.plugin.ts     # the manifest — package.json `sharkcraft.manifest` points here',
    ...assetLines,
    '```',
    '',
    'Every file listed in the manifest `contributions` is loaded; a file that is',
    'not listed there is never loaded.',
    '',
    '## Group modules',
    '',
    'Split a large asset into group modules and re-export them from the listed',
    'file with `export * from \'./group.ts\'` — the loader collects every',
    'entry-shaped export, so nothing needs to be named twice. (Listing entries by',
    'hand in an array works too, but an entry added to a group and not to the',
    'array is invisible — `shrk doctor` / `shrk packs doctor` report it as',
    '`unregistered-export`.)',
    '',
    '## Validate this pack',
    '',
    '```bash',
    'npm run typecheck                          # tsc — every asset is `satisfies`-annotated',
    'shrk packs test . --load --typecheck       # manifest + contributions load and type-check',
    'shrk packs release-check . --typecheck     # the pre-publish gate',
    'SHARKCRAFT_PACK_SECRET=<secret> shrk packs sign .',
    '```',
    '',
    '## Local development',
    '',
    'Link this pack into a target project to dogfood:',
    '',
    '```bash',
    'cd <target-project>',
    'npm install --no-save ../path/to/this-pack',
    'shrk packs list',
    'shrk packs doctor',
    '```',
    '',
  ].join('\n');
}

function renderSecurity(input: IScaffoldPackInput): string {
  return [
    `# Security`,
    '',
    'This pack is read-only at runtime. SharkCraft never executes arbitrary',
    'commands shipped by a pack: pack-contributed verification commands are',
    'NOT auto-run by `shrk apply --validate`. Only the user-controlled',
    '`sharkcraft.config.ts verificationCommands[]` array is trusted.',
    '',
    '## Signing',
    '',
    'Packs can ship a signed manifest. Sign locally with:',
    '',
    '```bash',
    'SHARKCRAFT_PACK_SECRET="<secret>" shrk packs sign .',
    '```',
    '',
    'Adopting projects verify the signature via:',
    '',
    '```bash',
    'shrk packs doctor --require-signatures',
    '```',
    '',
    '## Reporting issues',
    '',
    `Please file security issues privately to the maintainer of \`${input.name}\`.`,
    '',
  ].join('\n');
}

function renderEnterpriseReviewDocs(): string {
  return [
    `# Review workflow`,
    '',
    'Describe how PRs in your organisation get reviewed:',
    '',
    '- Number of approvals required',
    '- Required automated checks',
    '- Security/compliance signoff path',
    '',
  ].join('\n');
}

function renderEnterpriseSecurityDocs(): string {
  return [
    `# Security baseline`,
    '',
    '- All packs must be signed before adoption.',
    '- Secrets must never be committed.',
    '- Verification commands must be reviewed before adding to trusted list.',
    '',
  ].join('\n');
}

function renderDocsOverview(input: IScaffoldPackInput, fullName: string): string {
  return [
    `# ${fullName} — overview`,
    '',
    `Kind: \`${input.kind}\``,
    input.preset ? `Preset: \`${input.preset}\`` : '',
    '',
    'This pack ships knowledge entries, rules and path conventions' +
      (input.kind === 'framework' || input.withExamples ? ', templates and pipelines' : '') +
      '.',
    '',
  ]
    .filter(Boolean)
    .join('\n') + '\n';
}

// ─── CLI handler ─────────────────────────────────────────────────────────────

export const packsNewCommand: ICommandHandler = {
  name: 'new',
  description:
    'Scaffold a new SharkCraft pack package — a valid, discoverable, type-clean pack (package.json sharkcraft.manifest → a `satisfies ISharkCraftPackManifest` manifest; every asset `satisfies`-annotated). Dry-run by default — pass --write to materialize. No install, no publish, no overwrite without --force.',
  usage:
    'shrk [--cwd <dir>] packs new <name> [--scope @org] [--preset <id>] [--kind generic|framework|architecture|enterprise] [--with-examples] [--write] [--force] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const name = args.positional[0];
    if (!name) {
      process.stderr.write(
        'Usage: shrk packs new <name> [--scope @org] [--preset <id>] [--kind generic|framework|architecture|enterprise] [--with-examples] [--write]\n',
      );
      return 2;
    }
    const cwd = resolveCwd(args);
    const kindFlag = (flagString(args, 'kind') ?? 'generic') as PackKind;
    if (!VALID_KINDS.has(kindFlag)) {
      process.stderr.write(`Invalid --kind "${kindFlag}". Expected one of: ${[...VALID_KINDS].join(', ')}\n`);
      return 2;
    }
    const scope = flagString(args, 'scope');
    const preset = flagString(args, 'preset');
    const withExamples = flagBool(args, 'with-examples');
    const write = flagBool(args, 'write');
    const force = flagBool(args, 'force');
    const wantJson = flagBool(args, 'json');

    const outDir = nodePath.resolve(cwd, name);
    const result = planPackScaffold({
      name,
      outDir,
      kind: kindFlag,
      withExamples,
      ...(scope ? { scope } : {}),
      ...(preset ? { preset } : {}),
      ...(force ? { force: true } : {}),
    });

    if (!write) {
      if (wantJson) {
        process.stdout.write(
          asJson({
            mode: 'dry-run',
            outDir,
            files: result.files.map((f) => ({ relativePath: f.relativePath, bytes: f.body.length })),
          }) + '\n',
        );
        return 0;
      }
      process.stdout.write(header(`Pack scaffold (dry-run): ${name}`));
      process.stdout.write(kv('kind', kindFlag) + '\n');
      process.stdout.write(kv('outDir', outDir) + '\n');
      process.stdout.write('\nFiles that would be written:\n');
      for (const f of result.files) {
        process.stdout.write(`  + ${f.relativePath}  (${f.body.length} bytes)\n`);
      }
      process.stdout.write('\nRe-run with `--write` to materialize.\n');
      return 0;
    }
    if (existsSync(outDir) && !force) {
      process.stderr.write(
        `Refusing to scaffold into existing directory: ${outDir}. Pass --force to overwrite.\n`,
      );
      return 1;
    }
    for (const f of result.files) {
      const full = nodePath.join(outDir, f.relativePath);
      // Defense in depth: refuse anything that escapes outDir.
      if (!full.startsWith(outDir + nodePath.sep) && full !== outDir) {
        process.stderr.write(`Refusing to write outside packRoot: ${f.relativePath}\n`);
        return 1;
      }
      mkdirSync(nodePath.dirname(full), { recursive: true });
      if (existsSync(full) && !force) {
        process.stderr.write(`Refusing to overwrite existing file: ${full} (use --force)\n`);
        return 1;
      }
      writeFileSync(full, f.body, 'utf8');
    }
    if (wantJson) {
      process.stdout.write(
        asJson({
          mode: 'write',
          outDir,
          files: result.files.map((f) => ({ relativePath: f.relativePath, bytes: f.body.length })),
        }) + '\n',
      );
      return 0;
    }
    process.stdout.write(header(`Pack scaffold written: ${name}`));
    process.stdout.write(kv('kind', kindFlag) + '\n');
    process.stdout.write(kv('outDir', outDir) + '\n');
    for (const f of result.files) {
      process.stdout.write(`  + ${f.relativePath}\n`);
    }
    // Install first: --typecheck resolves the scaffold's `import type … from
    // '@shrkcrft/plugin-api'` against the pack's own devDependencies.
    process.stdout.write(
      '\nNext:\n' +
        `  1. (cd ${outDir} && npm install)   # devDependencies: @shrkcrft/plugin-api + typescript\n` +
        `  2. shrk packs test ${outDir} --load --typecheck\n` +
        `  3. shrk packs release-check ${outDir} --typecheck\n`,
    );
    return 0;
  },
};

// ─── shrk packs test ─────────────────────────────────────────────────────────

interface IPackTestIssue {
  code: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
}

/** A contribution file the manifest declares, with the slot that declared it. */
interface IDeclaredContribution {
  readonly key: string;
  readonly rel: string;
  readonly abs: string;
}

/** Slots whose files default-export an array of `{ id }` records. */
const ARRAY_OF_IDS_SLOTS: Readonly<Record<string, string>> = {
  knowledgeFiles: 'knowledge',
  ruleFiles: 'rule',
  pathFiles: 'path',
  pathConventionFiles: 'path',
  templateFiles: 'template',
  pipelineFiles: 'pipeline',
  presetFiles: 'preset',
  boundaryFiles: 'boundary',
};

const MODULE_FILE = /\.(?:[cm]?[jt]s|tsx)$/;

function declaredContributions(
  packRoot: string,
  manifest: ISharkCraftPackManifest | null,
): IDeclaredContribution[] {
  const out: IDeclaredContribution[] = [];
  const contributions = (manifest?.contributions ?? {}) as Record<string, readonly string[] | undefined>;
  for (const key of [...CONTRIBUTION_FILE_KEYS, ...FUTURE_CONTRIBUTION_FILE_KEYS]) {
    for (const rel of contributions[key] ?? []) {
      if (typeof rel !== 'string' || rel.length === 0) continue;
      out.push({ key, rel, abs: nodePath.resolve(packRoot, rel) });
    }
  }
  return out;
}

export const packsTestCommand: ICommandHandler = {
  name: 'test',
  description:
    'Validate a pack at the given path: the manifest package.json points at (sharkcraft.manifest) and every contribution file it declares. With --load, import each declared contribution module and run the loader (or acceptance predicate) the engine applies to its slot at runtime — every entry it would refuse is an `asset-entry-rejected` error, annotated or not. With --trusted-load, run template renderers. With --typecheck, type-check the manifest + every TS contribution (exit 2 when no TS file could be checked). With --cases, run definePackTest test cases.',
  usage:
    'shrk [--cwd <dir>] packs test <path> [--load] [--trusted-load] [--typecheck] [--require-signature] [--cases] [--case <id>] [--update-snapshots] [--allow-empty] [--json]',
  booleanFlags: new Set([
    'load',
    'trusted-load',
    'typecheck',
    'require-signature',
    'cases',
    'update-snapshots',
    'json',
    ALLOW_EMPTY_FLAG,
  ]),
  async run(args: ParsedArgs): Promise<number> {
    const target = args.positional[0];
    if (!target) {
      process.stderr.write(
        'Usage: shrk packs test <path> [--load] [--trusted-load] [--typecheck] [--require-signature] [--cases]\n',
      );
      return 2;
    }
    const cwd = resolveCwd(args);
    const packRoot = nodePath.resolve(cwd, target);
    if (!existsSync(packRoot)) {
      process.stderr.write(`Pack path not found: ${packRoot}\n`);
      return 1;
    }
    // Pack-test runner mode.
    const wantsCases = flagBool(args, 'cases') || flagString(args, 'case');
    if (wantsCases) {
      const { runPackTests, renderPackTestReportText } = await import('@shrkcrft/inspector');
      const caseId = flagString(args, 'case');
      const updateSnapshots = flagBool(args, 'update-snapshots');
      const report = await runPackTests({
        packPath: packRoot,
        ...(caseId ? { caseId } : {}),
        ...(updateSnapshots ? { updateSnapshots: true } : {}),
      });
      // Zero cases ran: nothing was tested. 2, unless --allow-empty accepts it.
      const casesSettled = settleVerdict(report.failed === 0 ? 0 : 1, [
        {
          unit: 'pack test cases',
          expected: report.ran,
          examined: report.ran,
          ...(report.ran === 0 ? { reason: report.testsFile ? 'no case ran' : 'no pack-tests file found' } : {}),
          ...allowEmptyValve(args, report.ran),
        },
      ]);
      if (flagBool(args, 'json')) {
        process.stdout.write(
          JSON.stringify(
            { ...report, exitCode: casesSettled.exit, verdict: casesSettled.verdict, shortfalls: casesSettled.shortfalls },
            null,
            2,
          ) + '\n',
        );
        return casesSettled.exit;
      }
      process.stdout.write(renderPackTestReportText(report));
      const casesLine = verdictLine(casesSettled, '');
      if (casesLine) process.stdout.write(`\n${casesLine}\n`);
      if (casesSettled.exit === 2 && report.ran === 0) {
        process.stdout.write(`Pass --${ALLOW_EMPTY_FLAG} to accept a pack with no test case explicitly.\n`);
      }
      return casesSettled.exit;
    }
    const pkgPath = nodePath.join(packRoot, 'package.json');
    if (!existsSync(pkgPath)) {
      process.stderr.write(`Pack is missing package.json: ${pkgPath}\n`);
      return 1;
    }
    const fs = await import('node:fs');
    let pkg: Record<string, unknown> = {};
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
    } catch (e) {
      process.stderr.write(`Failed to read package.json: ${(e as Error).message}\n`);
      return 1;
    }
    const issues: IPackTestIssue[] = [];
    if (typeof pkg.name !== 'string') {
      issues.push({ code: 'missing-name', message: 'package.json: name is required', severity: 'error' });
    }
    if (typeof pkg.version !== 'string') {
      issues.push({ code: 'missing-version', message: 'package.json: version is required', severity: 'error' });
    }

    // The manifest is what discovery reads — from package.json, never a
    // hard-coded list of asset paths.
    const read = await readPackManifest(packRoot);
    if (!read.manifestPath) {
      issues.push({
        code: 'no-manifest',
        message: `package.json does not point at a manifest (${read.error ?? 'sharkcraft.manifest missing'}) — discovery reports this pack INVALID`,
        severity: 'error',
      });
    } else if (!read.manifest) {
      issues.push({ code: 'manifest-load-failed', message: read.error ?? 'manifest failed to load', severity: 'error' });
    } else {
      for (const i of validatePackManifest(read.manifest).issues) {
        issues.push({ code: 'manifest-invalid', message: `${i.field}: ${i.message}`, severity: 'error' });
      }
    }
    const declared = declaredContributions(packRoot, read.manifest);
    for (const d of declared) {
      if (!existsSync(d.abs)) {
        issues.push({
          code: 'missing-asset',
          message: `manifest ${d.key} declares ${d.rel}, but the file is missing`,
          severity: 'error',
        });
      }
    }
    if (flagBool(args, 'require-signature') && !read.manifest?.signature) {
      issues.push({
        code: 'missing-signature',
        message: 'Pack has no signed manifest — run `shrk packs sign <pack>` first',
        severity: 'error',
      });
    }

    const coverage: IVerdictCoverage[] = [];
    const wantLoad = flagBool(args, 'load') || flagBool(args, 'trusted-load');
    const trustedLoad = flagBool(args, 'trusted-load');
    const loadResults: IRuntimePackTestResult['modules'] = [];
    const rejectedKinds = new Set<ContributionKind>();
    if (wantLoad) {
      const r = await runRuntimePackTest({ packRoot, trustedLoad, manifestPath: read.manifestPath, declared });
      issues.push(...r.issues);
      loadResults.push(...r.modules);
      for (const k of r.rejectedKinds) rejectedKinds.add(k);
      const contributionModules = r.modules.filter((m) => m.kind !== 'plugin-entry');
      coverage.push({
        unit: 'contribution modules',
        expected: contributionModules.length,
        examined: contributionModules.filter((m) => m.loaded).length,
        reason: contributionModules.length === 0 ? 'the manifest declares no importable contribution file' : 'failed to import',
        ...allowEmptyValve(args, contributionModules.length),
      });
    }
    let typecheck: ITypecheckFilesResult | undefined;
    if (flagBool(args, 'typecheck')) {
      typecheck = typecheckPackAssets({ packageRoot: packRoot, manifestPath: read.manifestPath, manifest: read.manifest });
      for (const e of typecheck.errors) {
        issues.push({
          code: 'typecheck-error',
          message: `${nodePath.relative(packRoot, e.file) || e.file}:${e.line}:${e.column} TS${e.code} ${e.message}`,
          severity: 'error',
        });
      }
      coverage.push({
        unit: 'TS files',
        expected: typecheck.checkedFiles.length,
        examined: typecheck.ran ? typecheck.checkedFiles.length : 0,
        root: packRoot,
        ...(typecheck.note ? { reason: typecheck.note } : {}),
      });
    }

    // What the default run (no --load / --typecheck) examines: every declared
    // contribution file's existence. A manifest declaring none examined
    // nothing: 2, unless --allow-empty accepts it explicitly.
    coverage.push({
      unit: 'declared contribution files',
      expected: declared.length,
      examined: declared.length,
      ...(declared.length === 0
        ? { reason: read.manifest ? 'the manifest declares no contribution file' : 'no manifest to read contributions from' }
        : {}),
      ...allowEmptyValve(args, declared.length),
    });
    const counts = {
      assets: declared.filter((d) => existsSync(d.abs)).length,
      total: declared.length,
    };
    // The runtime validator caught a rejected entry; an annotated asset makes
    // `--typecheck` catch it at build time (round 12, 12.1f) — say so once per kind.
    const suggestions =
      rejectedKinds.size > 0 && !flagBool(args, 'typecheck')
        ? [...rejectedKinds].sort().map((k) => rejectedEntryTypecheckHint(k, target))
        : [];
    const errors = issues.filter((i) => i.severity === 'error');
    const settled = settleVerdict(errors.length === 0 ? 0 : 1, coverage);
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          packRoot,
          packageName: pkg.name,
          manifest: read.manifestPath,
          counts,
          issues,
          loaded: wantLoad,
          trustedLoad,
          modules: loadResults,
          ...(typecheck
            ? {
                typecheck: {
                  ran: typecheck.ran,
                  checkedFiles: typecheck.checkedFiles.map((f) => nodePath.relative(packRoot, f) || f),
                  errors: typecheck.errors.length,
                  ...(typecheck.note ? { note: typecheck.note } : {}),
                },
              }
            : {}),
          ...(suggestions.length > 0 ? { suggestions } : {}),
          passed: settled.exit === 0,
          exitCode: settled.exit,
          verdict: settled.verdict,
          shortfalls: settled.shortfalls,
        }) + '\n',
      );
      return settled.exit;
    }
    process.stdout.write(header(`Pack test: ${pkg.name ?? '(unknown)'}`));
    process.stdout.write(kv('packRoot', packRoot) + '\n');
    process.stdout.write(kv('manifest', read.manifestPath ?? '(none)') + '\n');
    process.stdout.write(kv('assets', `${counts.assets}/${counts.total} declared contribution file(s) present`) + '\n');
    if (wantLoad) {
      process.stdout.write(kv('mode', trustedLoad ? 'load (trusted)' : 'load (read-only)') + '\n');
      process.stdout.write(kv('modules', String(loadResults.length)) + '\n');
    }
    if (typecheck) {
      process.stdout.write(
        kv(
          'typecheck',
          `${typecheck.ran ? typecheck.checkedFiles.length : 0} TS file(s) checked, ${typecheck.errors.length} error(s)`,
        ) + '\n',
      );
    }
    for (const i of issues) {
      process.stdout.write(`  ${i.severity.toUpperCase().padEnd(8)} ${i.code.padEnd(28)} ${i.message}\n`);
    }
    for (const s of suggestions) process.stdout.write(`  ↳ ${s}\n`);
    if (settled.exit === 1) process.stdout.write('\nVerdict: pack has issues\n');
    const line = verdictLine(settled, issues.length === 0 ? '\nNo issues found.' : '\nVerdict: OK ✓');
    if (line) process.stdout.write(`${settled.exit === 0 ? '' : '\n'}${line}\n`);
    if (settled.exit === 2 && declared.length === 0) {
      process.stdout.write(`Pass --${ALLOW_EMPTY_FLAG} to accept a pack that declares no contribution file explicitly.\n`);
    }
    return settled.exit;
  },
};

interface IRuntimePackTestInput {
  packRoot: string;
  trustedLoad: boolean;
  manifestPath: string | null;
  declared: readonly IDeclaredContribution[];
}

interface IRuntimePackTestResult {
  issues: IPackTestIssue[];
  modules: Array<{
    relativePath: string;
    kind: string;
    loaded: boolean;
    arrayLength?: number;
    exportShape?: string;
    error?: string;
    /** Entries the slot's runtime loader accepted / refused (round 12). */
    accepted?: number;
    rejected?: number;
  }>;
  /** Contribution kinds with at least one entry the runtime loader refuses. */
  rejectedKinds: ContributionKind[];
}

async function runRuntimePackTest(
  input: IRuntimePackTestInput,
): Promise<IRuntimePackTestResult> {
  const { packRoot, trustedLoad } = input;
  const issues: IPackTestIssue[] = [];
  const modules: IRuntimePackTestResult['modules'] = [];
  const rejectedKinds = new Set<ContributionKind>();

  // We require Bun for TS module evaluation; document the limitation and bail
  // gracefully when running under plain Node.
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
  if (!isBun) {
    issues.push({
      code: 'runtime-load-requires-bun',
      message:
        'packs test --load can only evaluate raw .ts assets under Bun. Run under Bun (`bun run shrk packs test ...`) or pre-build the pack to dist/.',
      severity: 'warning',
    });
  }

  // The manifest module (TS/JS): import it and validate what it exports.
  const entry = input.manifestPath;
  if (entry && !entry.endsWith('.json') && existsSync(entry)) {
    const relativePath = nodePath.relative(packRoot, entry) || entry;
    try {
      const mod = (await importModuleViaLoader(entry)) as { default?: unknown } | unknown;
      const value = (mod as { default?: unknown }).default ?? mod;
      modules.push({ relativePath, kind: 'plugin-entry', loaded: true, exportShape: describeShape(value) });
      const v = validatePackManifest(value);
      if (!v.valid) {
        issues.push({
          code: 'plugin-entry-shape',
          message: `${relativePath} default export is not a valid pack manifest: ${v.issues.map((i) => `${i.field}: ${i.message}`).join('; ')}`,
          severity: 'error',
        });
      }
    } catch (e) {
      modules.push({ relativePath, kind: 'plugin-entry', loaded: false, error: (e as Error).message });
      issues.push({
        code: 'plugin-entry-throw',
        message: `failed to import the manifest ${relativePath}: ${(e as Error).message}`,
        severity: 'error',
      });
    }
  }

  // Every declared contribution module (docs / markdown are data, not modules).
  for (const d of input.declared) {
    if (!MODULE_FILE.test(d.rel) || !existsSync(d.abs)) continue;
    const kind = ARRAY_OF_IDS_SLOTS[d.key] ?? d.key;
    const relativePath = nodePath.relative(packRoot, d.abs) || d.rel;
    try {
      const mod = (await importModuleViaLoader(d.abs)) as { default?: unknown };
      const value = mod.default;
      const arr = Array.isArray(value) ? value : null;
      // THE runtime loader (or acceptance predicate) of this slot (round 12,
      // 12.1c / 12.1f): an unannotated literal missing a required field is
      // refused here exactly as at load — the old check saw only `id`.
      const validation = await validateContributionFile(d.key, d.abs);
      const rejectedAt = new Set<number>();
      for (const r of validation.rejected) {
        if (r.exportName === undefined || r.exportName === 'default') rejectedAt.add(r.index);
        issues.push({
          code: 'asset-entry-rejected',
          message: `${relativePath} ${formatEntryRejection(r)} — the ${validation.kind ?? d.key} loader refuses it, so it would not take effect`,
          severity: 'error',
        });
      }
      if (validation.rejected.length > 0 && validation.kind) rejectedKinds.add(validation.kind);
      modules.push({
        relativePath,
        kind,
        loaded: true,
        ...(arr ? { arrayLength: arr.length } : {}),
        exportShape: describeShape(value),
        ...(validation.unvalidated ? {} : { accepted: validation.accepted, rejected: validation.rejected.length }),
      });
      if (!(d.key in ARRAY_OF_IDS_SLOTS)) continue;
      if (value === undefined) {
        issues.push({ code: 'asset-no-default-export', message: `${relativePath} has no default export`, severity: 'error' });
        continue;
      }
      if (!arr) {
        issues.push({
          code: 'asset-not-array',
          message: `${relativePath} default export must be an array, got ${describeShape(value)}`,
          severity: 'error',
        });
        continue;
      }
      // Validate that each item has an `id` string (an entry the runtime
      // loader already refused above is reported once, as that).
      for (let i = 0; i < arr.length; i += 1) {
        if (rejectedAt.has(i)) continue;
        const item = arr[i] as Record<string, unknown> | undefined;
        if (!item || typeof item !== 'object' || typeof item.id !== 'string') {
          issues.push({
            code: 'asset-item-missing-id',
            message: `${relativePath}[${i}] is missing a string \`id\``,
            severity: 'error',
          });
          break;
        }
      }
      if (kind === 'template' && trustedLoad) {
        // Best-effort: attempt to render each template's targetPath/content with
        // its default/sample variables. Wrapped in try/catch — any throw is an
        // error issue.
        for (const t of arr as Array<Record<string, unknown>>) {
          const id = String(t.id ?? '?');
          const vars: Record<string, unknown> = {};
          const declaredVars = (t.variables as Array<{ name?: string; default?: unknown }>) ?? [];
          for (const v of declaredVars) {
            if (typeof v.name !== 'string') continue;
            vars[v.name] = v.default ?? defaultVar(v.name);
          }
          try {
            const targetPath = t.targetPath as ((vars: Record<string, unknown>) => string) | undefined;
            if (typeof targetPath === 'function') targetPath(vars);
            const content = t.content as ((vars: Record<string, unknown>) => string) | undefined;
            if (typeof content === 'function') content(vars);
          } catch (e) {
            issues.push({
              code: 'template-render-throw',
              message: `template ${id} threw during render with default vars: ${(e as Error).message}`,
              severity: 'error',
            });
          }
        }
      }
      if (kind === 'pipeline') {
        for (const p of arr as Array<Record<string, unknown>>) {
          if (!Array.isArray(p.steps) || (p.steps as unknown[]).length === 0) {
            issues.push({
              code: 'pipeline-no-steps',
              message: `pipeline ${String(p.id ?? '?')} has no steps`,
              severity: 'warning',
            });
          }
        }
      }
    } catch (e) {
      modules.push({ relativePath, kind, loaded: false, error: (e as Error).message });
      issues.push({
        code: 'asset-throw',
        message: `failed to import ${relativePath}: ${(e as Error).message}`,
        severity: 'error',
      });
    }
  }

  return { issues, modules, rejectedKinds: [...rejectedKinds] };
}

function describeShape(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array(${v.length})`;
  return typeof v;
}

function defaultVar(name: string): string {
  // Cheap defaults so renderers don't throw on undefined for common var names.
  if (/class|service|feature|component/i.test(name)) return 'Sample';
  if (/name|id|slug/i.test(name)) return 'sample';
  return 'sample';
}
