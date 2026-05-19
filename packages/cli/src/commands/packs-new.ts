import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';
import { importModuleViaLoader } from '@shrkcrft/core';

export type PackKind = 'generic' | 'framework' | 'architecture' | 'enterprise' | 'platform-adopter';

const VALID_KINDS = new Set<PackKind>([
  'generic',
  'framework',
  'architecture',
  'enterprise',
  'platform-adopter',
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

/** Pure: compute the file set to write. No IO. */
export function planPackScaffold(input: IScaffoldPackInput): IScaffoldPackResult {
  const fullName = input.scope ? `${input.scope}/${input.name}` : input.name;
  const packageJson: Record<string, unknown> = {
    name: fullName,
    version: '0.0.1',
    description: `SharkCraft pack scaffolded as ${input.kind}.`,
    type: 'module',
    main: 'dist/sharkcraft.plugin.js',
    exports: {
      '.': {
        types: './dist/sharkcraft.plugin.d.ts',
        default: './dist/sharkcraft.plugin.js',
      },
    },
    sharkcraft: {
      kind: input.kind,
      ...(input.preset ? { preset: input.preset } : {}),
    },
    scripts: {
      build: 'tsc -p tsconfig.json',
      doctor: 'shrk pack doctor .',
      test: 'shrk pack test .',
    },
    files: ['dist', 'src', 'README.md', 'SECURITY.md', 'package.json'],
  };
  const files: IScaffoldFile[] = [];
  files.push({
    relativePath: 'package.json',
    body: JSON.stringify(packageJson, null, 2) + '\n',
  });
  files.push({
    relativePath: 'README.md',
    body: renderReadme(input, fullName),
  });
  files.push({
    relativePath: 'SECURITY.md',
    body: renderSecurity(input),
  });
  files.push({
    relativePath: 'tsconfig.json',
    body: JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ES2022',
          moduleResolution: 'bundler',
          strict: true,
          declaration: true,
          outDir: 'dist',
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ) + '\n',
  });
  files.push({
    relativePath: 'src/sharkcraft.plugin.ts',
    body: renderPluginEntry(input, fullName),
  });
  files.push({
    relativePath: 'src/assets/knowledge.ts',
    body: renderKnowledgeAsset(input),
  });
  files.push({
    relativePath: 'src/assets/rules.ts',
    body: renderRulesAsset(input),
  });
  files.push({
    relativePath: 'src/assets/paths.ts',
    body: renderPathsAsset(input),
  });
  files.push({
    relativePath: 'src/assets/templates.ts',
    body: renderTemplatesAsset(input),
  });
  files.push({
    relativePath: 'src/assets/pipelines.ts',
    body: renderPipelinesAsset(input),
  });
  files.push({
    relativePath: 'src/assets/presets.ts',
    body: renderPresetsAsset(input),
  });
  files.push({
    relativePath: 'src/assets/docs/overview.md',
    body: renderDocsOverview(input, fullName),
  });
  if (input.kind === 'architecture' || input.withExamples) {
    files.push({
      relativePath: 'src/assets/boundaries.ts',
      body: renderBoundariesAsset(),
    });
  }
  if (input.kind === 'platform-adopter' || input.withExamples) {
    files.push({
      relativePath: 'src/assets/contracts/plugin-contract.example.ts',
      body: renderPluginContractExample(),
    });
  }
  if (input.kind === 'enterprise') {
    files.push({
      relativePath: 'docs/review-workflow.md',
      body: renderEnterpriseReviewDocs(),
    });
    files.push({
      relativePath: 'docs/security-baseline.md',
      body: renderEnterpriseSecurityDocs(),
    });
  }
  return { files, packageJson, packRoot: input.outDir };
}

function renderReadme(input: IScaffoldPackInput, fullName: string): string {
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
    '  sharkcraft.plugin.ts     # entry — registers all assets',
    '  assets/',
    '    knowledge.ts',
    '    rules.ts',
    '    paths.ts',
    '    templates.ts',
    '    pipelines.ts',
    '    presets.ts',
    '    docs/overview.md',
    '```',
    '',
    '## Validate this pack',
    '',
    '```bash',
    'shrk pack doctor .',
    'shrk pack test .',
    'shrk pack sign . --secret "$SHARKCRAFT_PACK_SECRET"',
    'shrk pack verify .',
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
    'shrk pack sign . --secret "$SHARKCRAFT_PACK_SECRET"',
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

function renderPluginEntry(input: IScaffoldPackInput, fullName: string): string {
  return [
    `// SharkCraft plugin entry for ${fullName}.`,
    `// Scaffolded as kind=${input.kind}. Review every asset before publishing.`,
    `import knowledge from './assets/knowledge.ts';`,
    `import rules from './assets/rules.ts';`,
    `import paths from './assets/paths.ts';`,
    `import templates from './assets/templates.ts';`,
    `import pipelines from './assets/pipelines.ts';`,
    `import presets from './assets/presets.ts';`,
    `export default {`,
    `  knowledge,`,
    `  rules,`,
    `  paths,`,
    `  templates,`,
    `  pipelines,`,
    `  presets,`,
    `};`,
    ``,
  ].join('\n');
}

function renderKnowledgeAsset(input: IScaffoldPackInput): string {
  if (input.kind === 'enterprise') {
    return knowledgeBody([
      ['security.baseline', 'Security baseline', 'High', 'Document the security baseline this pack enforces.'],
      ['review.workflow', 'Code review workflow', 'High', 'How code review gets done in this organisation.'],
    ]);
  }
  if (input.kind === 'architecture') {
    return knowledgeBody([
      ['architecture.layering', 'Layering rules', 'High', 'Describe lower → higher layers that cannot be inverted.'],
      ['architecture.coverage', 'Coverage targets', 'Medium', 'Coverage axes you care about.'],
    ]);
  }
  if (input.kind === 'framework') {
    return knowledgeBody([
      ['framework.overview', 'Framework overview', 'High', 'What this framework is for.'],
    ]);
  }
  if (input.kind === 'platform-adopter') {
    return knowledgeBody([
      ['platform.policy', 'Policy capability', 'Medium', 'Describe the policy/capability model your platform exposes.'],
      ['platform.adapter', 'Adapter contract', 'Medium', 'Describe the adapter contract your platform expects.'],
    ]);
  }
  return knowledgeBody([
    ['pack.overview', 'Pack overview', 'Medium', 'Short overview of what this pack contributes.'],
  ]);
}

function knowledgeBody(rows: readonly (readonly [string, string, string, string])[]): string {
  const lines: string[] = [];
  lines.push(`// Knowledge entries contributed by this pack.`);
  lines.push(`export default [`);
  for (const [id, title, priority, content] of rows) {
    lines.push(`  { id: '${id}', title: '${title}', type: 'knowledge', priority: '${priority}',`);
    lines.push(`    summary: '${content}', body: '${content}', tags: [], scope: [] },`);
  }
  lines.push(`];`);
  lines.push('');
  return lines.join('\n');
}

function renderRulesAsset(input: IScaffoldPackInput): string {
  if (input.kind === 'enterprise') {
    return rulesBody([
      ['rule.review-required', 'All changes require code review', 'critical'],
      ['rule.no-secrets-in-source', 'Secrets must never be committed', 'critical'],
    ]);
  }
  if (input.kind === 'architecture') {
    return rulesBody([
      ['rule.boundary-enforcement', 'Respect layer boundaries', 'high'],
    ]);
  }
  return rulesBody([
    ['rule.example', 'Example rule for this pack', 'medium'],
  ]);
}

function rulesBody(rows: readonly (readonly [string, string, string])[]): string {
  const lines: string[] = [];
  lines.push(`export default [`);
  for (const [id, title, priority] of rows) {
    lines.push(`  { id: '${id}', title: '${title}', type: 'rule', priority: '${priority}',`);
    lines.push(`    summary: '${title}', body: '${title}', tags: [], scope: [] },`);
  }
  lines.push(`];`);
  lines.push('');
  return lines.join('\n');
}

function renderPathsAsset(_input: IScaffoldPackInput): string {
  return [
    `export default [`,
    `  // Add path conventions: { id, title, type: 'path', patterns: ['src/**/*.ts'], ... }`,
    `];`,
    ``,
  ].join('\n');
}

function renderTemplatesAsset(input: IScaffoldPackInput): string {
  const examples: string[] = [];
  if (input.kind === 'framework' || input.withExamples) {
    examples.push(
      `  {`,
      `    id: 'pack.example.service',`,
      `    name: 'Example service',`,
      `    description: 'Scaffold an example service for this pack.',`,
      `    tags: ['service'],`,
      `    scope: ['ts'],`,
      `    appliesWhen: ['create-service'],`,
      `    variables: [{ name: 'name', required: true }],`,
      `    targetPath: ({ name }) => 'src/services/' + name + '.service.ts',`,
      `    content: ({ name }) => 'export class ' + (name as string).replace(/-(\\w)/g, (_m, c) => c.toUpperCase()) + 'Service {}\\n',`,
      `  },`,
    );
  }
  return [
    `export default [`,
    ...examples,
    `];`,
    ``,
  ].join('\n');
}

function renderPipelinesAsset(input: IScaffoldPackInput): string {
  if (input.kind === 'framework' || input.withExamples) {
    return [
      `export default [`,
      `  {`,
      `    id: 'pack.example.pipeline',`,
      `    title: 'Example pipeline',`,
      `    description: 'Reference pipeline for this pack.',`,
      `    steps: ['plan', 'review', 'apply', 'verify'],`,
      `    appliesWhen: ['create-service'],`,
      `  },`,
      `];`,
      ``,
    ].join('\n');
  }
  return ['export default [];', ''].join('\n');
}

function renderPresetsAsset(input: IScaffoldPackInput): string {
  if (input.preset) {
    return [
      `export default [`,
      `  {`,
      `    id: '${input.preset}',`,
      `    title: '${input.preset}',`,
      `    description: 'Preset for this pack.',`,
      `    appliesWhen: ['create-service'],`,
      `    config: {},`,
      `  },`,
      `];`,
      ``,
    ].join('\n');
  }
  return ['export default [];', ''].join('\n');
}

function renderBoundariesAsset(): string {
  return [
    `export default [`,
    `  // Example architecture boundary:`,
    `  // {`,
    `  //   id: 'boundary.layer.example',`,
    `  //   title: 'Example layer boundary',`,
    `  //   severity: 'error',`,
    `  //   from: ['packages/lower/**/*.ts'],`,
    `  //   forbiddenImports: ['@my/higher'],`,
    `  // },`,
    `];`,
    ``,
  ].join('\n');
}

function renderPluginContractExample(): string {
  return [
    `// Example: an adapter-style plugin contract.`,
    `// Replace with the actual interface your platform expects.`,
    `export interface IPluginCapability {`,
    `  id: string;`,
    `  invoke(input: unknown): Promise<unknown>;`,
    `}`,
    ``,
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
    'This pack ships:',
    '',
    '- knowledge entries',
    '- rules',
    '- path conventions',
    '- templates',
    '- pipelines',
    '- presets',
    '',
  ]
    .filter(Boolean)
    .join('\n') + '\n';
}

// ─── CLI handler ─────────────────────────────────────────────────────────────

export const packsNewCommand: ICommandHandler = {
  name: 'new',
  description:
    'Scaffold a new SharkCraft pack package (rules / paths / templates / pipelines / presets / boundaries). Dry-run by default — pass --write to materialize. No install, no publish, no overwrite without --force.',
  usage:
    'shrk [--cwd <dir>] packs new <name> [--scope @org] [--preset <id>] [--kind generic|framework|architecture|enterprise|platform-adopter] [--with-examples] [--write] [--force] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const name = args.positional[0];
    if (!name) {
      process.stderr.write(
        'Usage: shrk packs new <name> [--scope @org] [--preset <id>] [--kind generic|framework|architecture|enterprise|platform-adopter] [--with-examples] [--write]\n',
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
    process.stdout.write(
      '\nNext: `shrk pack doctor ' + outDir + '`  |  `shrk pack test ' + outDir + '`\n',
    );
    return 0;
  },
};

// ─── shrk pack test ──────────────────────────────────────────────────────────

interface IPackTestIssue {
  code: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
}

export const packsTestCommand: ICommandHandler = {
  name: 'test',
  description:
    'Validate a pack at the given path: manifest validation, asset references, signature optional. With --load, import contribution files. With --trusted-load, run template renderers. With --cases, run definePackTest test cases.',
  usage:
    'shrk [--cwd <dir>] packs test <path> [--load] [--trusted-load] [--require-signature] [--cases] [--case <id>] [--update-snapshots] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const target = args.positional[0];
    if (!target) {
      process.stderr.write(
        'Usage: shrk packs test <path> [--load] [--trusted-load] [--require-signature] [--cases]\n',
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
      if (flagBool(args, 'json')) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        return report.failed === 0 ? 0 : 1;
      }
      process.stdout.write(renderPackTestReportText(report));
      return report.failed === 0 ? 0 : 1;
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
    const requiredAssets = [
      'src/sharkcraft.plugin.ts',
      'src/assets/rules.ts',
      'src/assets/paths.ts',
      'src/assets/templates.ts',
      'src/assets/pipelines.ts',
      'src/assets/presets.ts',
      'src/assets/knowledge.ts',
    ];
    for (const rel of requiredAssets) {
      if (!existsSync(nodePath.join(packRoot, rel))) {
        issues.push({
          code: 'missing-asset',
          message: `Pack is missing expected asset file: ${rel}`,
          severity: 'warning',
        });
      }
    }
    if (flagBool(args, 'require-signature')) {
      const distManifest = nodePath.join(packRoot, 'dist', 'manifest.json');
      if (!existsSync(distManifest)) {
        issues.push({
          code: 'missing-signature',
          message: 'Pack is missing dist/manifest.json — run `shrk pack sign` first',
          severity: 'error',
        });
      }
    }

    const wantLoad = flagBool(args, 'load') || flagBool(args, 'trusted-load');
    const trustedLoad = flagBool(args, 'trusted-load');
    const loadResults: Array<Record<string, unknown>> = [];
    if (wantLoad) {
      const r = await runRuntimePackTest({ packRoot, trustedLoad });
      issues.push(...r.issues);
      loadResults.push(...r.modules);
    }

    const counts = {
      assets: requiredAssets.filter((rel) => existsSync(nodePath.join(packRoot, rel))).length,
      total: requiredAssets.length,
    };
    const errors = issues.filter((i) => i.severity === 'error');
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          packRoot,
          packageName: pkg.name,
          counts,
          issues,
          loaded: wantLoad,
          trustedLoad,
          modules: loadResults,
          passed: errors.length === 0,
        }) + '\n',
      );
      return errors.length === 0 ? 0 : 1;
    }
    process.stdout.write(header(`Pack test: ${pkg.name ?? '(unknown)'}`));
    process.stdout.write(kv('packRoot', packRoot) + '\n');
    process.stdout.write(kv('assets', `${counts.assets}/${counts.total}`) + '\n');
    if (wantLoad) {
      process.stdout.write(kv('mode', trustedLoad ? 'load (trusted)' : 'load (read-only)') + '\n');
      process.stdout.write(kv('modules', String(loadResults.length)) + '\n');
    }
    if (issues.length === 0) {
      process.stdout.write('\nNo issues found.\n');
      return 0;
    }
    for (const i of issues) {
      process.stdout.write(`  ${i.severity.toUpperCase().padEnd(8)} ${i.code.padEnd(28)} ${i.message}\n`);
    }
    process.stdout.write(`\nVerdict: ${errors.length === 0 ? 'OK ✓' : 'pack has issues'}\n`);
    return errors.length === 0 ? 0 : 1;
  },
};

interface IRuntimePackTestInput {
  packRoot: string;
  trustedLoad: boolean;
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
  }>;
}

async function runRuntimePackTest(
  input: IRuntimePackTestInput,
): Promise<IRuntimePackTestResult> {
  const { packRoot, trustedLoad } = input;
  const issues: IPackTestIssue[] = [];
  const modules: IRuntimePackTestResult['modules'] = [];
  const fs = await import('node:fs');

  // We require Bun for TS module evaluation; document the limitation and bail
  // gracefully when running under plain Node.
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
  if (!isBun) {
    issues.push({
      code: 'runtime-load-requires-bun',
      message:
        'pack test --load can only evaluate raw .ts assets under Bun. Run under Bun (`bun run shrk pack test ...`) or pre-build the pack to dist/.',
      severity: 'warning',
    });
  }

  // Plugin entry: import to ensure asset wiring resolves.
  const entry = nodePath.join(packRoot, 'src', 'sharkcraft.plugin.ts');
  if (existsSync(entry)) {
    try {
      const { pathToFileURL } = await import('node:url');
      const mod = (await importModuleViaLoader(entry)) as
        | { default?: unknown }
        | unknown;
      const value = (mod as { default?: unknown }).default ?? mod;
      const shape = describeShape(value);
      modules.push({
        relativePath: 'src/sharkcraft.plugin.ts',
        kind: 'plugin-entry',
        loaded: true,
        exportShape: shape,
      });
      if (typeof value !== 'object' || value === null) {
        issues.push({
          code: 'plugin-entry-shape',
          message: 'src/sharkcraft.plugin.ts default export must be an object',
          severity: 'error',
        });
      }
    } catch (e) {
      modules.push({
        relativePath: 'src/sharkcraft.plugin.ts',
        kind: 'plugin-entry',
        loaded: false,
        error: (e as Error).message,
      });
      issues.push({
        code: 'plugin-entry-throw',
        message: `failed to import plugin entry: ${(e as Error).message}`,
        severity: 'error',
      });
    }
  }

  // Asset files: every required asset should export an array.
  const assetRels: { rel: string; kind: string }[] = [
    { rel: 'src/assets/knowledge.ts', kind: 'knowledge' },
    { rel: 'src/assets/rules.ts', kind: 'rule' },
    { rel: 'src/assets/paths.ts', kind: 'path' },
    { rel: 'src/assets/templates.ts', kind: 'template' },
    { rel: 'src/assets/pipelines.ts', kind: 'pipeline' },
    { rel: 'src/assets/presets.ts', kind: 'preset' },
    { rel: 'src/assets/boundaries.ts', kind: 'boundary' },
  ];
  for (const a of assetRels) {
    const full = nodePath.join(packRoot, a.rel);
    if (!existsSync(full)) continue;
    try {
      const { pathToFileURL } = await import('node:url');
      const mod = (await importModuleViaLoader(full)) as {
        default?: unknown;
      };
      const value = mod.default;
      const arr = Array.isArray(value) ? value : null;
      modules.push({
        relativePath: a.rel,
        kind: a.kind,
        loaded: true,
        ...(arr ? { arrayLength: arr.length } : {}),
        exportShape: describeShape(value),
      });
      if (value === undefined) {
        issues.push({
          code: 'asset-no-default-export',
          message: `${a.rel} has no default export`,
          severity: 'error',
        });
        continue;
      }
      if (!arr) {
        issues.push({
          code: 'asset-not-array',
          message: `${a.rel} default export must be an array, got ${describeShape(value)}`,
          severity: 'error',
        });
        continue;
      }
      // Validate that each item has an `id` string.
      for (let i = 0; i < arr.length; i += 1) {
        const item = arr[i] as Record<string, unknown> | undefined;
        if (!item || typeof item !== 'object' || typeof item.id !== 'string') {
          issues.push({
            code: 'asset-item-missing-id',
            message: `${a.rel}[${i}] is missing a string \`id\``,
            severity: 'error',
          });
          break;
        }
      }
      if (a.kind === 'template' && trustedLoad) {
        // Best-effort: attempt to render each template's targetPath/content with
        // its default/sample variables. Wrapped in try/catch — any throw is an
        // error issue.
        for (const t of arr as Array<Record<string, unknown>>) {
          const id = String(t.id ?? '?');
          const vars: Record<string, unknown> = {};
          const declared = (t.variables as Array<{ name?: string; default?: unknown }>) ?? [];
          for (const v of declared) {
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
      if (a.kind === 'pipeline') {
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
      modules.push({
        relativePath: a.rel,
        kind: a.kind,
        loaded: false,
        error: (e as Error).message,
      });
      issues.push({
        code: 'asset-throw',
        message: `failed to import ${a.rel}: ${(e as Error).message}`,
        severity: 'error',
      });
    }
  }

  return { issues, modules };
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
