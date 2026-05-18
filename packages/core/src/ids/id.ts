let monotonicCounter = 0;

export function generateId(prefix = 'id'): string {
  monotonicCounter += 1;
  const ts = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 1e9).toString(36);
  return `${prefix}_${ts}_${rand}_${monotonicCounter.toString(36)}`;
}

const KNOWLEDGE_ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

export function isValidKnowledgeId(id: string): boolean {
  return KNOWLEDGE_ID_RE.test(id);
}

export function normalizeKnowledgeId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9.-]/g, '')
    .replace(/^[-.]+|[-.]+$/g, '');
}
