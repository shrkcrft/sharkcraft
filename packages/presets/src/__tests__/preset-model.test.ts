import { describe, expect, test } from 'bun:test';
import { WorkspaceProfile } from '@shrkcrft/workspace';
import {
  BUILTIN_PRESETS,
  PresetRegistry,
  definePreset,
  previewPresetApplication,
  recommendPresets,
  synthesizePresetFiles,
  validatePreset,
} from '../index.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

describe('preset model', () => {
  test('definePreset is identity-typed', () => {
    const p = definePreset({
      id: 'p',
      title: 't',
      description: 'd',
      includes: {},
    });
    expect(p.id).toBe('p');
  });

  test('validatePreset rejects missing id / title / description', () => {
    const r = validatePreset({ id: '' });
    expect(r.valid).toBe(false);
    expect(r.issues.map((i) => i.field)).toContain('id');
  });

  test('built-in registry has all 10 presets with unique ids', () => {
    const reg = new PresetRegistry([...BUILTIN_PRESETS]);
    expect(reg.size()).toBeGreaterThanOrEqual(10);
    const ids = new Set(reg.list().map((p) => p.id));
    expect(ids.size).toBe(reg.size());
  });
});

describe('preset recommendation', () => {
  test('ranks TypeScript+library profiles toward typescript-library', () => {
    const recs = recommendPresets([...BUILTIN_PRESETS], {
      profiles: [WorkspaceProfile.HasTypeScript, WorkspaceProfile.IsLibrary],
    });
    const top = recs[0]!;
    expect(top.preset.id).toBe('typescript-library');
    expect(top.confidence).toBe('high');
  });

  test('excludes presets blocked by notAppropriateFor', () => {
    const recs = recommendPresets([...BUILTIN_PRESETS], {
      profiles: [
        WorkspaceProfile.IsService,
        WorkspaceProfile.IsBackend,
        WorkspaceProfile.HasBun,
      ],
    });
    // node-api is notAppropriateFor has-bun
    expect(recs.find((r) => r.preset.id === 'node-api')).toBeUndefined();
  });
});

describe('preset preview', () => {
  test('generic preset produces config + knowledge + rules + paths + templates + pipelines', () => {
    const generic = BUILTIN_PRESETS.find((p) => p.id === 'generic')!;
    const files = synthesizePresetFiles(generic).map((f) => f.path);
    expect(files).toContain('sharkcraft.config.ts');
    expect(files).toContain('knowledge.ts');
    expect(files).toContain('rules.ts');
    expect(files).toContain('paths.ts');
    expect(files).toContain('templates.ts');
    expect(files).toContain('pipelines.ts');
  });

  test('preview marks existing files as skip-existing', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-preset-test-'));
    try {
      const generic = BUILTIN_PRESETS.find((p) => p.id === 'generic')!;
      const plan1 = previewPresetApplication(generic, { projectRoot: root });
      expect(plan1.entries.every((e) => e.status === 'create')).toBe(true);
      // Simulate that the files exist after a first apply.
      for (const e of plan1.entries.slice(0, 2)) {
        mkdirSync(dirname(e.targetPath), { recursive: true });
        writeFileSync(e.targetPath, 'placeholder', 'utf8');
      }
      const plan2 = previewPresetApplication(generic, { projectRoot: root });
      const skipped = plan2.entries.filter((e) => e.status === 'skip-existing');
      expect(skipped.length).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('preview honors --force (overwrite) and --merge (append for mergable kinds)', () => {
    const generic = BUILTIN_PRESETS.find((p) => p.id === 'generic')!;
    const root = mkdtempSync(join(tmpdir(), 'shrk-preset-merge-'));
    try {
      // Pre-create a knowledge file so we can verify merge-vs-force behavior.
      const target = join(root, 'sharkcraft', 'knowledge.ts');
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, 'existing', 'utf8');
      const planForce = previewPresetApplication(generic, {
        projectRoot: root,
        force: true,
      });
      const forceEntry = planForce.entries.find((e) => e.relPath.endsWith('knowledge.ts'))!;
      expect(forceEntry.status).toBe('overwrite-with-force');
      const planMerge = previewPresetApplication(generic, {
        projectRoot: root,
        merge: true,
      });
      const mergeEntry = planMerge.entries.find((e) => e.relPath.endsWith('knowledge.ts'))!;
      expect(mergeEntry.status).toBe('merge-additive');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
