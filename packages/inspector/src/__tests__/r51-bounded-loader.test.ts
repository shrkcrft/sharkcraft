import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectSharkcraft, runDoctor } from '../sharkcraft-inspector.ts';
import { createInspectorCache } from '../inspector-cache.ts';

import { mkdirSync, readdirSync } from 'node:fs';

function makeFixture(): {
  root: string;
  sharkcraftDir: string;
  rulesPath: string;
  templatesPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'sc-r51-fix-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'r51-fixture', version: '0.0.0', private: true }),
  );
  const sc = join(root, 'sharkcraft');
  mkdirSync(sc);
  writeFileSync(
    join(sc, 'sharkcraft.config.ts'),
    `export default {
  projectName: 'r51-fixture',
  knowledgeFiles: ['./knowledge.ts'],
  ruleFiles: ['./rules.ts'],
  templateFiles: ['./templates.ts'],
};
`,
  );
  writeFileSync(
    join(sc, 'knowledge.ts'),
    `export const sample = { id: 'fixture.a', title: 'A', content: 'a', type: 'technical' };
`,
  );
  const rulesPath = join(sc, 'rules.ts');
  const templatesPath = join(sc, 'templates.ts');
  writeFileSync(
    rulesPath,
    `export const a = { id: 'fixture.rule.a', title: 'A', content: 'a', type: 'rule' };
`,
  );
  // Large template file (one big export with several function/variable
  // bodies). Should still load fine.
  let big = '';
  for (let i = 0; i < 600; i += 1) {
    big += `// padding line ${i}\n`;
  }
  writeFileSync(
    templatesPath,
    `${big}export const big = {
  id: 'fixture.big',
  name: 'Big template',
  description: 'large body',
  files: ({ name }: { name: string }) => [
    { targetPath: 'out/' + name + '.ts', content: 'hi' },
  ],
};
`,
  );
  return { root, sharkcraftDir: sc, rulesPath, templatesPath };
}

describe('bounded loader diagnostics', () => {
  test('inspection on a healthy fixture produces ok diagnostics with timing', async () => {
    const { root } = makeFixture();
    const r = await inspectSharkcraft({ cwd: root });
    expect(r.loaderDiagnostics.length).toBeGreaterThan(0);
    expect(r.loaderDiagnostics.every((d) => d.status === 'ok' || d.status === 'cached-skip')).toBe(
      true,
    );
    for (const d of r.loaderDiagnostics) {
      expect(typeof d.elapsedMs).toBe('number');
      expect(d.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(d.deduped === false || d.deduped === true).toBe(true);
    }
    expect(typeof r.inspectionElapsedMs).toBe('number');
    expect(r.inspectionElapsedMs).toBeGreaterThan(0);
    rmSync(root, { recursive: true, force: true });
  });

  test('a broken rules.ts surfaces as failed loader diagnostic — no silent exit, no hang', async () => {
    const { root, rulesPath } = makeFixture();
    writeFileSync(
      rulesPath,
      `export const x = { id: 'fixture.rule.a', type: 'rule', title: 'A', content: 'a' };
export const x = { id: 'fixture.rule.b', type: 'rule', title: 'B', content: 'b' };
`,
    );
    const start = Date.now();
    const r = await inspectSharkcraft({ cwd: root, loaderTimeoutMs: 3000 });
    const elapsed = Date.now() - start;
    // Must complete in well under any reasonable wall-clock budget.
    expect(elapsed).toBeLessThan(8000);
    const failed = r.loaderDiagnostics.find(
      (d) => d.kind === 'rules' && (d.status === 'failed' || d.status === 'timeout'),
    );
    expect(failed).toBeDefined();
    expect(failed!.errorMessage).toMatch(/has already been declared|timed out|x/);
    const doctor = runDoctor(r);
    expect(doctor.checks.some((c) => c.title.includes('Loader '))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test('cache writes a failure entry that is reused on the next inspect (cached-skip, no re-import)', async () => {
    const { root, rulesPath } = makeFixture();
    writeFileSync(
      rulesPath,
      `export const x = { id: 'fixture.rule.a', type: 'rule', title: 'A', content: 'a' };
export const x = { id: 'fixture.rule.b', type: 'rule', title: 'B', content: 'b' };
`,
    );

    // useCache: true — opt-in mirrors CLI behavior (MCP keeps default false).
    const first = await inspectSharkcraft({ cwd: root, loaderTimeoutMs: 3000, useCache: true });
    const firstRulesDiag = first.loaderDiagnostics.find((d) => d.kind === 'rules')!;
    expect(['failed', 'timeout']).toContain(firstRulesDiag.status);

    const second = await inspectSharkcraft({ cwd: root, loaderTimeoutMs: 3000, useCache: true });
    const secondRulesDiag = second.loaderDiagnostics.find((d) => d.kind === 'rules')!;
    expect(secondRulesDiag.status).toBe('cached-skip');
    // cachedStatus reflects the original failure mode; it's narrower
    // than `status` and never includes the 'cached-skip' literal.
    expect(['failed', 'timeout']).toContain(secondRulesDiag.cachedStatus ?? '');
    expect(secondRulesDiag.elapsedMs).toBeLessThan(50);
    void firstRulesDiag;
    rmSync(root, { recursive: true, force: true });
  });

  test('fixing the file invalidates the cache (mtime/size change) on the next run', async () => {
    const { root, rulesPath } = makeFixture();
    writeFileSync(
      rulesPath,
      `export const x = { id: 'fixture.rule.a', type: 'rule', title: 'A', content: 'a' };
export const x = { id: 'fixture.rule.b', type: 'rule', title: 'B', content: 'b' };
`,
    );
    const first = await inspectSharkcraft({ cwd: root, loaderTimeoutMs: 3000, useCache: true });
    expect(first.loaderDiagnostics.find((d) => d.kind === 'rules')!.status).not.toBe('ok');

    // Fix the file by removing the duplicate. Touch the body so size +
    // mtime change — the cache must invalidate based on the
    // fingerprint mismatch, not the disk path.
    writeFileSync(
      rulesPath,
      `export const xa = { id: 'fixture.rule.a', type: 'rule', title: 'A', content: 'a' };
export const xb = { id: 'fixture.rule.b', type: 'rule', title: 'B', content: 'b' };
// fixed
`,
    );
    await new Promise((r) => setTimeout(r, 20));

    const second = await inspectSharkcraft({ cwd: root, loaderTimeoutMs: 3000, useCache: true });
    const d = second.loaderDiagnostics.find((x) => x.kind === 'rules')!;
    // The cache must invalidate — we should NOT short-circuit with a
    // cached-skip. In a fresh process the retry succeeds; within the
    // same Bun process the file:// URL still resolves to the
    // previously-rejected module, so a timeout is also acceptable
    // here — both prove the cache let the loader run again.
    expect(d.status).not.toBe('cached-skip');
    rmSync(root, { recursive: true, force: true });
  });

  test('--no-cache bypass: cached failure must not short-circuit when useCache=false', async () => {
    const { root, rulesPath } = makeFixture();
    writeFileSync(
      rulesPath,
      `export const x = { id: 'a', type: 'rule', title: 'A', content: 'a' };
export const x = { id: 'b', type: 'rule', title: 'B', content: 'b' };
`,
    );
    // Seed the cache with a failure (opt-in).
    await inspectSharkcraft({ cwd: root, loaderTimeoutMs: 3000, useCache: true });
    // Re-run with cache disabled.
    const noCache = await inspectSharkcraft({
      cwd: root,
      useCache: false,
      loaderTimeoutMs: 3000,
    });
    const d = noCache.loaderDiagnostics.find((x) => x.kind === 'rules')!;
    expect(d.status).not.toBe('cached-skip');
    expect(['failed', 'timeout']).toContain(d.status);
    expect(noCache.cacheEnabled).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test('a large but valid template file completes within the timeout', async () => {
    const { root } = makeFixture();
    const r = await inspectSharkcraft({ cwd: root, loaderTimeoutMs: 5000 });
    const templates = r.loaderDiagnostics.filter((d) => d.kind === 'templates');
    expect(templates.length).toBeGreaterThan(0);
    expect(templates.every((d) => d.status === 'ok')).toBe(true);
    expect(r.templates.length).toBeGreaterThan(0);
    rmSync(root, { recursive: true, force: true });
  });

  test('cache persists across inspectSharkcraft calls under .sharkcraft/cache/inspector/v1/', async () => {
    const { root } = makeFixture();
    await inspectSharkcraft({ cwd: root, useCache: true });
    const dir = join(root, '.sharkcraft/cache/inspector/v1');
    expect(existsSync(dir)).toBe(true);
    const cache = createInspectorCache({ projectRoot: root });
    const entries = cache.list();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => typeof e.filePath === 'string')).toBe(true);
    expect(entries.every((e) => e.v === 1)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test('MCP-style call (useCache default) does NOT write the cache directory', async () => {
    const { root } = makeFixture();
    const before = readdirSync(root).sort();
    await inspectSharkcraft({ cwd: root });
    const after = readdirSync(root).sort();
    expect(after).toEqual(before);
    rmSync(root, { recursive: true, force: true });
  });

  test('doctor reports failed loaders as errors with a fix hint, not silent passes', async () => {
    const { root, rulesPath } = makeFixture();
    writeFileSync(
      rulesPath,
      `export const x = { id: 'a', type: 'rule', title: 'A', content: 'a' };
export const x = { id: 'b', type: 'rule', title: 'B', content: 'b' };
`,
    );
    const r = await inspectSharkcraft({ cwd: root, loaderTimeoutMs: 3000 });
    const doctor = runDoctor(r);
    const loaderCheck = doctor.checks.find((c) => /Loader (failed|timeout)/.test(c.title));
    expect(loaderCheck).toBeDefined();
    expect(typeof loaderCheck!.fix).toBe('string');
    rmSync(root, { recursive: true, force: true });
  });
});
