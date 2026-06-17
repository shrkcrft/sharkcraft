import { describe, expect, test } from 'bun:test';
import { resolveTargetRoot } from '../server/create-mcp-server.ts';
import { validateToolInput } from '../server/tool-input-validators.ts';

describe('resolveTargetRoot', () => {
  test('uses projectRoot when provided', () => {
    const r = resolveTargetRoot('/cwd-opt', '/explicit', { SHARKCRAFT_PROJECT_ROOT: '/env' });
    expect(r).toBe('/explicit');
  });

  test('falls back to cwd option when projectRoot is missing', () => {
    const r = resolveTargetRoot('/cwd-opt', undefined, { SHARKCRAFT_PROJECT_ROOT: '/env' });
    expect(r).toBe('/cwd-opt');
  });

  test('falls back to SHARKCRAFT_PROJECT_ROOT env when no options', () => {
    const r = resolveTargetRoot(undefined, undefined, { SHARKCRAFT_PROJECT_ROOT: '/env' });
    expect(r).toBe('/env');
  });

  test('falls back to process.cwd() last', () => {
    const r = resolveTargetRoot(undefined, undefined, {});
    expect(r).toBe(process.cwd());
  });

  test('always returns an absolute path', () => {
    const r = resolveTargetRoot('relative/path', undefined, {});
    expect(r.startsWith('/')).toBe(true);
  });
});

describe('validateToolInput', () => {
  test('accepts valid input', () => {
    const result = validateToolInput('create_generation_plan', {
      templateId: 'typescript.service',
      name: 'user-profile',
    });
    expect(result.ok).toBe(true);
  });

  test('rejects missing required field', () => {
    const result = validateToolInput('create_generation_plan', { name: 'foo' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.toolName).toBe('create_generation_plan');
      expect(result.failure.message.toLowerCase()).toContain('templateid');
    }
  });

  test('rejects wrong type', () => {
    const result = validateToolInput('get_knowledge', { id: 42 });
    expect(result.ok).toBe(false);
  });

  test('passes through unknown tools (no schema = no validation)', () => {
    const result = validateToolInput('list_rules', { anything: 'goes' });
    expect(result.ok).toBe(true);
  });

  test('rejects extra unexpected fields (strict)', () => {
    const result = validateToolInput('create_generation_plan', {
      templateId: 'x',
      sneaky: 'value',
    });
    expect(result.ok).toBe(false);
  });

  test('compress_context accepts maxTokens (strict validator mirrors the inputSchema)', () => {
    // Regression: the strict zod validator runs on the real MCP wire BEFORE the
    // handler, so every input the tool advertises must be allowed here or the
    // call is rejected with "Unrecognized key". maxTokens arms SmartCrusher.
    const result = validateToolInput('compress_context', {
      content: '[{"a":1},{"a":2}]',
      contentType: 'json-array',
      query: 'a',
      maxItems: 5,
      maxTokens: 50,
    });
    expect(result.ok).toBe(true);
  });
});
