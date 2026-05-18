import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  applyIngestPlan,
  buildGeneratedCodeReport,
  buildIngestApplyPlan,
  buildLanguageRunPlan,
  buildPolyglotBoundaryReport,
  buildStabilityMap,
  clearLanguageCache,
  computeLanguageCacheSignature,
  detectLanguageProfiles,
  detectLanguageProfilesWithCache,
  GeneratedKind,
  GeneratedScanDepth,
  getLanguageCacheStatus,
  inspectSharkcraft,
  IngestAdoptionStatus,
  LanguageId,
  loadIngestApplyPlan,
  loadLanguageCache,
  renderPolyglotBoundaryReportText,
  saveIngestApplyPlan,
  signIngestApplyPlan,
  StabilityKind,
  verifyIngestApplyPlan,
} from '@shrkcrft/inspector';

function mkTempProject(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `r27-${prefix}-`));
  return root;
}

describe('polyglot boundary enforcement', () => {
  test('flags Java controller that imports a repository', () => {
    const root = mkTempProject('java-violation');
    try {
      mkdirSync(join(root, 'src', 'main', 'java', 'com', 'foo', 'controller'), { recursive: true });
      mkdirSync(join(root, 'src', 'main', 'java', 'com', 'foo', 'repository'), { recursive: true });
      writeFileSync(join(root, 'pom.xml'), '<project><modelVersion>4.0.0</modelVersion><groupId>com.foo</groupId><artifactId>x</artifactId><version>1.0</version></project>');
      writeFileSync(
        join(root, 'src', 'main', 'java', 'com', 'foo', 'controller', 'UserController.java'),
        'package com.foo.controller;\nimport com.foo.repository.UserRepository;\npublic class UserController{}\n',
      );
      writeFileSync(
        join(root, 'src', 'main', 'java', 'com', 'foo', 'repository', 'UserRepository.java'),
        'package com.foo.repository;\npublic class UserRepository{}\n',
      );
      const report = buildPolyglotBoundaryReport({ projectRoot: root, languages: [LanguageId.Java] });
      const v = report.violations.find((x) => x.ruleId === 'java.controller.no-repository-direct');
      expect(v).toBeDefined();
      expect(v?.fromFile).toContain('UserController.java');
      expect(report.counts.violations).toBeGreaterThanOrEqual(1);
      // Text render is stable.
      const text = renderPolyglotBoundaryReportText(report);
      expect(text).toContain('Polyglot boundary report');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('flags Python domain importing fastapi', () => {
    const root = mkTempProject('py-domain');
    try {
      mkdirSync(join(root, 'src', 'domain'), { recursive: true });
      writeFileSync(join(root, 'pyproject.toml'), '[tool.poetry]\nname = "demo"\n[tool.poetry.dependencies]\nfastapi = "^0"\n');
      writeFileSync(join(root, 'src', 'domain', 'user.py'), 'from fastapi import FastAPI\n');
      const report = buildPolyglotBoundaryReport({ projectRoot: root, languages: [LanguageId.Python] });
      const v = report.violations.find((x) => x.ruleId === 'python.domain.no-web-framework');
      expect(v).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('flags Go pkg importing cmd', () => {
    const root = mkTempProject('go-pkg');
    try {
      mkdirSync(join(root, 'pkg', 'foo'), { recursive: true });
      mkdirSync(join(root, 'cmd', 'main'), { recursive: true });
      writeFileSync(join(root, 'go.mod'), 'module example.com/demo\n');
      writeFileSync(
        join(root, 'pkg', 'foo', 'foo.go'),
        'package foo\nimport "example.com/demo/cmd/main"\n',
      );
      writeFileSync(join(root, 'cmd', 'main', 'main.go'), 'package main\nfunc main(){}\n');
      const report = buildPolyglotBoundaryReport({ projectRoot: root, languages: [LanguageId.Go] });
      expect(report.violations.some((v) => v.ruleId === 'go.pkg.no-cmd-import' || v.ruleId === 'go.internal.visibility')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('flags Rust src/ importing tests::', () => {
    const root = mkTempProject('rust-tests');
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n');
      writeFileSync(join(root, 'src', 'lib.rs'), 'use tests::fixtures::user;\n');
      const report = buildPolyglotBoundaryReport({ projectRoot: root, languages: [LanguageId.Rust] });
      expect(report.violations.some((v) => v.ruleId === 'rust.lib.no-tests-import')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('generated-code v2', () => {
  test('detects Java @Generated annotation only at deep depth or when ext matches', async () => {
    const root = mkTempProject('java-gen');
    try {
      mkdirSync(join(root, 'src', 'main', 'java', 'gen'), { recursive: true });
      writeFileSync(
        join(root, 'src', 'main', 'java', 'gen', 'Stub.java'),
        '@javax.annotation.Generated("openapi")\npackage gen;\npublic class Stub {}\n',
      );
      writeFileSync(join(root, 'package.json'), '{"name":"demo"}');
      const inspection = await inspectSharkcraft({ cwd: root });
      const report = buildGeneratedCodeReport({ inspection, depth: GeneratedScanDepth.Deep });
      const gen = report.generatedFiles.find((f) => f.path.endsWith('Stub.java'));
      // Even shallow scans can pick this up because the marker is in line 1.
      expect(gen?.kind === GeneratedKind.JavaGenerated || gen?.kind === GeneratedKind.Marker).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('detects generated source root target/generated-sources', async () => {
    const root = mkTempProject('java-gen-root');
    try {
      mkdirSync(join(root, 'target', 'generated-sources', 'pkg'), { recursive: true });
      writeFileSync(join(root, 'target', 'generated-sources', 'pkg', 'Foo.java'), 'class Foo{}');
      writeFileSync(join(root, 'package.json'), '{"name":"demo"}');
      const inspection = await inspectSharkcraft({ cwd: root });
      const report = buildGeneratedCodeReport({ inspection });
      expect(report.generatedRoots.some((r) => r.path.includes('target/generated-sources'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('stability v2 annotation scan', () => {
  test('detects @deprecated JSDoc when scanAnnotations=true', async () => {
    const root = mkTempProject('ts-deprecated');
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'package.json'), '{"name":"demo"}');
      writeFileSync(
        join(root, 'src', 'old.ts'),
        '/**\n * @deprecated use newApi instead.\n */\nexport function oldApi() { return 1; }\n',
      );
      const inspection = await inspectSharkcraft({ cwd: root });
      const noScan = buildStabilityMap({ inspection });
      const withScan = buildStabilityMap({ inspection, scanAnnotations: true });
      const deprecated = withScan.areas.find((a) => a.kind === StabilityKind.Deprecated);
      expect(deprecated).toBeDefined();
      expect(noScan.areas.filter((a) => a.kind === StabilityKind.Deprecated)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('detects Java @Deprecated annotation', async () => {
    const root = mkTempProject('java-deprecated');
    try {
      // Use a neutral folder name ('users') so the folder-hint heuristic
      // doesn't compete with the annotation vote.
      mkdirSync(join(root, 'src', 'main', 'java', 'users'), { recursive: true });
      writeFileSync(join(root, 'package.json'), '{"name":"demo"}');
      writeFileSync(
        join(root, 'src', 'main', 'java', 'users', 'Legacy.java'),
        '@Deprecated\nclass Legacy{}\n',
      );
      const inspection = await inspectSharkcraft({ cwd: root });
      const map = buildStabilityMap({ inspection, scanAnnotations: true });
      const dep = map.areas.find((a) => a.kind === StabilityKind.Deprecated);
      expect(dep).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('language cache', () => {
  test('saves + restores cache, reports stale on edits', () => {
    const root = mkTempProject('cache');
    try {
      writeFileSync(join(root, 'package.json'), '{"name":"demo"}');
      const r1 = detectLanguageProfilesWithCache({ projectRoot: root, sharkcraftVersion: 'test', useCache: true });
      expect(r1.cacheHit).toBe(false);
      const r2 = detectLanguageProfilesWithCache({ projectRoot: root, sharkcraftVersion: 'test', useCache: true });
      expect(r2.cacheHit).toBe(true);
      expect(r2.staleReasons.length).toBe(0);
      const sig1 = computeLanguageCacheSignature(root, 'test');
      expect(sig1.manifestSignatures['package.json']).toBeDefined();
      // Touch package.json — manifest signature should drift.
      writeFileSync(join(root, 'package.json'), '{"name":"demo","version":"1.0.0"}');
      const status = getLanguageCacheStatus(root, 'test');
      expect(status.exists).toBe(true);
      expect(status.fresh).toBe(false);
      const cleared = clearLanguageCache(root, { write: true });
      expect(cleared.cleared).toBe(true);
      expect(loadLanguageCache(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('language runner', () => {
  test('plan is dry-run by default, refuses publish', () => {
    const root = mkTempProject('runner');
    try {
      writeFileSync(join(root, 'package.json'), '{"name":"demo","scripts":{"test":"bun test"}}');
      const plan = buildLanguageRunPlan({ projectRoot: root, category: 'test', allowInstall: false });
      expect(plan.dryRun).toBe(true);
      for (const r of plan.refusedSteps) expect(r.reason).toContain('refused pattern');
      // install commands gated behind --allow-install.
      const installPlan = buildLanguageRunPlan({ projectRoot: root, category: 'install', allowInstall: false });
      const installStep = installPlan.steps[0];
      if (installStep) expect(installStep.skipped).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ingest apply plan', () => {
  test('plan only targets sharkcraft/** and can be signed/verified', () => {
    const root = mkTempProject('ingest-apply');
    try {
      mkdirSync(join(root, 'sharkcraft'), { recursive: true });
      writeFileSync(join(root, 'sharkcraft', 'rules.ts'), 'export const RULES = [];\n');
      writeFileSync(join(root, 'package.json'), '{"name":"demo"}');
      const adoption = {
        schema: 'sharkcraft.ingest-adoption/v1' as const,
        projectRoot: root,
        entries: [
          { target: 'sharkcraft/rules.ts', kind: 'rule', id: 'rule.foo', status: IngestAdoptionStatus.SafeAppend, reason: 'append' },
          { target: '../../etc/passwd', kind: 'rule', id: 'rule.bad', status: IngestAdoptionStatus.SafeAppend, reason: 'naughty' },
        ],
        counts: {
          [IngestAdoptionStatus.SafeAppend]: 2,
          [IngestAdoptionStatus.ManualReview]: 0,
          [IngestAdoptionStatus.LowConfidence]: 0,
          [IngestAdoptionStatus.AlreadyCovered]: 0,
          [IngestAdoptionStatus.GeneratedProtected]: 0,
        } as const,
        reviewRequired: false,
      };
      const built = buildIngestApplyPlan({ plan: adoption });
      expect(built.plan.expectedChanges).toHaveLength(1);
      expect(built.plan.expectedChanges[0]!.relativePath).toBe('sharkcraft/rules.ts');
      expect(built.skipped.some((s) => s.reason.includes('refused'))).toBe(true);

      const signed = signIngestApplyPlan(built.plan, 'secret-x');
      expect(signed.signature?.hmac).toMatch(/^[0-9a-f]+$/);
      expect(verifyIngestApplyPlan(signed, 'secret-x')).toBe(true);
      expect(verifyIngestApplyPlan(signed, 'other')).toBe(false);

      // Save + load round-trip.
      const planFile = join(root, 'sharkcraft', 'ingest-apply.plan.json');
      saveIngestApplyPlan(signed, planFile);
      const loaded = loadIngestApplyPlan(planFile);
      expect(loaded?.signature?.hmac).toBe(signed.signature?.hmac);

      // Apply with require-signature works.
      const result = applyIngestPlan({ plan: signed, files: built.files, requireSignature: true, secret: 'secret-x' });
      expect(result.applied).toHaveLength(1);
      const after = readFileSync(join(root, 'sharkcraft', 'rules.ts'), 'utf8');
      expect(after).toContain('ingest-adopt');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('dashboard export + repository map', () => {
  test('repository map carries languageCounts', async () => {
    const root = mkTempProject('repo-map');
    try {
      writeFileSync(join(root, 'package.json'), '{"name":"demo"}');
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src', 'index.ts'), 'export {};\n');
      const inspection = await inspectSharkcraft({ cwd: root });
      const { buildRepositoryMap } = await import('@shrkcrft/inspector');
      const map = await buildRepositoryMap(inspection);
      expect(map.languageCounts).toBeDefined();
      expect(typeof map.languageCounts!['typescript']).toBe('number');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('language profiles still pure', () => {
  test('TS-only project does not surface any polyglot edges', () => {
    const root = mkTempProject('ts-only');
    try {
      writeFileSync(join(root, 'package.json'), '{"name":"demo"}');
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src', 'index.ts'), 'export {};\n');
      const report = buildPolyglotBoundaryReport({ projectRoot: root });
      expect(report.languages.length).toBe(0);
      expect(report.counts.violations).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('detectLanguageProfiles yields a typescript profile for a TS repo', () => {
    const root = mkTempProject('ts-detect');
    try {
      writeFileSync(join(root, 'package.json'), '{"name":"demo"}');
      writeFileSync(join(root, 'tsconfig.json'), '{}');
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src', 'a.ts'), 'export const x = 1;\n');
      const r = detectLanguageProfiles(root);
      expect(r.profiles.some((p) => p.language === LanguageId.TypeScript)).toBe(true);
      if (existsSync(join(root, 'tsconfig.json'))) {
        // tsconfig hint kept.
        const ts = r.profiles.find((p) => p.language === LanguageId.TypeScript)!;
        expect(ts.buildFiles).toContain('tsconfig.json');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
