import { readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { ISurfaceConfig } from '@shrkcrft/config';

export interface ISurfaceConfigEdit {
  /** What changed. */
  field: 'enabled' | 'hidden';
  /** Command name that was added/removed. */
  command: string;
  /** Operation. */
  operation: 'add' | 'remove';
}

export interface ISurfaceConfigDiff {
  configFile: string;
  before: ISurfaceConfig;
  after: ISurfaceConfig;
  edits: readonly ISurfaceConfigEdit[];
  /** Suggested next-command if the user wants to apply. */
  nextCommand: string;
}

export interface ISurfaceConfigWriteResult {
  configFile: string;
  edits: readonly ISurfaceConfigEdit[];
  /** Whether the file existed before the write. */
  fileExisted: boolean;
}

/**
 * Mutate the `surface.enabled[]` array in
 * `sharkcraft.config.ts`. Preview-first: the caller computes the diff
 * via {@link planSurfaceEdit} and only applies it via
 * {@link applySurfaceEdit} when `--write` is passed.
 */
export function planSurfaceEdit(
  configFile: string,
  before: ISurfaceConfig | undefined,
  edits: readonly ISurfaceConfigEdit[],
): ISurfaceConfigDiff {
  const beforeNormalised: ISurfaceConfig = {
    enabled: [...(before?.enabled ?? [])],
    hidden: [...(before?.hidden ?? [])],
  };
  const afterEnabled = new Set(beforeNormalised.enabled ?? []);
  const afterHidden = new Set(beforeNormalised.hidden ?? []);

  for (const edit of edits) {
    const target = edit.field === 'enabled' ? afterEnabled : afterHidden;
    if (edit.operation === 'add') target.add(edit.command);
    else target.delete(edit.command);
  }

  const after: ISurfaceConfig = {
    enabled: [...afterEnabled].sort(),
    hidden: [...afterHidden].sort(),
  };

  return {
    configFile,
    before: beforeNormalised,
    after,
    edits,
    nextCommand: edits.length > 0 ? edits.map((e) => describeEdit(e)).join(', ') : '(no-op)',
  };
}

function describeEdit(edit: ISurfaceConfigEdit): string {
  const verb = edit.operation === 'add' ? '+' : '-';
  return `${verb} surface.${edit.field}: ${edit.command}`;
}

/**
 * Apply a previously-planned surface edit to the config file.
 *
 * Strategy:
 *   1. Read the config file as text.
 *   2. If a `surface:` block exists, replace it.
 *   3. Otherwise, append it before the final `})` / `});` of the
 *      default-exported config object.
 *
 * The mutator is intentionally text-based (not AST). The config shape
 * is small and the surface block is well-defined; an AST pass would
 * add complexity for no extra correctness. Unit tests lock the behavior.
 */
export function applySurfaceEdit(
  diff: ISurfaceConfigDiff,
): ISurfaceConfigWriteResult {
  if (diff.edits.length === 0) {
    return { configFile: diff.configFile, edits: [], fileExisted: true };
  }

  const fileExisted = fileExists(diff.configFile);
  const original = fileExisted ? readFileSync(diff.configFile, 'utf8') : DEFAULT_CONFIG_BODY;
  const updated = applySurfaceTextEdit(original, diff.after);
  writeFileSync(diff.configFile, updated, 'utf8');

  return {
    configFile: diff.configFile,
    edits: diff.edits,
    fileExisted,
  };
}

function fileExists(p: string): boolean {
  try {
    readFileSync(p, 'utf8');
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_CONFIG_BODY = `import { defineSharkCraftConfig } from '@shrkcrft/config';

export default defineSharkCraftConfig({
});
`;

const SURFACE_BLOCK_REGEX = /(^\s*surface\s*:\s*\{[\s\S]*?\}\s*,?\s*\n)/m;

/**
 * Render the surface block as a TS object literal.
 */
export function renderSurfaceBlock(surface: ISurfaceConfig, indent = '  '): string {
  const lines: string[] = [];
  lines.push(`${indent}surface: {`);
  if (surface.profile) {
    lines.push(`${indent}  profile: ${JSON.stringify(surface.profile)},`);
  }
  if (surface.enabled && surface.enabled.length > 0) {
    lines.push(`${indent}  enabled: [`);
    for (const name of surface.enabled) lines.push(`${indent}    ${JSON.stringify(name)},`);
    lines.push(`${indent}  ],`);
  } else {
    lines.push(`${indent}  enabled: [],`);
  }
  if (surface.hidden && surface.hidden.length > 0) {
    lines.push(`${indent}  hidden: [`);
    for (const name of surface.hidden) lines.push(`${indent}    ${JSON.stringify(name)},`);
    lines.push(`${indent}  ],`);
  } else {
    lines.push(`${indent}  hidden: [],`);
  }
  lines.push(`${indent}},`);
  return lines.join('\n') + '\n';
}

/**
 * Compute the new file body given the desired surface block.
 *
 * If the file already has a `surface: { ... }` block, replace it.
 * Otherwise, insert before the closing `})` / `});` of the config
 * literal.
 */
export function applySurfaceTextEdit(original: string, surface: ISurfaceConfig): string {
  const block = renderSurfaceBlock(surface);

  if (SURFACE_BLOCK_REGEX.test(original)) {
    return original.replace(SURFACE_BLOCK_REGEX, block);
  }

  // Insert before the closing `})` / `});` of the config object.
  // Prefer the last `})` so nested objects don't trip us up.
  const closeRegex = /(\n)(\}\)\s*;?\s*)$/m;
  if (closeRegex.test(original)) {
    return original.replace(closeRegex, `\n${block}$2`);
  }

  // Fallback: append at end with a defineSharkCraftConfig wrapper.
  return `${original}\n${DEFAULT_CONFIG_BODY.replace('})', `${block}})`)}`;
}

/** Default config file path for a project. */
export function defaultConfigFile(sharkcraftDir: string): string {
  return nodePath.join(sharkcraftDir, 'sharkcraft.config.ts');
}
