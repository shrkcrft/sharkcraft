import { readUserRow } from '../infra/database';

export function lookupUser(id: string): { id: string; name: string } | null {
  const row = readUserRow(id);
  return row ? { id: row.id, name: row.name } : null;
}
