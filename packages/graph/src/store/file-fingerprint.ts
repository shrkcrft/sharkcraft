import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IFileFingerprint } from '../schema/file-fingerprint.ts';

const TS_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const JS_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs']);

function languageOf(absPath: string): string {
  const ext = nodePath.extname(absPath).toLowerCase();
  if (TS_EXTS.has(ext)) return 'typescript';
  if (JS_EXTS.has(ext)) return 'javascript';
  if (ext === '.vue') return 'vue';
  if (ext === '.svelte') return 'svelte';
  if (ext === '.astro') return 'astro';
  if (ext === '.py') return 'python';
  if (ext === '.go') return 'go';
  if (ext === '.java') return 'java';
  if (ext === '.rs') return 'rust';
  if (ext === '.kt' || ext === '.kts') return 'kotlin';
  if (ext === '.rb') return 'ruby';
  if (ext === '.cs' || ext === '.csx') return 'csharp';
  if (ext === '.ex' || ext === '.exs') return 'elixir';
  if (ext === '.php') return 'php';
  if (ext === '.dart') return 'dart';
  if (ext === '.swift') return 'swift';
  if (ext === '.graphql' || ext === '.gql') return 'graphql';
  return 'unknown';
}

/**
 * Compute a fingerprint for a file. Reads the file once; callers that
 * already have the contents should use `fingerprintFromContent` instead.
 */
export function fingerprintFile(
  absPath: string,
  projectRoot: string,
): IFileFingerprint {
  const st = statSync(absPath);
  const buf = readFileSync(absPath);
  return fingerprintFromBuffer(buf, absPath, projectRoot, st.mtimeMs, st.size);
}

export function fingerprintFromBuffer(
  buf: Buffer,
  absPath: string,
  projectRoot: string,
  mtimeMs: number,
  sizeBytes: number,
): IFileFingerprint {
  const sha1 = createHash('sha1').update(buf).digest('hex');
  const rel = nodePath.relative(projectRoot, absPath);
  return {
    path: rel.split(nodePath.sep).join('/'),
    mtime: Math.floor(mtimeMs),
    sha1,
    sizeBytes,
    language: languageOf(absPath),
    nodeId: `file:${rel.split(nodePath.sep).join('/')}`,
  };
}
