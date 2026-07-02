import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRegistryLifecycleReport,
  renderRegistryLifecycleReportText,
} from '../registry-lifecycle.ts';

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-registry-lifecycle-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

describe('registry-lifecycle heuristic', () => {
  test('call sites and comments are NOT counted as register declarations', () => {
    const root = repo({
      'src/a.ts':
        '// registerThing(x) in a comment\n' +
        'const s = "registerThing(y)";\n' +
        'registry.registerSubcommand(group, handler);\n' +
        'registry.registerSubcommand(other, handler2);\n',
    });
    try {
      const report = buildRegistryLifecycleReport({ projectRoot: root });
      // No DECLARATIONS here — only calls + comment + string.
      expect(report.registersFound).toBe(0);
      expect(report.missingRemovers.length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a one-shot bootstrap declaration (no teardown API) is not a missing remover', () => {
    const root = repo({
      'src/boot.ts':
        'export function registerHandler(node) {\n  node.handler = () => 1;\n}\n',
    });
    try {
      const report = buildRegistryLifecycleReport({ projectRoot: root });
      expect(report.registersFound).toBe(1);
      expect(report.missingRemovers.length).toBe(0);
      expect(report.oneShotBootstrap.length).toBe(1);
      expect(report.oneShotBootstrap[0]!.registerName).toBe('registerHandler');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a paired register/remove in the same file is a matched pair', () => {
    const root = repo({
      'src/reg.ts':
        'const map = new Map();\n' +
        'export function registerThing(id, x) { map.set(id, x); }\n' +
        'export function removeThing(id) { map.delete(id); }\n',
    });
    try {
      const report = buildRegistryLifecycleReport({ projectRoot: root });
      expect(report.matchedPairs.length).toBe(1);
      expect(report.missingRemovers.length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('--changed-only (files: []) with nothing in scope reports a LOUD skip, not a green', () => {
    const root = repo({
      'src/reg.ts':
        'const m = new Map();\n' +
        'export function registerThing(id, x) { m.set(id, x); }\n' +
        'export function clearThing(id) { m.delete(id); }\n',
    });
    try {
      const report = buildRegistryLifecycleReport({ projectRoot: root, files: [] });
      expect(report.changedOnly).toBe(true);
      expect(report.filesScanned).toBe(0);
      // The renderer must not read as a clean pass.
      const text = renderRegistryLifecycleReportText(report);
      expect(text.toLowerCase()).toContain('not verified');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('--changed-only scopes the scan to just the listed files', () => {
    const root = repo({
      'src/reg.ts':
        'const m = new Map();\n' +
        'export function registerThing(id, x) { m.set(id, x); }\n' +
        'export function clearAll() { m.clear(); }\n',
      'src/other.ts': 'export const noop = 1;\n',
    });
    try {
      const report = buildRegistryLifecycleReport({ projectRoot: root, files: ['src/reg.ts'] });
      expect(report.changedOnly).toBe(true);
      expect(report.filesScanned).toBe(1);
      expect(report.registersFound).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an exhausted wall-clock budget flushes partial results and flags timedOut', () => {
    const root = repo({ 'src/a.ts': 'export function registerX(n) { return n; }\n' });
    try {
      // A budget already in the past forces the deadline check to fire on the
      // first file — the scan flushes rather than running to completion.
      const report = buildRegistryLifecycleReport({ projectRoot: root, budgetMs: -1 });
      expect(report.timedOut).toBe(true);
      expect(report.truncated).toBe(true);
      expect(report.filesScanned).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('skipDirs is configurable — tools/ skipped by default, scanned when overridden', () => {
    const root = repo({
      'tools/reg.ts':
        'const m = new Map();\n' +
        'export function registerThing(id, x) { m.set(id, x); }\n' +
        'export function clearAll() { m.clear(); }\n',
    });
    try {
      // Default source-only skip set excludes tools/ → the registration is invisible.
      const byDefault = buildRegistryLifecycleReport({ projectRoot: root });
      expect(byDefault.registersFound).toBe(0);
      // Override the skip set (drop 'tools') → the tools/ registration is scanned.
      const overridden = buildRegistryLifecycleReport({
        projectRoot: root,
        skipDirs: ['node_modules', 'dist', '.git'],
      });
      expect(overridden.registersFound).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('accumulation + a teardown-shaped API but NO matching remover is flagged', () => {
    const root = repo({
      'src/reg.ts':
        'const handlers = new Map();\n' +
        'export function registerHandler(id, h) { handlers.set(id, h); }\n' +
        'export function clearAll() { handlers.clear(); }\n',
    });
    try {
      const report = buildRegistryLifecycleReport({ projectRoot: root });
      // clearAll is a teardown-shaped API, map.set is accumulation, but there is
      // no removeHandler/clearHandler for the registered entry → genuine miss.
      expect(report.missingRemovers.length).toBe(1);
      expect(report.missingRemovers[0]!.registerName).toBe('registerHandler');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
