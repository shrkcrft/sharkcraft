#!/usr/bin/env bun
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const PACKAGES_DIR = join(ROOT, 'packages');

const SHARED = {
  license: 'MIT',
  author: 'SharkCraft contributors',
  repository: {
    type: 'git',
    url: 'https://github.com/shrkcrft/sharkcraft.git',
  },
  homepage: 'https://github.com/shrkcrft/sharkcraft',
  bugs: { url: 'https://github.com/shrkcrft/sharkcraft/issues' },
  publishConfig: { access: 'public' },
  engines: { bun: '>=1.1.0', node: '>=18' },
};

const META: Record<
  string,
  { description: string; keywords: readonly string[]; directory: string }
> = {
  core: {
    description:
      'SharkCraft core primitives: Result, AppError, logger, file-system abstraction, path/string/object utils, IDs.',
    keywords: ['sharkcraft', 'core', 'result', 'error', 'logger', 'path'],
    directory: 'packages/core',
  },
  config: {
    description:
      'SharkCraft config loader: sharkcraft.config.ts discovery, defaults, zod-validated schema.',
    keywords: ['sharkcraft', 'config', 'loader', 'zod'],
    directory: 'packages/config',
  },
  workspace: {
    description:
      'SharkCraft workspace inspector: project root, package.json, package manager, frameworks, tsconfig.',
    keywords: ['sharkcraft', 'workspace', 'project-root', 'frameworks'],
    directory: 'packages/workspace',
  },
  knowledge: {
    description:
      'SharkCraft structured knowledge model: typed entries, index, search, loaders (TS + markdown), validation.',
    keywords: ['sharkcraft', 'knowledge', 'rules', 'retrieval', 'ai'],
    directory: 'packages/knowledge',
  },
  context: {
    description: 'SharkCraft AI context builder: token-budgeted relevance retrieval for tasks.',
    keywords: ['sharkcraft', 'context', 'ai', 'token-budget', 'mcp'],
    directory: 'packages/context',
  },
  rules: {
    description: 'SharkCraft rules service: typed rule entries, relevance lookup, AI formatting.',
    keywords: ['sharkcraft', 'rules', 'coding-standards', 'ai'],
    directory: 'packages/rules',
  },
  paths: {
    description: 'SharkCraft path-convention service: typed path entries and best-fit selection.',
    keywords: ['sharkcraft', 'paths', 'conventions'],
    directory: 'packages/paths',
  },
  templates: {
    description:
      'SharkCraft templates: typed template definitions, registry, variable validation, rendering.',
    keywords: ['sharkcraft', 'templates', 'generator', 'codegen'],
    directory: 'packages/templates',
  },
  generator: {
    description: 'SharkCraft plan-first generator: GenerationPlan, FileChange, dry-run, safe writes.',
    keywords: ['sharkcraft', 'generator', 'codegen', 'dry-run'],
    directory: 'packages/generator',
  },
  inspector: {
    description: 'SharkCraft inspector: project overview, doctor checks, AI-agent instructions.',
    keywords: ['sharkcraft', 'inspector', 'doctor'],
    directory: 'packages/inspector',
  },
  ai: {
    description: 'SharkCraft AI provider abstraction: Claude HTTP + Claude CLI adapters.',
    keywords: ['sharkcraft', 'ai', 'claude', 'anthropic'],
    directory: 'packages/ai',
  },
  'plugin-api': {
    description: 'SharkCraft plugin API: extension points for commands, knowledge, templates, MCP tools.',
    keywords: ['sharkcraft', 'plugin-api'],
    directory: 'packages/plugin-api',
  },
  shared: {
    description: 'SharkCraft shared internals.',
    keywords: ['sharkcraft', 'shared'],
    directory: 'packages/shared',
  },
  cli: {
    description:
      "SharkCraft CLI (`shrk`): structured project intelligence for AI coding agents.",
    keywords: ['sharkcraft', 'cli', 'shrk', 'ai-agent', 'mcp'],
    directory: 'packages/cli',
  },
  'mcp-server': {
    description:
      "SharkCraft MCP server: 25 tools over @modelcontextprotocol/sdk's stdio transport.",
    keywords: ['sharkcraft', 'mcp', 'modelcontextprotocol', 'ai-agent', 'claude'],
    directory: 'packages/mcp-server',
  },
};

const packages = readdirSync(PACKAGES_DIR);
let updated = 0;

for (const pkg of packages) {
  const pkgJson = join(PACKAGES_DIR, pkg, 'package.json');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(pkgJson, 'utf8'));
  } catch {
    continue;
  }
  const meta = META[pkg];
  if (!meta) {
    process.stderr.write(`[fill] no metadata defined for ${pkg}\n`);
    continue;
  }

  // Place metadata fields in a stable order. Preserve existing dependencies/scripts.
  const ordered: Record<string, unknown> = {
    name: parsed.name,
    version: parsed.version,
    description: meta.description,
    license: SHARED.license,
    author: SHARED.author,
    type: parsed.type ?? 'module',
    main: parsed.main,
    types: parsed.types,
    exports: parsed.exports,
    bin: parsed.bin,
    files: parsed.files ?? ['src'],
    repository: { ...SHARED.repository, directory: meta.directory },
    homepage: SHARED.homepage,
    bugs: SHARED.bugs,
    keywords: meta.keywords,
    engines: SHARED.engines,
    scripts: parsed.scripts,
    dependencies: parsed.dependencies,
    devDependencies: parsed.devDependencies,
    peerDependencies: parsed.peerDependencies,
    publishConfig: SHARED.publishConfig,
  };

  // Drop undefined.
  for (const k of Object.keys(ordered)) {
    if (ordered[k] === undefined) delete ordered[k];
  }

  writeFileSync(pkgJson, JSON.stringify(ordered, null, 2) + '\n', 'utf8');
  updated += 1;
  process.stdout.write(`[fill] updated ${pkg}\n`);
}

process.stdout.write(`[fill] ${updated} package.json files updated\n`);
