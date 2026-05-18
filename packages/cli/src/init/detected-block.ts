/**
 * Shared "Detected" block builder used by `shrk inspect` and
 * `shrk init`.
 *
 * Given the workspace summary and the cwd, this produces a structured
 * snapshot of what SharkCraft can detect about the project without
 * touching any config it has not been asked to touch. The block is
 * read-only; it never writes files and never executes scripts.
 *
 * Why a shared module: both `inspect` and `init` need the same
 * detection summary to give the user a coherent first-60-second story
 * — "here is what I see; here is what I will do next". Duplicating it
 * across two command files makes it drift.
 */
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { WorkspaceProfile, type IWorkspaceSummary } from '@shrkcrft/workspace';
import { BUILTIN_PRESETS, recommendPresets, type IPreset } from '@shrkcrft/presets';

export enum DetectedConfidence {
  Detected = 'detected',
  Inferred = 'inferred',
  NotFound = 'not-found',
}

export interface IDetectedRow {
  key: string;
  value: string;
  confidence: DetectedConfidence;
  evidence?: string;
}

export interface IDetectedRoots {
  source: readonly string[];
  test: readonly string[];
  packages: readonly string[];
  generated: readonly string[];
}

export interface IDetectedScripts {
  build: string | null;
  test: string | null;
  typecheck: string | null;
  lint: string | null;
  start: string | null;
}

export interface IDetectedConfigs {
  tsconfig: boolean;
  eslint: boolean;
  biome: boolean;
  githubActions: boolean;
  nx: boolean;
  turbo: boolean;
}

export interface IDetectedPresetPick {
  presetId: string;
  title: string;
  confidence: 'high' | 'medium' | 'low';
  reasons: readonly string[];
}

export interface IDetectedBlock {
  workspaceFlavor: string;
  packageManager: string;
  frameworks: readonly string[];
  hasTypeScript: boolean;
  roots: IDetectedRoots;
  scripts: IDetectedScripts;
  configs: IDetectedConfigs;
  recommendedPreset: IDetectedPresetPick | null;
  notGuessed: readonly string[];
}

const SOURCE_DIR_CANDIDATES = ['src', 'lib', 'app', 'source'] as const;
const TEST_DIR_CANDIDATES = ['tests', 'test', '__tests__', 'spec', 'specs'] as const;
const PACKAGE_DIR_CANDIDATES = ['packages', 'libs', 'apps'] as const;
const GENERATED_DIR_CANDIDATES = ['dist', 'build', 'out', 'coverage', '.next', '.turbo'] as const;

function fileExists(root: string, rel: string): boolean {
  return existsSync(nodePath.join(root, rel));
}

function detectRoots(cwd: string): IDetectedRoots {
  return {
    source: SOURCE_DIR_CANDIDATES.filter((d) => fileExists(cwd, d)),
    test: TEST_DIR_CANDIDATES.filter((d) => fileExists(cwd, d)),
    packages: PACKAGE_DIR_CANDIDATES.filter((d) => fileExists(cwd, d)),
    generated: GENERATED_DIR_CANDIDATES.filter((d) => fileExists(cwd, d)),
  };
}

function pickScript(
  scripts: Record<string, string>,
  prefer: readonly string[],
  contains: readonly string[],
): string | null {
  for (const name of prefer) {
    if (typeof scripts[name] === 'string' && scripts[name]!.trim() !== '') return name;
  }
  for (const [name, body] of Object.entries(scripts)) {
    if (typeof body !== 'string') continue;
    for (const needle of contains) {
      if (body.includes(needle) || name.includes(needle)) return name;
    }
  }
  return null;
}

function detectScripts(summary: IWorkspaceSummary): IDetectedScripts {
  const scripts = summary.scripts;
  return {
    build: pickScript(scripts, ['build', 'build:dist'], ['build']),
    test: pickScript(scripts, ['test'], ['bun test', 'jest', 'vitest', 'mocha']),
    typecheck: pickScript(scripts, ['typecheck', 'tsc', 'type-check'], ['tsc']),
    lint: pickScript(scripts, ['lint'], ['eslint', 'biome']),
    start: pickScript(scripts, ['start', 'dev', 'serve'], ['start', 'serve', 'dev']),
  };
}

function detectConfigs(cwd: string, summary: IWorkspaceSummary): IDetectedConfigs {
  return {
    tsconfig: summary.tsConfig !== null,
    eslint:
      fileExists(cwd, '.eslintrc') ||
      fileExists(cwd, '.eslintrc.js') ||
      fileExists(cwd, '.eslintrc.cjs') ||
      fileExists(cwd, '.eslintrc.json') ||
      fileExists(cwd, '.eslintrc.yaml') ||
      fileExists(cwd, '.eslintrc.yml') ||
      fileExists(cwd, 'eslint.config.js') ||
      fileExists(cwd, 'eslint.config.mjs') ||
      fileExists(cwd, 'eslint.config.cjs') ||
      fileExists(cwd, 'eslint.config.ts') ||
      summary.profiles.includes(WorkspaceProfile.HasEslint),
    biome:
      fileExists(cwd, 'biome.json') ||
      fileExists(cwd, 'biome.jsonc') ||
      summary.profiles.includes(WorkspaceProfile.HasBiome),
    githubActions:
      fileExists(cwd, '.github/workflows') ||
      summary.profiles.includes(WorkspaceProfile.HasGithubActions),
    nx: summary.profiles.includes(WorkspaceProfile.HasNx) || fileExists(cwd, 'nx.json'),
    turbo:
      summary.profiles.includes(WorkspaceProfile.HasTurborepo) || fileExists(cwd, 'turbo.json'),
  };
}

function detectWorkspaceFlavor(summary: IWorkspaceSummary, configs: IDetectedConfigs): string {
  if (configs.nx) return 'Nx workspace';
  if (configs.turbo) return 'Turborepo workspace';
  if (summary.profiles.includes(WorkspaceProfile.HasPackageWorkspaces)) {
    return 'npm/pnpm/yarn workspaces';
  }
  if (summary.profiles.includes(WorkspaceProfile.IsMonorepo)) {
    return 'monorepo (untyped)';
  }
  return 'single package';
}

function pickRecommendedPreset(summary: IWorkspaceSummary): IDetectedPresetPick | null {
  const recs = recommendPresets([...BUILTIN_PRESETS], {
    profiles: summary.profiles,
    limit: 1,
  });
  const top = recs[0];
  if (!top) return null;
  const preset: IPreset = top.preset;
  return {
    presetId: preset.id,
    title: preset.title,
    confidence: top.confidence,
    reasons: top.reasons,
  };
}

function notGuessedFor(roots: IDetectedRoots, configs: IDetectedConfigs): readonly string[] {
  const missing: string[] = [];
  if (roots.source.length === 0) missing.push('source roots (no src/lib/app dir detected)');
  if (roots.test.length === 0) missing.push('test roots (no tests/test/__tests__ dir detected)');
  if (!configs.tsconfig) missing.push('tsconfig.json (no TypeScript config detected)');
  if (!configs.eslint && !configs.biome) {
    missing.push('lint config (no ESLint or Biome config detected)');
  }
  return missing;
}

export function buildDetectedBlock(cwd: string, summary: IWorkspaceSummary): IDetectedBlock {
  const roots = detectRoots(cwd);
  const configs = detectConfigs(cwd, summary);
  const scripts = detectScripts(summary);
  return {
    workspaceFlavor: detectWorkspaceFlavor(summary, configs),
    packageManager: summary.packageManager.manager,
    frameworks: summary.frameworks.map((f) => f.name),
    hasTypeScript: summary.hasTypeScript,
    roots,
    scripts,
    configs,
    recommendedPreset: pickRecommendedPreset(summary),
    notGuessed: notGuessedFor(roots, configs),
  };
}

/**
 * Render the Detected block as plain text lines (one per line, no
 * trailing newline). Callers add their own header / spacing.
 */
export function renderDetectedBlockText(block: IDetectedBlock): string {
  const lines: string[] = [];
  const pad = (k: string): string => `  ${k.padEnd(20)}`;
  lines.push(`${pad('workspace flavor')} ${block.workspaceFlavor}`);
  lines.push(`${pad('package manager')} ${block.packageManager}`);
  lines.push(
    `${pad('frameworks')} ${block.frameworks.length ? block.frameworks.join(', ') : '(none)'}`,
  );
  lines.push(`${pad('typescript')} ${block.hasTypeScript ? 'yes' : 'no'}`);
  lines.push(
    `${pad('source roots')} ${block.roots.source.length ? block.roots.source.join(', ') : '(not detected)'}`,
  );
  lines.push(
    `${pad('test roots')} ${block.roots.test.length ? block.roots.test.join(', ') : '(not detected)'}`,
  );
  if (block.roots.packages.length) {
    lines.push(`${pad('package roots')} ${block.roots.packages.join(', ')}`);
  }
  if (block.roots.generated.length) {
    lines.push(`${pad('generated dirs')} ${block.roots.generated.join(', ')}`);
  }
  lines.push(
    `${pad('scripts')} ${[
      block.scripts.build && `build=${block.scripts.build}`,
      block.scripts.test && `test=${block.scripts.test}`,
      block.scripts.typecheck && `typecheck=${block.scripts.typecheck}`,
      block.scripts.lint && `lint=${block.scripts.lint}`,
      block.scripts.start && `start=${block.scripts.start}`,
    ]
      .filter(Boolean)
      .join(' ') || '(none detected)'}`,
  );
  lines.push(
    `${pad('configs')} ${[
      block.configs.tsconfig && 'tsconfig',
      block.configs.eslint && 'eslint',
      block.configs.biome && 'biome',
      block.configs.githubActions && 'github-actions',
      block.configs.nx && 'nx.json',
      block.configs.turbo && 'turbo.json',
    ]
      .filter(Boolean)
      .join(', ') || '(none detected)'}`,
  );
  if (block.recommendedPreset) {
    lines.push(
      `${pad('recommended preset')} ${block.recommendedPreset.presetId} (${block.recommendedPreset.confidence})`,
    );
  } else {
    lines.push(`${pad('recommended preset')} (none matched — would fall back to generic)`);
  }
  if (block.notGuessed.length) {
    lines.push('  not guessed:');
    for (const n of block.notGuessed) {
      lines.push(`    • ${n}`);
    }
  }
  return lines.join('\n');
}
