import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import * as nodePath from 'node:path';
import { Buffer } from 'node:buffer';
import type { ICcrStore } from './ccr-store.ts';
import type { ICcrEntry } from './ccr-entry.ts';
import { ccrKey } from './ccr-key.ts';

/** CCR keys are content hashes — hex only. Anything else (e.g. a path-traversal
 *  attempt like `../../etc/passwd`) is rejected so a lookup can never escape the
 *  store directory or read arbitrary files. */
const VALID_KEY = /^[0-9a-f]{1,64}$/;

/**
 * Filesystem-backed CCR store, used by the CLI (the write path). Each cached
 * original is one content-addressed file under the store directory (typically
 * `.sharkcraft/ccr/`), so `shrk compress` in one process and `shrk expand` in
 * a later process share the cache. The MCP server never uses this backend —
 * it stays in memory to honour the read-only contract.
 */
export class FileCcrStore implements ICcrStore {
  private readonly dir: string;

  constructor(dir: string) {
    // Field init only — directory creation is deferred to the first write.
    this.dir = dir;
  }

  private pathFor(key: string): string {
    return nodePath.join(this.dir, `${key}.txt`);
  }

  put(content: string): string {
    const key = ccrKey(content);
    const file = this.pathFor(key);
    if (!existsSync(file)) {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(file, content, 'utf8');
    }
    return key;
  }

  get(key: string): ICcrEntry | undefined {
    if (!VALID_KEY.test(key)) return undefined;
    const file = this.pathFor(key);
    if (!existsSync(file)) return undefined;
    const content = readFileSync(file, 'utf8');
    return { key, content, bytes: Buffer.byteLength(content, 'utf8') };
  }

  has(key: string): boolean {
    if (!VALID_KEY.test(key)) return false;
    return existsSync(this.pathFor(key));
  }

  size(): number {
    if (!existsSync(this.dir)) return 0;
    return readdirSync(this.dir).filter((f) => f.endsWith('.txt')).length;
  }
}
