export const URI_SCHEME = 'sharkcraft';

export const OVERVIEW_URI = `${URI_SCHEME}://overview`;
export const AGENT_INSTRUCTIONS_URI = `${URI_SCHEME}://agent-instructions`;

export function knowledgeUri(id: string): string {
  return `${URI_SCHEME}://knowledge/${encodeURIComponent(id)}`;
}

export function templateUri(id: string): string {
  return `${URI_SCHEME}://template/${encodeURIComponent(id)}`;
}

export function docUri(relativePath: string): string {
  return `${URI_SCHEME}://docs/${relativePath.split('/').map(encodeURIComponent).join('/')}`;
}

export interface ParsedResourceUri {
  scheme: string;
  kind: 'overview' | 'agent-instructions' | 'knowledge' | 'template' | 'docs' | 'unknown';
  id?: string;
  path?: string;
}

export function parseResourceUri(uri: string): ParsedResourceUri {
  if (!uri.startsWith(`${URI_SCHEME}://`)) {
    return { scheme: 'unknown', kind: 'unknown' };
  }
  const rest = uri.slice(`${URI_SCHEME}://`.length);
  if (rest === 'overview') return { scheme: URI_SCHEME, kind: 'overview' };
  if (rest === 'agent-instructions') {
    return { scheme: URI_SCHEME, kind: 'agent-instructions' };
  }
  const [kind, ...rest2] = rest.split('/');
  if (kind === 'knowledge' && rest2.length > 0) {
    return { scheme: URI_SCHEME, kind: 'knowledge', id: decodeURIComponent(rest2.join('/')) };
  }
  if (kind === 'template' && rest2.length > 0) {
    return { scheme: URI_SCHEME, kind: 'template', id: decodeURIComponent(rest2.join('/')) };
  }
  if (kind === 'docs' && rest2.length > 0) {
    return {
      scheme: URI_SCHEME,
      kind: 'docs',
      path: rest2.map(decodeURIComponent).join('/'),
    };
  }
  return { scheme: URI_SCHEME, kind: 'unknown' };
}
