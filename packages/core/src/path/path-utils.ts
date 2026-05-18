import * as nodePath from 'node:path';

export function joinPath(...parts: string[]): string {
  return nodePath.join(...parts);
}

export function resolvePath(...parts: string[]): string {
  return nodePath.resolve(...parts);
}

export function normalizePath(p: string): string {
  return nodePath.normalize(p);
}

export function isAbsolutePath(p: string): boolean {
  return nodePath.isAbsolute(p);
}

export function basename(p: string, ext?: string): string {
  return ext === undefined ? nodePath.basename(p) : nodePath.basename(p, ext);
}

export function dirname(p: string): string {
  return nodePath.dirname(p);
}

export function extname(p: string): string {
  return nodePath.extname(p);
}

export function relativePath(from: string, to: string): string {
  return nodePath.relative(from, to);
}

export function isPathInside(child: string, parent: string): boolean {
  const rel = nodePath.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !nodePath.isAbsolute(rel);
}

export function ensureTrailingSlash(p: string): string {
  return p.endsWith('/') ? p : p + '/';
}

export function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

export function toPosix(p: string): string {
  return p.split(nodePath.sep).join('/');
}
