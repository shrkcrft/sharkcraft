/**
 * Polyglot language detection.
 *
 * Builds an `ILanguageProfile` per detected language by scanning the project
 * tree for canonical build/manifest files and counting source files. Pure
 * file/manifest scanning — no compiler integration, no AST library.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { LanguageId } from './language-id.ts';

export const LANGUAGE_PROFILE_SCHEMA = 'sharkcraft.language-profile/v1';

export interface ILanguageProfile {
  schema: typeof LANGUAGE_PROFILE_SCHEMA;
  language: LanguageId;
  confidence: 'low' | 'medium' | 'high';
  fileCount: number;
  sourceRoots: readonly string[];
  testRoots: readonly string[];
  buildFiles: readonly string[];
  dependencyFiles: readonly string[];
  packageManager?: string;
  buildTool?: string;
  testFrameworks: readonly string[];
  frameworkSignals: readonly string[];
  likelyCommands: readonly string[];
  riskNotes: readonly string[];
}

export interface ILanguageProfileReport {
  schema: typeof LANGUAGE_PROFILE_SCHEMA;
  generatedAt: string;
  projectRoot: string;
  dominantLanguage: LanguageId;
  profiles: readonly ILanguageProfile[];
  warnings: readonly string[];
}

interface ITreeStats {
  files: string[];
}

const IGNORED_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'target',
  'build',
  'bin',
  'obj',
  'dist',
  'out',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.vscode',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.gradle',
  '.mvn',
  'vendor',
]);

function walkLimited(root: string, maxFiles = 25000): ITreeStats {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0 && out.length < maxFiles) {
    const cur = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (IGNORED_DIR_NAMES.has(e)) continue;
      const abs = nodePath.join(cur, e);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (st.isFile()) out.push(abs);
    }
  }
  return { files: out };
}

function rel(root: string, abs: string): string {
  const r = nodePath.relative(root, abs).replace(/\\/g, '/');
  return r;
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

function detectJsTs(root: string, files: readonly string[]): ILanguageProfile[] {
  const tsFiles = files.filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
  const jsFiles = files.filter((f) => f.endsWith('.js') || f.endsWith('.jsx') || f.endsWith('.mjs') || f.endsWith('.cjs'));
  const pkgJson = nodePath.join(root, 'package.json');
  const tsconfig = nodePath.join(root, 'tsconfig.json');
  const hasPkg = existsSync(pkgJson);
  const hasTsconfig = existsSync(tsconfig);
  const out: ILanguageProfile[] = [];
  if (tsFiles.length > 0 || hasTsconfig) {
    let packageManager: string | undefined;
    if (existsSync(nodePath.join(root, 'bun.lockb'))) packageManager = 'bun';
    else if (existsSync(nodePath.join(root, 'pnpm-lock.yaml'))) packageManager = 'pnpm';
    else if (existsSync(nodePath.join(root, 'yarn.lock'))) packageManager = 'yarn';
    else if (existsSync(nodePath.join(root, 'package-lock.json'))) packageManager = 'npm';

    out.push({
      schema: LANGUAGE_PROFILE_SCHEMA,
      language: LanguageId.TypeScript,
      confidence: tsFiles.length > 50 ? 'high' : tsFiles.length > 5 ? 'medium' : 'low',
      fileCount: tsFiles.length,
      sourceRoots: collectRoots(root, tsFiles, ['src', 'packages', 'libs', 'app', 'apps']),
      testRoots: collectRoots(root, tsFiles, ['__tests__', 'tests', 'spec']),
      buildFiles: [hasTsconfig ? 'tsconfig.json' : '', hasPkg ? 'package.json' : ''].filter(Boolean) as string[],
      dependencyFiles: [hasPkg ? 'package.json' : ''].filter(Boolean) as string[],
      ...(packageManager ? { packageManager } : {}),
      ...(packageManager ? { buildTool: packageManager } : {}),
      testFrameworks: detectJsTestFrameworks(root, pkgJson),
      frameworkSignals: detectJsFrameworks(root, pkgJson),
      likelyCommands: [
        packageManager === 'bun' ? 'bun test' : 'npm test',
        'bun x tsc --noEmit',
      ],
      riskNotes: [],
    });
  }
  if (jsFiles.length > 0 && tsFiles.length === 0) {
    out.push({
      schema: LANGUAGE_PROFILE_SCHEMA,
      language: LanguageId.JavaScript,
      confidence: jsFiles.length > 20 ? 'high' : 'medium',
      fileCount: jsFiles.length,
      sourceRoots: collectRoots(root, jsFiles, ['src', 'lib']),
      testRoots: collectRoots(root, jsFiles, ['test', 'tests', '__tests__']),
      buildFiles: hasPkg ? ['package.json'] : [],
      dependencyFiles: hasPkg ? ['package.json'] : [],
      testFrameworks: detectJsTestFrameworks(root, pkgJson),
      frameworkSignals: detectJsFrameworks(root, pkgJson),
      likelyCommands: ['npm test'],
      riskNotes: [],
    });
  }
  return out;
}

function detectJsTestFrameworks(root: string, pkgJsonPath: string): string[] {
  if (!existsSync(pkgJsonPath)) return [];
  try {
    const json = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as Record<string, unknown>;
    const deps = { ...(json['dependencies'] as Record<string, unknown> ?? {}), ...(json['devDependencies'] as Record<string, unknown> ?? {}) };
    const out: string[] = [];
    if ('jest' in deps || 'ts-jest' in deps) out.push('jest');
    if ('vitest' in deps) out.push('vitest');
    if ('mocha' in deps) out.push('mocha');
    if (existsSync(nodePath.join(root, 'bun.lockb')) || '@types/bun' in deps) out.push('bun:test');
    if ('@playwright/test' in deps) out.push('playwright');
    return out;
  } catch {
    return [];
  }
}

function detectJsFrameworks(_root: string, pkgJsonPath: string): string[] {
  if (!existsSync(pkgJsonPath)) return [];
  try {
    const json = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as Record<string, unknown>;
    const deps = { ...(json['dependencies'] as Record<string, unknown> ?? {}), ...(json['devDependencies'] as Record<string, unknown> ?? {}) };
    const out: string[] = [];
    if ('next' in deps) out.push('next');
    if ('react' in deps) out.push('react');
    if ('@nestjs/core' in deps) out.push('nest');
    if ('express' in deps) out.push('express');
    if ('fastify' in deps) out.push('fastify');
    if ('hono' in deps) out.push('hono');
    return out;
  } catch {
    return [];
  }
}

function detectJava(root: string, files: readonly string[]): ILanguageProfile | null {
  const javaFiles = files.filter((f) => f.endsWith('.java'));
  const hasPom = existsSync(nodePath.join(root, 'pom.xml'));
  const hasGradleGroovy = existsSync(nodePath.join(root, 'build.gradle'));
  const hasGradleKts = existsSync(nodePath.join(root, 'build.gradle.kts'));
  const hasSettingsGradle = existsSync(nodePath.join(root, 'settings.gradle')) || existsSync(nodePath.join(root, 'settings.gradle.kts'));
  if (javaFiles.length === 0 && !hasPom && !hasGradleGroovy && !hasGradleKts) return null;

  const buildTool = hasPom ? 'maven' : hasGradleGroovy || hasGradleKts ? 'gradle' : 'java';
  const testRoots: string[] = [];
  const sourceRoots: string[] = [];
  for (const f of javaFiles) {
    const r = rel(root, f);
    if (r.includes('/test/java/')) {
      pushUnique(testRoots, r.replace(/\/[^/]+\.java$/, '').replace(/\/test\/java\/.*$/, '/test/java'));
    } else if (r.includes('/main/java/')) {
      pushUnique(sourceRoots, r.replace(/\/[^/]+\.java$/, '').replace(/\/main\/java\/.*$/, '/main/java'));
    }
  }
  const frameworkSignals: string[] = [];
  if (hasPom) {
    try {
      const pom = readFileSync(nodePath.join(root, 'pom.xml'), 'utf8');
      if (/spring-boot/i.test(pom)) frameworkSignals.push('spring-boot');
      if (/junit/i.test(pom)) frameworkSignals.push('junit');
      if (/testng/i.test(pom)) frameworkSignals.push('testng');
    } catch {
      /* ignore */
    }
  }
  if (hasGradleGroovy || hasGradleKts) {
    try {
      const gFile = hasGradleKts ? 'build.gradle.kts' : 'build.gradle';
      const g = readFileSync(nodePath.join(root, gFile), 'utf8');
      if (/spring-boot/i.test(g)) frameworkSignals.push('spring-boot');
      if (/junit/i.test(g)) frameworkSignals.push('junit');
      if (/testng/i.test(g)) frameworkSignals.push('testng');
    } catch {
      /* ignore */
    }
  }
  const testFrameworks = frameworkSignals.filter((s) => s === 'junit' || s === 'testng');

  const buildFiles: string[] = [];
  if (hasPom) buildFiles.push('pom.xml');
  if (hasGradleGroovy) buildFiles.push('build.gradle');
  if (hasGradleKts) buildFiles.push('build.gradle.kts');
  if (hasSettingsGradle) buildFiles.push(existsSync(nodePath.join(root, 'settings.gradle')) ? 'settings.gradle' : 'settings.gradle.kts');

  const likelyCommands: string[] = [];
  if (buildTool === 'maven') {
    likelyCommands.push('mvn test', 'mvn verify', 'mvn package');
    if (frameworkSignals.includes('spring-boot')) likelyCommands.push('mvn spring-boot:run');
  } else if (buildTool === 'gradle') {
    likelyCommands.push('./gradlew test', './gradlew build', './gradlew check');
    if (frameworkSignals.includes('spring-boot')) likelyCommands.push('./gradlew bootRun');
  }

  return {
    schema: LANGUAGE_PROFILE_SCHEMA,
    language: LanguageId.Java,
    confidence: javaFiles.length > 5 || hasPom || hasGradleGroovy || hasGradleKts ? 'high' : 'medium',
    fileCount: javaFiles.length,
    sourceRoots,
    testRoots,
    buildFiles,
    dependencyFiles: buildFiles,
    packageManager: buildTool,
    buildTool,
    testFrameworks: testFrameworks.length > 0 ? testFrameworks : ['junit'],
    frameworkSignals,
    likelyCommands,
    riskNotes: [],
  };
}

function detectCSharp(root: string, files: readonly string[]): ILanguageProfile | null {
  const csFiles = files.filter((f) => f.endsWith('.cs'));
  const csprojFiles = files.filter((f) => f.endsWith('.csproj')).map((f) => rel(root, f));
  const slnFiles = files.filter((f) => f.endsWith('.sln')).map((f) => rel(root, f));
  if (csFiles.length === 0 && csprojFiles.length === 0) return null;
  const testProjects = csprojFiles.filter((f) => /\.tests?\.csproj$/i.test(f) || /\bTests?\b/i.test(f));
  const frameworkSignals: string[] = [];
  const testFrameworks: string[] = [];
  for (const proj of csprojFiles) {
    try {
      const body = readFileSync(nodePath.join(root, proj), 'utf8');
      if (/xunit/i.test(body)) testFrameworks.push('xunit');
      if (/nunit/i.test(body)) testFrameworks.push('nunit');
      if (/mstest|microsoft\.net\.test\.sdk/i.test(body)) testFrameworks.push('mstest');
      if (/microsoft\.aspnetcore/i.test(body)) frameworkSignals.push('aspnet-core');
      if (/microsoft\.entityframeworkcore/i.test(body)) frameworkSignals.push('entity-framework-core');
    } catch {
      /* ignore */
    }
  }
  return {
    schema: LANGUAGE_PROFILE_SCHEMA,
    language: LanguageId.CSharp,
    confidence: csFiles.length > 5 || csprojFiles.length > 0 ? 'high' : 'medium',
    fileCount: csFiles.length,
    sourceRoots: collectRoots(root, csFiles, ['src', 'Controllers']),
    testRoots: testProjects,
    buildFiles: [...slnFiles, ...csprojFiles],
    dependencyFiles: csprojFiles,
    packageManager: 'nuget',
    buildTool: 'dotnet',
    testFrameworks: [...new Set(testFrameworks)],
    frameworkSignals: [...new Set(frameworkSignals)],
    likelyCommands: ['dotnet restore', 'dotnet build', 'dotnet test', 'dotnet format'],
    riskNotes: [],
  };
}

function detectPython(root: string, files: readonly string[]): ILanguageProfile | null {
  const pyFiles = files.filter((f) => f.endsWith('.py'));
  const hasPyproject = existsSync(nodePath.join(root, 'pyproject.toml'));
  const hasRequirements = existsSync(nodePath.join(root, 'requirements.txt'));
  const hasSetupPy = existsSync(nodePath.join(root, 'setup.py'));
  const hasPoetryLock = existsSync(nodePath.join(root, 'poetry.lock'));
  const hasUvLock = existsSync(nodePath.join(root, 'uv.lock'));
  if (pyFiles.length === 0 && !hasPyproject && !hasRequirements && !hasSetupPy) return null;
  const frameworkSignals: string[] = [];
  const testFrameworks: string[] = [];
  if (hasPyproject) {
    try {
      const body = readFileSync(nodePath.join(root, 'pyproject.toml'), 'utf8');
      if (/pytest/i.test(body)) testFrameworks.push('pytest');
      if (/fastapi/i.test(body)) frameworkSignals.push('fastapi');
      if (/django/i.test(body)) frameworkSignals.push('django');
      if (/flask/i.test(body)) frameworkSignals.push('flask');
      if (/ruff/i.test(body)) frameworkSignals.push('ruff');
      if (/mypy/i.test(body)) frameworkSignals.push('mypy');
    } catch {
      /* ignore */
    }
  }
  if (hasRequirements) {
    try {
      const body = readFileSync(nodePath.join(root, 'requirements.txt'), 'utf8');
      if (/pytest/i.test(body)) testFrameworks.push('pytest');
      if (/fastapi/i.test(body)) frameworkSignals.push('fastapi');
      if (/django/i.test(body)) frameworkSignals.push('django');
      if (/flask/i.test(body)) frameworkSignals.push('flask');
    } catch {
      /* ignore */
    }
  }
  const packageManager = hasPoetryLock ? 'poetry' : hasUvLock ? 'uv' : hasPyproject ? 'pip' : 'pip';
  const buildFiles: string[] = [];
  if (hasPyproject) buildFiles.push('pyproject.toml');
  if (hasRequirements) buildFiles.push('requirements.txt');
  if (hasSetupPy) buildFiles.push('setup.py');
  if (hasPoetryLock) buildFiles.push('poetry.lock');
  if (hasUvLock) buildFiles.push('uv.lock');

  const likelyCommands: string[] = [];
  if (packageManager === 'uv') likelyCommands.push('uv run pytest', 'uv run ruff check .', 'uv run mypy .');
  else if (packageManager === 'poetry') likelyCommands.push('poetry run pytest', 'poetry run ruff check .', 'poetry run mypy .');
  else likelyCommands.push('python -m pytest', 'ruff check .', 'mypy .');
  if (hasPyproject) likelyCommands.push('python -m build');

  return {
    schema: LANGUAGE_PROFILE_SCHEMA,
    language: LanguageId.Python,
    confidence: pyFiles.length > 5 || hasPyproject ? 'high' : 'medium',
    fileCount: pyFiles.length,
    sourceRoots: collectRoots(root, pyFiles, ['src', 'app']),
    testRoots: collectRoots(root, pyFiles, ['tests', 'test']),
    buildFiles,
    dependencyFiles: buildFiles,
    packageManager,
    buildTool: packageManager,
    testFrameworks: [...new Set(testFrameworks)],
    frameworkSignals: [...new Set(frameworkSignals)],
    likelyCommands,
    riskNotes: [],
  };
}

function detectGo(root: string, files: readonly string[]): ILanguageProfile | null {
  const goFiles = files.filter((f) => f.endsWith('.go'));
  const hasGoMod = existsSync(nodePath.join(root, 'go.mod'));
  const hasGoSum = existsSync(nodePath.join(root, 'go.sum'));
  if (goFiles.length === 0 && !hasGoMod) return null;
  const frameworkSignals: string[] = [];
  if (hasGoMod) {
    try {
      const body = readFileSync(nodePath.join(root, 'go.mod'), 'utf8');
      if (/gin-gonic\/gin/i.test(body)) frameworkSignals.push('gin');
      if (/labstack\/echo/i.test(body)) frameworkSignals.push('echo');
      if (/cobra/i.test(body)) frameworkSignals.push('cobra');
      if (/gofiber/i.test(body)) frameworkSignals.push('fiber');
    } catch {
      /* ignore */
    }
  }
  const testFiles = goFiles.filter((f) => f.endsWith('_test.go'));
  const buildFiles: string[] = [];
  if (hasGoMod) buildFiles.push('go.mod');
  if (hasGoSum) buildFiles.push('go.sum');

  return {
    schema: LANGUAGE_PROFILE_SCHEMA,
    language: LanguageId.Go,
    confidence: goFiles.length > 5 || hasGoMod ? 'high' : 'medium',
    fileCount: goFiles.length,
    sourceRoots: collectRoots(root, goFiles.filter((f) => !f.endsWith('_test.go')), ['cmd', 'pkg', 'internal']),
    testRoots: collectRoots(root, testFiles, ['cmd', 'pkg', 'internal']),
    buildFiles,
    dependencyFiles: hasGoMod ? ['go.mod'] : [],
    packageManager: 'go-modules',
    buildTool: 'go',
    testFrameworks: ['testing'],
    frameworkSignals,
    likelyCommands: ['go test ./...', 'go vet ./...', 'go build ./...', 'gofmt -l .'],
    riskNotes: [],
  };
}

function detectRust(root: string, files: readonly string[]): ILanguageProfile | null {
  const rsFiles = files.filter((f) => f.endsWith('.rs'));
  const hasCargoToml = existsSync(nodePath.join(root, 'Cargo.toml'));
  const hasCargoLock = existsSync(nodePath.join(root, 'Cargo.lock'));
  if (rsFiles.length === 0 && !hasCargoToml) return null;
  const frameworkSignals: string[] = [];
  if (hasCargoToml) {
    try {
      const body = readFileSync(nodePath.join(root, 'Cargo.toml'), 'utf8');
      if (/tokio/i.test(body)) frameworkSignals.push('tokio');
      if (/actix-web/i.test(body)) frameworkSignals.push('actix-web');
      if (/axum/i.test(body)) frameworkSignals.push('axum');
      if (/rocket/i.test(body)) frameworkSignals.push('rocket');
      if (/serde/i.test(body)) frameworkSignals.push('serde');
    } catch {
      /* ignore */
    }
  }
  const buildFiles: string[] = [];
  if (hasCargoToml) buildFiles.push('Cargo.toml');
  if (hasCargoLock) buildFiles.push('Cargo.lock');
  return {
    schema: LANGUAGE_PROFILE_SCHEMA,
    language: LanguageId.Rust,
    confidence: rsFiles.length > 5 || hasCargoToml ? 'high' : 'medium',
    fileCount: rsFiles.length,
    sourceRoots: collectRoots(root, rsFiles, ['src', 'crates']),
    testRoots: collectRoots(root, rsFiles, ['tests']),
    buildFiles,
    dependencyFiles: hasCargoToml ? ['Cargo.toml'] : [],
    packageManager: 'cargo',
    buildTool: 'cargo',
    testFrameworks: ['cargo-test'],
    frameworkSignals,
    likelyCommands: ['cargo test', 'cargo check', 'cargo clippy', 'cargo fmt --check', 'cargo build'],
    riskNotes: [],
  };
}

function collectRoots(root: string, files: readonly string[], candidates: readonly string[]): string[] {
  const out: string[] = [];
  for (const c of candidates) {
    if (files.some((f) => rel(root, f).includes(`/${c}/`) || rel(root, f).startsWith(`${c}/`))) {
      pushUnique(out, c);
    }
  }
  return out;
}

export function detectLanguageProfiles(projectRoot: string): ILanguageProfileReport {
  const { files } = walkLimited(projectRoot);
  const profiles: ILanguageProfile[] = [];
  profiles.push(...detectJsTs(projectRoot, files));
  const java = detectJava(projectRoot, files);
  if (java) profiles.push(java);
  const csharp = detectCSharp(projectRoot, files);
  if (csharp) profiles.push(csharp);
  const python = detectPython(projectRoot, files);
  if (python) profiles.push(python);
  const go = detectGo(projectRoot, files);
  if (go) profiles.push(go);
  const rust = detectRust(projectRoot, files);
  if (rust) profiles.push(rust);

  const dominant = profiles
    .filter((p) => p.language !== LanguageId.JavaScript) // prefer typed/strong languages when tied
    .sort((a, b) => b.fileCount - a.fileCount)[0]?.language ?? profiles[0]?.language ?? LanguageId.Unknown;

  const allDom = profiles.filter((p) => p.confidence === 'high');
  const finalDominant = profiles.length > 1 && allDom.length > 1 && allDom[0]!.language !== allDom[1]!.language
    ? (Math.abs(allDom[0]!.fileCount - allDom[1]!.fileCount) < 5 ? LanguageId.Mixed : dominant)
    : dominant;

  return {
    schema: LANGUAGE_PROFILE_SCHEMA,
    generatedAt: new Date().toISOString(),
    projectRoot,
    dominantLanguage: finalDominant,
    profiles,
    warnings: profiles.length === 0 ? ['No recognised language detected.'] : [],
  };
}

export function renderLanguageProfilesText(r: ILanguageProfileReport): string {
  let out = `=== Language profiles ===\n`;
  out += `  project root      ${r.projectRoot}\n`;
  out += `  dominant          ${r.dominantLanguage}\n`;
  out += `  profiles          ${r.profiles.length}\n\n`;
  for (const p of r.profiles) {
    out += `[${p.language}]  files=${p.fileCount}  confidence=${p.confidence}  buildTool=${p.buildTool ?? '(none)'}\n`;
    if (p.sourceRoots.length) out += `  src roots:  ${p.sourceRoots.join(', ')}\n`;
    if (p.testRoots.length) out += `  test roots: ${p.testRoots.join(', ')}\n`;
    if (p.buildFiles.length) out += `  build:      ${p.buildFiles.join(', ')}\n`;
    if (p.testFrameworks.length) out += `  tests:      ${p.testFrameworks.join(', ')}\n`;
    if (p.frameworkSignals.length) out += `  frameworks: ${p.frameworkSignals.join(', ')}\n`;
    if (p.likelyCommands.length) {
      out += `  commands:\n`;
      for (const c of p.likelyCommands) out += `    • ${c}\n`;
    }
    out += `\n`;
  }
  if (r.warnings.length) {
    out += `Warnings:\n`;
    for (const w of r.warnings) out += `  • ${w}\n`;
  }
  return out;
}

export function renderLanguageProfilesMarkdown(r: ILanguageProfileReport): string {
  let out = `# Language profiles\n\n`;
  out += `- **project root**: ${r.projectRoot}\n`;
  out += `- **dominant**: \`${r.dominantLanguage}\`\n`;
  out += `- **profiles**: ${r.profiles.length}\n\n`;
  out += `| Language | Files | Confidence | Build tool | Test framework(s) | Frameworks |\n`;
  out += `| --- | --- | --- | --- | --- | --- |\n`;
  for (const p of r.profiles) {
    out += `| \`${p.language}\` | ${p.fileCount} | ${p.confidence} | ${p.buildTool ?? ''} | ${p.testFrameworks.join(', ')} | ${p.frameworkSignals.join(', ')} |\n`;
  }
  out += `\n`;
  for (const p of r.profiles) {
    out += `## ${p.language}\n`;
    if (p.likelyCommands.length) {
      out += `**Likely commands**:\n`;
      for (const c of p.likelyCommands) out += `- \`${c}\`\n`;
      out += `\n`;
    }
  }
  return out;
}
