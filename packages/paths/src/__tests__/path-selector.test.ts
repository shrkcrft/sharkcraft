import { describe, expect, test } from 'bun:test';
import type { IPathConvention } from '../path-convention.ts';
import { definePathConvention } from '../path-convention.ts';
import { selectBestPath } from '../path-selector.ts';

const controllers = definePathConvention({
  id: 'controllers',
  title: 'HTTP controllers',
  path: 'src/controllers',
  tags: ['controller', 'http'],
  appliesWhen: ['add endpoint'],
  scope: ['api'],
});
const components = definePathConvention({
  id: 'components',
  title: 'React components',
  path: 'src/components',
  tags: ['component', 'ui'],
  appliesWhen: ['add component'],
  scope: ['web'],
});

describe('selectBestPath', () => {
  test('returns the best-scoring convention for a matching task', () => {
    const sel = selectBestPath([controllers, components], 'add endpoint for users');
    expect(sel).not.toBeNull();
    expect(sel!.convention.id).toBe('controllers');
    expect(sel!.score).toBeGreaterThan(0);
  });

  test('returns null when nothing matches', () => {
    expect(selectBestPath([controllers, components], 'unrelated zzz task')).toBeNull();
  });

  test('returns null for an empty candidate list', () => {
    expect(selectBestPath([], 'add endpoint')).toBeNull();
  });

  test('does not throw on null/undefined/blank task (defensive)', () => {
    expect(selectBestPath([controllers], null as unknown as string)).toBeNull();
    expect(selectBestPath([controllers], undefined as unknown as string)).toBeNull();
    expect(selectBestPath([controllers], '   ')).toBeNull();
  });

  test('does not throw on a null candidate list (defensive)', () => {
    expect(selectBestPath(null as unknown as IPathConvention[], 'add endpoint')).toBeNull();
  });
});
