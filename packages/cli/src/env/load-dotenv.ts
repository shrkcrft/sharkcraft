import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';

/**
 * Minimal `.env` loader for the Node-based `shrk` binary.
 *
 * Bun auto-loads `.env`; Node does not. This walks from `cwd` up to the
 * filesystem root looking for a `.env` file and merges any KEY=VALUE
 * pairs into `process.env` — but only when the key is not already set,
 * so an actual shell export always wins.
 *
 * No dependency on `dotenv`. Parser is intentionally small: lines that
 * start with `#` are comments, blank lines are skipped, surrounding
 * single/double quotes on the value are stripped, and escaped `\n`
 * sequences inside double-quoted values become real newlines.
 */
export function loadDotenv(startDir: string): void {
  const envPath = findEnvFile(startDir);
  if (!envPath) return;
  let body: string;
  try {
    body = readFileSync(envPath, 'utf8');
  } catch {
    return;
  }
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!isValidKey(key)) continue;
    if (process.env[key] !== undefined) continue;
    process.env[key] = unquote(line.slice(eq + 1).trim());
  }
}

function isValidKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if (first === '"' && last === '"') {
      return value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
    }
    if (first === "'" && last === "'") {
      return value.slice(1, -1);
    }
  }
  const hash = value.indexOf(' #');
  return hash === -1 ? value : value.slice(0, hash).trimEnd();
}

function findEnvFile(startDir: string): string | null {
  let dir = nodePath.resolve(startDir);
  while (true) {
    const candidate = nodePath.join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = nodePath.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
