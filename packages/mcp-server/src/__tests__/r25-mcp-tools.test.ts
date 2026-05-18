import { describe, expect, it } from 'bun:test';
import { ALL_TOOLS } from '../tools/index.ts';

describe('MCP tools', () => {
  it('all new tools are present', () => {
    const ids = new Set(ALL_TOOLS.map((t) => t.name));
    expect(ids.has('get_language_profiles')).toBe(true);
    expect(ids.has('get_language_commands')).toBe(true);
    expect(ids.has('get_polyglot_dependency_graph')).toBe(true);
    expect(ids.has('get_polyglot_test_impact')).toBe(true);
    expect(ids.has('get_language_report')).toBe(true);
    expect(ids.has('get_memory_diff')).toBe(true);
    expect(ids.has('get_memory_drift')).toBe(true);
    expect(ids.has('list_contract_templates')).toBe(true);
    expect(ids.has('get_contract_template')).toBe(true);
  });

  it('tool descriptions advertise read-only intent (no canWrite false-positives)', () => {
    const r25 = [
      'get_language_profiles',
      'get_language_commands',
      'get_polyglot_dependency_graph',
      'get_polyglot_test_impact',
      'get_language_report',
      'get_memory_diff',
      'get_memory_drift',
      'list_contract_templates',
      'get_contract_template',
    ];
    for (const name of r25) {
      const tool = ALL_TOOLS.find((t) => t.name === name);
      expect(tool).toBeDefined();
      expect(tool!.description.toLowerCase()).toContain('read-only');
    }
  });
});
