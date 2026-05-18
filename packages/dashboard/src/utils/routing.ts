import { useEffect, useState } from 'react';

export interface IRoute {
  hash: string;
  path: string;
  params: Record<string, string>;
}

function parseHash(): IRoute {
  const raw = (typeof window !== 'undefined' ? window.location.hash : '') || '#/overview';
  const noHash = raw.replace(/^#\/?/, '');
  const [pathPart, queryPart] = noHash.split('?');
  const path = '/' + (pathPart ?? '');
  const params: Record<string, string> = {};
  if (queryPart) {
    for (const pair of queryPart.split('&')) {
      const [k, v] = pair.split('=');
      if (k) params[decodeURIComponent(k)] = v ? decodeURIComponent(v) : '';
    }
  }
  return { hash: raw, path, params };
}

export function useRoute(): IRoute {
  const [route, setRoute] = useState<IRoute>(() => parseHash());
  useEffect(() => {
    const onChange = (): void => setRoute(parseHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function navigate(hash: string): void {
  const target = hash.startsWith('#') ? hash : `#${hash}`;
  if (window.location.hash === target) return;
  window.location.hash = target;
}

export function matchSegment(path: string, pattern: string): Record<string, string> | null {
  const ps = path.replace(/^\/|\/$/g, '').split('/');
  const ms = pattern.replace(/^\/|\/$/g, '').split('/');
  if (ps.length !== ms.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i]!;
    const p = ps[i]!;
    if (m.startsWith(':')) out[m.slice(1)] = decodeURIComponent(p);
    else if (m !== p) return null;
  }
  return out;
}
