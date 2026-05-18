/**
 * surface-config-writer: text-level mutation of the
 * `surface:` block in sharkcraft.config.ts. Locks idempotency,
 * insertion when the block is absent, and replacement when present.
 */
import { describe, expect, test } from 'bun:test';
import {
  applySurfaceTextEdit,
  planSurfaceEdit,
  renderSurfaceBlock,
} from '../surface/surface-config-writer.ts';

const CONFIG_NO_SURFACE = `import { defineSharkCraftConfig } from '@shrkcrft/config';

export default defineSharkCraftConfig({
  projectName: 'demo',
  knowledgeFiles: ['knowledge.ts'],
});
`;

const CONFIG_WITH_SURFACE = `import { defineSharkCraftConfig } from '@shrkcrft/config';

export default defineSharkCraftConfig({
  projectName: 'demo',
  surface: {
    enabled: ['some-cmd'],
    hidden: [],
  },
});
`;

describe('surface-config-writer', () => {
  test('renderSurfaceBlock emits stable shape', () => {
    const out = renderSurfaceBlock({ enabled: ['a', 'b'], hidden: ['c'] });
    expect(out).toContain('surface: {');
    expect(out).toContain('"a"');
    expect(out).toContain('"b"');
    expect(out).toContain('"c"');
  });

  test('inserts surface block when absent', () => {
    const out = applySurfaceTextEdit(CONFIG_NO_SURFACE, {
      enabled: ['demo-cmd'],
      hidden: [],
    });
    expect(out).toContain('surface: {');
    expect(out).toContain('"demo-cmd"');
    expect(out).toContain('defineSharkCraftConfig({');
    expect(out).toContain('})');
  });

  test('replaces existing surface block', () => {
    const out = applySurfaceTextEdit(CONFIG_WITH_SURFACE, {
      enabled: ['new-cmd'],
      hidden: ['hidden-cmd'],
    });
    expect(out).toContain('"new-cmd"');
    expect(out).toContain('"hidden-cmd"');
    expect(out).not.toContain('"some-cmd"');
  });

  test('idempotent: applying the same edit twice yields identical output', () => {
    const once = applySurfaceTextEdit(CONFIG_NO_SURFACE, {
      enabled: ['x'],
      hidden: [],
    });
    const twice = applySurfaceTextEdit(once, { enabled: ['x'], hidden: [] });
    expect(once).toBe(twice);
  });

  test('planSurfaceEdit produces the desired final state', () => {
    const diff = planSurfaceEdit(
      '/tmp/x.ts',
      { enabled: ['a'], hidden: [] },
      [
        { field: 'enabled', command: 'b', operation: 'add' },
        { field: 'hidden', command: 'c', operation: 'add' },
      ],
    );
    expect(diff.after.enabled).toEqual(['a', 'b']);
    expect(diff.after.hidden).toEqual(['c']);
  });

  test('planSurfaceEdit dedupes additions', () => {
    const diff = planSurfaceEdit(
      '/tmp/x.ts',
      { enabled: ['a'], hidden: [] },
      [
        { field: 'enabled', command: 'a', operation: 'add' },
        { field: 'enabled', command: 'a', operation: 'add' },
      ],
    );
    expect(diff.after.enabled).toEqual(['a']);
  });

  test('planSurfaceEdit removes entries cleanly', () => {
    const diff = planSurfaceEdit(
      '/tmp/x.ts',
      { enabled: ['a', 'b', 'c'], hidden: [] },
      [{ field: 'enabled', command: 'b', operation: 'remove' }],
    );
    expect(diff.after.enabled).toEqual(['a', 'c']);
  });
});
