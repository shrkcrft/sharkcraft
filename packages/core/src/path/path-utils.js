import * as nodePath from 'node:path';
export function joinPath(...parts) {
    return nodePath.join(...parts);
}
export function resolvePath(...parts) {
    return nodePath.resolve(...parts);
}
export function normalizePath(p) {
    return nodePath.normalize(p);
}
export function isAbsolutePath(p) {
    return nodePath.isAbsolute(p);
}
export function basename(p, ext) {
    return ext === undefined ? nodePath.basename(p) : nodePath.basename(p, ext);
}
export function dirname(p) {
    return nodePath.dirname(p);
}
export function extname(p) {
    return nodePath.extname(p);
}
export function relativePath(from, to) {
    return nodePath.relative(from, to);
}
export function isPathInside(child, parent) {
    const rel = nodePath.relative(parent, child);
    return rel !== '' && !rel.startsWith('..') && !nodePath.isAbsolute(rel);
}
export function ensureTrailingSlash(p) {
    return p.endsWith('/') ? p : p + '/';
}
export function stripTrailingSlash(p) {
    return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}
export function toPosix(p) {
    return p.split(nodePath.sep).join('/');
}
