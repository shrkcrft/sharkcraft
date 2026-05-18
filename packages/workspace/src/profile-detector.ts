import type { IPackageJson } from './package-json-reader.ts';
import type { IFrameworkInfo } from './framework-detector.ts';

export enum WorkspaceProfile {
  HasBun = 'has-bun',
  HasTypeScript = 'has-typescript',
  HasNx = 'has-nx',
  HasTurborepo = 'has-turborepo',
  HasReact = 'has-react',
  HasNext = 'has-next',
  HasAngular = 'has-angular',
  HasVue = 'has-vue',
  HasNestJS = 'has-nestjs',
  HasMcpSdk = 'has-mcp-sdk',
  HasTests = 'has-tests',
  HasEslint = 'has-eslint',
  HasBiome = 'has-biome',
  HasVitest = 'has-vitest',
  HasJest = 'has-jest',
  HasBunTest = 'has-bun-test',
  HasGithubActions = 'has-github-actions',
  HasPackageWorkspaces = 'has-package-workspaces',
  IsLibrary = 'is-library',
  IsService = 'is-service',
  IsMonorepo = 'is-monorepo',
  IsFrontend = 'is-frontend',
  IsBackend = 'is-backend',
}

export interface IProfileEvidence {
  profile: WorkspaceProfile;
  reason: string;
}

export interface IProfileDetectionResult {
  profiles: WorkspaceProfile[];
  evidence: IProfileEvidence[];
}

export interface IDetectProfilesInput {
  packageJson: IPackageJson | null;
  frameworks: readonly IFrameworkInfo[];
  topLevelDirs: readonly string[];
  hasTsConfig: boolean;
}

function hasDep(pkg: IPackageJson | null, name: string): boolean {
  if (!pkg) return false;
  return (
    Boolean(pkg.dependencies?.[name]) ||
    Boolean(pkg.devDependencies?.[name]) ||
    Boolean((pkg as { peerDependencies?: Record<string, string> }).peerDependencies?.[name])
  );
}

function hasAnyDep(pkg: IPackageJson | null, names: readonly string[]): boolean {
  return names.some((n) => hasDep(pkg, n));
}

function hasFramework(frameworks: readonly IFrameworkInfo[], id: string): boolean {
  return frameworks.some((f) => f.id === id);
}

function hasScriptIncluding(pkg: IPackageJson | null, ...needles: string[]): boolean {
  if (!pkg) return false;
  for (const v of Object.values(pkg.scripts ?? {})) {
    for (const n of needles) {
      if (typeof v === 'string' && v.includes(n)) return true;
    }
  }
  return false;
}

/**
 * Compute structured profile tags from a workspace inspection. Pure function:
 * no I/O. Each detected profile has an `evidence` entry explaining why.
 */
export function detectProfiles(input: IDetectProfilesInput): IProfileDetectionResult {
  const { packageJson: pkg, frameworks, topLevelDirs, hasTsConfig } = input;
  const evidence: IProfileEvidence[] = [];
  const add = (profile: WorkspaceProfile, reason: string): void => {
    if (!evidence.some((e) => e.profile === profile)) {
      evidence.push({ profile, reason });
    }
  };

  // ── Language / runtime ────────────────────────────────────────────────
  if (hasFramework(frameworks, 'bun') || hasDep(pkg, 'bun') || hasDep(pkg, '@types/bun')) {
    add(WorkspaceProfile.HasBun, 'bun runtime detected via deps or framework signal');
  }
  if (hasTsConfig || hasDep(pkg, 'typescript') || hasFramework(frameworks, 'typescript')) {
    add(WorkspaceProfile.HasTypeScript, 'tsconfig.json or typescript dependency present');
  }

  // ── Build / workspace tooling ─────────────────────────────────────────
  if (hasFramework(frameworks, 'nx') || hasDep(pkg, 'nx') || hasDep(pkg, '@nx/workspace')) {
    add(WorkspaceProfile.HasNx, 'nx workspace detected');
  }
  if (
    hasDep(pkg, 'turbo') ||
    topLevelDirs.includes('turbo.json') ||
    topLevelDirs.includes('.turbo')
  ) {
    add(WorkspaceProfile.HasTurborepo, 'turbo dependency or turbo.json present');
  }
  if (Array.isArray((pkg as { workspaces?: unknown })?.workspaces)) {
    add(WorkspaceProfile.HasPackageWorkspaces, 'package.json workspaces array');
  }
  if (
    hasFramework(frameworks, 'nx') ||
    Array.isArray((pkg as { workspaces?: unknown })?.workspaces) ||
    topLevelDirs.includes('packages') ||
    topLevelDirs.includes('libs') ||
    topLevelDirs.includes('apps')
  ) {
    add(WorkspaceProfile.IsMonorepo, 'workspaces / Nx / packages/libs dirs present');
  }

  // ── UI frameworks ─────────────────────────────────────────────────────
  if (
    hasFramework(frameworks, 'react') ||
    hasAnyDep(pkg, ['react', 'react-dom', 'next', '@remix-run/react'])
  ) {
    add(WorkspaceProfile.HasReact, 'react family dependency or framework signal');
  }
  if (hasFramework(frameworks, 'next') || hasDep(pkg, 'next')) {
    add(WorkspaceProfile.HasNext, 'next dependency or framework signal');
  }
  if (
    hasFramework(frameworks, 'angular') ||
    hasAnyDep(pkg, ['@angular/core', '@angular/cli'])
  ) {
    add(WorkspaceProfile.HasAngular, '@angular/* dependency detected');
  }
  if (hasFramework(frameworks, 'vue') || hasAnyDep(pkg, ['vue', 'nuxt'])) {
    add(WorkspaceProfile.HasVue, 'vue / nuxt dependency');
  }

  // ── Backend ───────────────────────────────────────────────────────────
  if (
    hasFramework(frameworks, 'nestjs') ||
    hasAnyDep(pkg, ['@nestjs/core', '@nestjs/common'])
  ) {
    add(WorkspaceProfile.HasNestJS, '@nestjs/* dependency');
  }
  if (hasDep(pkg, '@modelcontextprotocol/sdk')) {
    add(WorkspaceProfile.HasMcpSdk, '@modelcontextprotocol/sdk dependency');
  }

  // ── Testing ───────────────────────────────────────────────────────────
  if (hasDep(pkg, 'vitest')) add(WorkspaceProfile.HasVitest, 'vitest dependency');
  if (hasAnyDep(pkg, ['jest', '@jest/globals'])) add(WorkspaceProfile.HasJest, 'jest dependency');
  if (
    hasScriptIncluding(pkg, 'bun test', 'bun:test') ||
    (hasDep(pkg, '@types/bun') && hasScriptIncluding(pkg, 'test'))
  ) {
    add(WorkspaceProfile.HasBunTest, 'bun test script detected');
  }
  if (
    evidence.some((e) => e.profile === WorkspaceProfile.HasVitest) ||
    evidence.some((e) => e.profile === WorkspaceProfile.HasJest) ||
    evidence.some((e) => e.profile === WorkspaceProfile.HasBunTest) ||
    hasScriptIncluding(pkg, 'test') ||
    topLevelDirs.some((d) => d === 'tests' || d === '__tests__')
  ) {
    add(WorkspaceProfile.HasTests, 'test runner or test directory present');
  }

  // ── Lint ──────────────────────────────────────────────────────────────
  if (hasAnyDep(pkg, ['eslint', '@eslint/js'])) {
    add(WorkspaceProfile.HasEslint, 'eslint dependency');
  }
  if (hasAnyDep(pkg, ['@biomejs/biome'])) {
    add(WorkspaceProfile.HasBiome, '@biomejs/biome dependency');
  }

  // ── CI ────────────────────────────────────────────────────────────────
  if (topLevelDirs.includes('.github')) {
    add(WorkspaceProfile.HasGithubActions, '.github directory present (likely workflows)');
  }

  // ── Library vs service vs frontend/backend ────────────────────────────
  const looksLibrary =
    !!pkg?.main || !!(pkg as { exports?: unknown })?.exports || !!(pkg as { types?: unknown })?.types;
  if (looksLibrary && !topLevelDirs.includes('apps')) {
    add(WorkspaceProfile.IsLibrary, 'package.json declares main/exports/types');
  }
  if (
    hasScriptIncluding(pkg, 'start', 'serve', 'dev:server') &&
    !evidence.some((e) => e.profile === WorkspaceProfile.IsLibrary)
  ) {
    add(WorkspaceProfile.IsService, 'start/serve script detected');
  }
  const frontendSignal =
    evidence.some((e) =>
      [WorkspaceProfile.HasReact, WorkspaceProfile.HasAngular, WorkspaceProfile.HasVue].includes(e.profile),
    ) ||
    hasAnyDep(pkg, ['vite', '@angular/build', 'next', 'remix']);
  if (frontendSignal) {
    add(WorkspaceProfile.IsFrontend, 'UI framework or frontend bundler dependency');
  }
  const backendSignal =
    evidence.some((e) => e.profile === WorkspaceProfile.HasNestJS) ||
    hasAnyDep(pkg, ['express', 'fastify', 'koa', 'hono', '@nestjs/core']);
  if (backendSignal) {
    add(WorkspaceProfile.IsBackend, 'HTTP server framework dependency');
  }

  return {
    profiles: evidence.map((e) => e.profile),
    evidence,
  };
}
