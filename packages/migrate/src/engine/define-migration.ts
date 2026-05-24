import { MIGRATION_SCHEMA, type IMigration } from '../schema/migration.ts';

/**
 * Type-safe builder for migration definitions. Validates basic shape
 * (no empty id / title / steps); deeper validation happens at plan /
 * apply time when the steps are evaluated.
 */
export function defineMigration(input: Omit<IMigration, 'schema'>): IMigration {
  if (!input.id) throw new Error('defineMigration: id is required');
  if (!input.title) throw new Error('defineMigration: title is required');
  if (!input.steps || input.steps.length === 0) {
    throw new Error('defineMigration: steps must be non-empty');
  }
  return { schema: MIGRATION_SCHEMA, ...input };
}
