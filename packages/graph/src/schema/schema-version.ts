/**
 * Schema version for the on-disk code graph.
 *
 * Every payload written to `.sharkcraft/graph/` and every JSON response
 * carries this constant. A change here is a breaking change and requires
 * a migration in the store.
 */
export const GRAPH_SCHEMA = 'sharkcraft.graph/v1' as const;

export type GraphSchemaVersion = typeof GRAPH_SCHEMA;
