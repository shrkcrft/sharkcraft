import { buildSchemaInventory, findSchemaInventoryEntry } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getSchemaInventoryTool: IToolDefinition = {
  name: 'get_schema_inventory',
  description:
    'Engine schema-id inventory: known versions, current version, deprecation/back-compat status. Pass `id` for one schema only. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Optional schema id (e.g. "sharkcraft.self-config-doctor").' },
    },
    additionalProperties: false,
  },
  handler(input) {
    const id = typeof (input as { id?: unknown }).id === 'string' ? (input as { id: string }).id : null;
    if (id) {
      const entry = findSchemaInventoryEntry(id);
      if (!entry) {
        return { data: { found: false, id } };
      }
      return { data: { found: true, entry } };
    }
    return { data: buildSchemaInventory() };
  },
};
