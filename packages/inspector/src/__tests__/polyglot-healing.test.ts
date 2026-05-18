import { describe, expect, it } from 'bun:test';
import { buildHealingPlanFromError } from '../healing-plan.ts';

describe('healing plan polyglot diagnostics', () => {
  it('recognises Java cannot-find-symbol', async () => {
    const plan = buildHealingPlanFromError( '...error: cannot find symbol\n  symbol: class Foo');
    expect(plan.likelyCauses.some((c) => c.toLowerCase().includes('cannot find symbol'))).toBe(true);
  });

  it('recognises C# CS0246', async () => {
    const plan = buildHealingPlanFromError( 'error CS0246: The type or namespace name "Foo" could not be found');
    expect(plan.likelyCauses.some((c) => c.toLowerCase().includes('cs0246'))).toBe(true);
  });

  it('recognises Python ModuleNotFoundError', async () => {
    const plan = buildHealingPlanFromError( 'ModuleNotFoundError: No module named "foo"');
    expect(plan.likelyCauses.some((c) => c.toLowerCase().includes('modulenotfounderror'))).toBe(true);
  });

  it('recognises Go import cycle', async () => {
    const plan = buildHealingPlanFromError( 'imports b: import cycle not allowed');
    expect(plan.likelyCauses.some((c) => c.toLowerCase().includes('import cycle'))).toBe(true);
  });

  it('recognises Rust E0432', async () => {
    const plan = buildHealingPlanFromError( 'error[E0432]: unresolved import `foo`');
    expect(plan.likelyCauses.some((c) => c.toLowerCase().includes('e0432'))).toBe(true);
  });
});
