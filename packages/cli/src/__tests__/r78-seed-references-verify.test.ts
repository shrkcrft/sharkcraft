/**
 * r78 — seeded knowledge verifies on a fresh repo of its kind (round 15
 * follow-up, F5/F13).
 *
 * Only the default `shrk init` seed declared references (round 15); the
 * `--legacy` seed and every framework / inline preset snippet declared none, so
 * a fresh `shrk init --preset <id>` failed its own `knowledge stale-check`
 * (exit 2, 167 of 173 distinct seeded entries unverifiable). Each seeded entry
 * now declares a reference that is TRUE on a fresh repo of its preset's kind:
 * the kind's marker file (angular.json, nest-cli.json, nx.json, turbo.json,
 * pom.xml, go.mod, Cargo.toml), else package.json, else a file `shrk init`
 * creates. Python (pyproject.toml OR requirements.txt) and Gradle (build.gradle
 * OR build.gradle.kts) carry no single marker, so both variants are locked.
 *
 * Per preset: a fresh fixture of that kind (its marker files, nothing else) +
 * the preset exactly as `shrk init --preset` writes it (and, for a composing
 * preset, as `shrk presets apply` writes it) → every seeded entry VERIFIED.
 * Real presets, the real inspection and stale engine; the CLI from source for
 * the end-to-end locks.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildKnowledgeStaleReport,
  inspectSharkcraft,
  KnowledgeEntryVerdict,
  ReferenceCheckOutcome,
  warmReferenceRegistries,
} from '@shrkcrft/inspector';
import {
  BUILTIN_PRESETS,
  PresetRegistry,
  previewPresetApplication,
  previewResolvedPresetApplication,
  resolvePreset,
  type IPreset,
  type IPresetApplyPlan,
} from '@shrkcrft/presets';
import { WorkspaceProfile } from '@shrkcrft/workspace';
import { INIT_FILES } from '../init/init-templates.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const T = 60_000;
const roots: string[] = [];

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/**
 * Seeded entries that cannot honestly reference anything on a fresh repo of
 * their kind stay unreferenced and are listed here. Empty: every seed has a
 * reference that is true from the first run.
 */
const HONESTLY_UNREFERENCED: ReadonlySet<string> = new Set<string>();

const PACKAGE_JSON = `${JSON.stringify({ name: 'r78-seed', version: '0.0.0', private: true })}\n`;

/**
 * Tags that name a WORKFLOW, never a stack. A preset with no profile whose
 * tags are all workflow tags governs a repo of ANY stack.
 */
const WORKFLOW_TAGS: ReadonlySet<string> = new Set([
  'generic',
  'core',
  'safety',
  'ai-agent',
  'agent',
  'generator',
  'testing',
  'enterprise',
  'governance',
]);

/** A kind-agnostic preset — its seeds must verify on a repo with no package.json at all. */
function isAnyRepoPreset(p: IPreset): boolean {
  return (p.appliesTo ?? []).length === 0 && (p.tags ?? []).every((t) => WORKFLOW_TAGS.has(t));
}

/** Fresh repos of the preset's kind — its marker files only (no src/, no tests/). */
function freshRepos(p: IPreset): Record<string, Record<string, string>> {
  const tags = new Set(p.tags ?? []);
  const profiles = new Set<string>(p.appliesTo ?? []);
  // Any stack (round 15 follow-up review): a fresh Java or Go repo has no
  // package.json — a package.json fixture hid enterprise-review-gated's two
  // package.json references, STALE on every non-JS repo.
  if (isAnyRepoPreset(p)) {
    return { bare: { 'README.md': '# r78\n' }, 'package.json': { 'package.json': PACKAGE_JSON } };
  }
  if (tags.has('maven')) return { maven: { 'pom.xml': '<project/>\n' } };
  if (tags.has('gradle')) {
    return {
      groovy: { 'build.gradle': "plugins { id 'java' }\n" },
      kotlin: { 'build.gradle.kts': 'plugins { java }\n' },
    };
  }
  if (tags.has('python')) {
    return {
      pyproject: { 'pyproject.toml': '[project]\nname = "r78"\n' },
      requirements: { 'requirements.txt': 'pytest\n' },
    };
  }
  if (tags.has('go')) return { go: { 'go.mod': 'module example.com/r78\n' } };
  if (tags.has('rust')) return { rust: { 'Cargo.toml': '[package]\nname = "r78"\n' } };
  if (tags.has('csharp')) return { dotnet: { 'App.csproj': '<Project Sdk="Microsoft.NET.Sdk" />\n' } };
  if (tags.has('polyglot')) return { polyglot: { 'go.mod': 'module example.com/r78\n', 'Cargo.toml': '[package]\nname = "r78"\n' } };
  const files: Record<string, string> = { 'package.json': PACKAGE_JSON };
  if (profiles.has(WorkspaceProfile.HasAngular)) files['angular.json'] = '{}\n';
  if (profiles.has(WorkspaceProfile.HasNestJS)) files['nest-cli.json'] = '{}\n';
  if (profiles.has(WorkspaceProfile.HasNx)) files['nx.json'] = '{}\n';
  if (profiles.has(WorkspaceProfile.HasTurborepo)) files['turbo.json'] = '{}\n';
  return { [Object.keys(files).join('+')]: files };
}

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r78-seed-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

/**
 * Write the plan; returns how many knowledge entries it SEEDS — every
 * `defineKnowledgeEntry(` in the knowledge / rules / paths files plus every
 * docs file — so a seed the loader refuses is a count mismatch, never a pass.
 */
function applyPlan(plan: IPresetApplyPlan): number {
  let seeded = 0;
  for (const e of plan.entries) {
    mkdirSync(dirname(e.targetPath), { recursive: true });
    writeFileSync(e.targetPath, e.content);
    if (e.kind === 'knowledge' || e.kind === 'rules' || e.kind === 'paths') {
      // The helper's own declaration reads `defineKnowledgeEntry<T>(`, so it never matches.
      seeded += e.content.split('defineKnowledgeEntry(').length - 1;
    } else if (e.kind === 'docs') {
      seeded += 1;
    }
  }
  return seeded;
}

interface ISeedOutcome {
  /** Every seeded entry that did not verify, and every non-ok reference — `[]` is the pass. */
  readonly problems: readonly string[];
  readonly entries: number;
  readonly verified: number;
}

async function seedOutcome(root: string): Promise<ISeedOutcome> {
  const insp = await inspectSharkcraft({ cwd: root });
  await warmReferenceRegistries(insp);
  const report = buildKnowledgeStaleReport(insp);
  const problems = [
    ...report.entryVerdicts
      .filter((v) => v.verdict !== KnowledgeEntryVerdict.Verified && !HONESTLY_UNREFERENCED.has(v.entryId))
      .map((v) => `${v.entryId}: ${v.verdict}${v.reason ? ` (${v.reason})` : ''} — ${v.source}`),
    ...report.referenceChecks
      .filter((c) => c.outcome !== ReferenceCheckOutcome.Ok)
      .map((c) => `${c.entryId} → ${c.outcome}: ${c.message}`),
    ...insp.validationIssues.filter((i) => i.severity === 'error').map((i) => `validation: ${i.message}`),
    ...insp.warnings.filter((w) => /failed to|timed out/i.test(w)).map((w) => `load: ${w}`),
  ];
  return {
    problems,
    entries: insp.knowledgeEntries.length,
    verified: report.entryVerdicts.filter((v) => v.verdict === KnowledgeEntryVerdict.Verified).length,
  };
}

const registry = new PresetRegistry([...BUILTIN_PRESETS]);
const presets = registry.list();

describe('r78 every built-in preset seeds knowledge that verifies on a fresh repo of its kind — as `shrk init --preset` writes it', () => {
  test('the registry is the whole built-in set', () => {
    expect(presets.length).toBe(new Set(BUILTIN_PRESETS.map((p) => p.id)).size);
    expect(presets.length).toBeGreaterThan(50);
  });
  test('the kind-agnostic presets are locked on a bare repo (the classification is not vacuous)', () => {
    const anyRepo = presets.filter(isAnyRepoPreset).map((p) => p.id);
    expect(anyRepo).toEqual(expect.arrayContaining(['generic', 'generic-safe-repo', 'enterprise-review-gated']));
    // A stack preset is never read as kind-agnostic.
    expect(anyRepo).not.toContain('strict-typescript');
    expect(anyRepo).not.toContain('playwright-focused');
  });
  for (const preset of presets) {
    for (const [kind, files] of Object.entries(freshRepos(preset))) {
      test(
        `${preset.id} on a fresh ${kind} repo`,
        async () => {
          const root = fixture(files);
          const seeded = applyPlan(previewPresetApplication(preset, { projectRoot: root }));
          const r = await seedOutcome(root);
          expect(r.problems).toEqual([]);
          // Every seeded entry loaded (a composition-only preset seeds none of its own here —
          // its composed entries are locked below, as `presets apply` writes them).
          expect(r.entries).toBe(seeded);
          expect(r.verified).toBe(r.entries);
        },
        T,
      );
    }
  }
});

describe('r78 composing presets verify as `shrk presets apply` writes them (composition-resolved)', () => {
  for (const preset of presets.filter((p) => (p.composes ?? []).length > 0)) {
    for (const [kind, files] of Object.entries(freshRepos(preset))) {
      test(
        `${preset.id} (resolved) on a fresh ${kind} repo`,
        async () => {
          const root = fixture(files);
          const seeded = applyPlan(
            previewResolvedPresetApplication(resolvePreset(registry, preset.id), { projectRoot: root }),
          );
          const r = await seedOutcome(root);
          expect(r.problems).toEqual([]);
          expect(r.entries).toBeGreaterThan(0);
          expect(r.entries).toBe(seeded);
          expect(r.verified).toBe(r.entries);
        },
        T,
      );
    }
  }
});

describe('r78 a marker reference carries meaning — the seed goes stale when the repo is not of its kind', () => {
  test(
    'an Angular preset on a repo without angular.json: its Angular entries are STALE (File missing: angular.json)',
    async () => {
      const preset = registry.get('angular-signals-first')!;
      const root = fixture({ 'package.json': PACKAGE_JSON });
      applyPlan(previewPresetApplication(preset, { projectRoot: root }));
      const insp = await inspectSharkcraft({ cwd: root });
      await warmReferenceRegistries(insp);
      const report = buildKnowledgeStaleReport(insp);
      const stale = report.referenceChecks.filter((c) => c.outcome === ReferenceCheckOutcome.Stale);
      expect(stale.map((c) => c.entryId).sort()).toEqual(['angular.on-push', 'angular.signals-first']);
      expect(stale.every((c) => c.message === 'File missing: angular.json')).toBe(true);
    },
    T,
  );
});

describe('r78 the `shrk init --legacy` seed verifies on a fresh repo', () => {
  test(
    'in-process: every entry it seeds (knowledge, rules, paths, docs) is VERIFIED',
    async () => {
      const root = fixture({ 'package.json': PACKAGE_JSON });
      for (const f of INIT_FILES) {
        mkdirSync(dirname(join(root, 'sharkcraft', f.relativePath)), { recursive: true });
        writeFileSync(join(root, 'sharkcraft', f.relativePath), f.content);
      }
      const r = await seedOutcome(root);
      expect(r.problems).toEqual([]);
      // 3 knowledge + 5 rules + 3 paths + 3 docs.
      expect(r.entries).toBe(14);
      expect(r.verified).toBe(14);
    },
    T,
  );
});

function shrk(cwd: string, argv: readonly string[]): { status: number; stdout: string; stderr: string } {
  // --no-install: the fixture has no node_modules, and Bun's auto-install hangs offline.
  const res = spawnSync('bun', ['--no-install', CLI_MAIN, '--no-hints', ...argv], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function gitFixture(files: Record<string, string>): string {
  const root = fixture(files);
  spawnSync('git', ['init', '-q'], { cwd: root });
  return root;
}

describe('r78 end to end: the seed passes its own stale-check', () => {
  test(
    '`shrk init --legacy` on a fresh package.json repo → `knowledge stale-check` 0',
    () => {
      const root = gitFixture({ 'package.json': PACKAGE_JSON });
      const init = shrk(root, ['init', '--legacy', '--no-gitignore']);
      expect(init.status).toBe(0);
      const s = shrk(root, ['knowledge', 'stale-check']);
      expect(s.stdout).toContain('14 of 14 knowledge entries verified');
      expect(s.status).toBe(0);
    },
    T,
  );

  test(
    '`shrk init --preset angular-21-modern` on a fresh Angular repo → `knowledge stale-check` 0',
    () => {
      const root = gitFixture({ 'package.json': PACKAGE_JSON, 'angular.json': '{}\n' });
      expect(shrk(root, ['init', '--preset', 'angular-21-modern', '--no-gitignore', '--write']).status).toBe(0);
      const s = shrk(root, ['knowledge', 'stale-check']);
      expect(s.status).toBe(0);
    },
    T,
  );

  test(
    '`shrk init --preset java-gradle-service` on a fresh Kotlin-DSL Gradle repo → `knowledge stale-check` 0',
    () => {
      const root = gitFixture({ 'build.gradle.kts': 'plugins { java }\n' });
      expect(shrk(root, ['init', '--preset', 'java-gradle-service', '--no-gitignore', '--write']).status).toBe(0);
      const s = shrk(root, ['knowledge', 'stale-check']);
      expect(s.status).toBe(0);
    },
    T,
  );
});
