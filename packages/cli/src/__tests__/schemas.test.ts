import { describe, expect, test } from 'bun:test';
import { ALL_SCHEMAS } from '../schemas/json-schemas.ts';

describe('schemas/ALL_SCHEMAS', () => {
  test('exposes the new dashboard / adoption / scaffold-pattern schemas', () => {
    const names = Object.keys(ALL_SCHEMAS);
    for (const id of [
      'dashboard-api-envelope',
      'dashboard-overview-response',
      'dashboard-adoption-response',
      'dashboard-session-response',
      'adoption-state',
      'adoption-summary',
      'adoption-merge-preview',
      'adoption-report',
      'scaffold-pattern',
      'inferred-template-candidate-v2',
      'quality-report',
      'safety-audit',
      'dev-session-state',
    ]) {
      expect(names).toContain(id);
    }
  });

  test('every schema is a JSON-serializable object', () => {
    for (const [name, schema] of Object.entries(ALL_SCHEMAS)) {
      expect(typeof schema).toBe('object');
      const roundTrip = JSON.parse(JSON.stringify(schema));
      expect(typeof roundTrip).toBe('object');
      expect(roundTrip).toHaveProperty('$schema');
      expect(roundTrip).toHaveProperty('title');
      // Sanity: id is unique enough to grep on.
      expect((roundTrip as { $id?: string }).$id ?? '').toContain(name);
    }
  });
});
