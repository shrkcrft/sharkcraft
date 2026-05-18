export function readUserRow(id: string): { id: string; name: string } | null {
  return id === '1' ? { id: '1', name: 'Ada' } : null;
}
