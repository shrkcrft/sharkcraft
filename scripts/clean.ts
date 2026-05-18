#!/usr/bin/env bun
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const targets = ['dist', 'build', 'node_modules', '.cache', '.turbo'];

function walk(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (targets.includes(entry.name)) {
        rmSync(full, { recursive: true, force: true });
        process.stdout.write(`[clean] removed ${full}\n`);
      } else if (entry.name !== 'node_modules' && !entry.name.startsWith('.git')) {
        walk(full);
      }
    }
  }
}

if (!existsSync(root) || !statSync(root).isDirectory()) {
  process.stderr.write('[clean] cwd is not a directory\n');
  process.exit(1);
}
walk(root);
process.stdout.write('[clean] ok\n');
