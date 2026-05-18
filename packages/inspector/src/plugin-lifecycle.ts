/**
 * Plan-only plugin lifecycle helpers driven by a resolved profile.
 *
 * Lifecycle helpers never write source directly. They emit a structured plan
 * containing:
 *   - replaceOps:    safe `replace` plan operations against the profile's
 *                    key-table file, barrels, and other registry files.
 *   - manualSteps:   things the planned-operation model cannot do today
 *                    (rename a folder, delete a folder) when folder ops are
 *                    not requested or not safe.
 *   - conflicts:     anchors that could not be found — surfaced as advisory
 *                    hints (no failure).
 *   - destructive:   `true` for remove; `true` for rename when files need to
 *                    be renamed on disk.
 *
 * The engine has no project-specific knowledge: every path / key style / barrel
 * comes from the supplied `IPluginLifecycleProfile`. A pack contributes the
 * profile via `pluginLifecycleProfileFiles` on the manifest.
 */

import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs';
import { checkFolderOpSafety } from '@shrkcrft/generator';
import { join } from 'node:path';
import {
  CaseStyle,
  type IPluginLifecycleBarrel,
  type IPluginLifecycleKeyTable,
  type IPluginLifecycleProfile,
} from '@shrkcrft/plugin-api';

export enum PluginLifecycleAction {
  Rename = 'rename',
  Remove = 'remove',
}

export interface IPluginLifecycleManualStep {
  kind: 'delete-file' | 'delete-folder' | 'rename-file' | 'rename-folder';
  targetPath: string;
  newPath?: string;
  reason: string;
}

export interface IPluginLifecycleReplaceOp {
  targetPath: string;
  operation: {
    kind: 'replace';
    find: string;
    replaceWith: string;
    description: string;
  };
}

export interface IPluginLifecycleFolderOp {
  kind: 'rename-folder' | 'delete-folder';
  targetPath: string;
  newPath?: string;
  safety: 'safe' | 'unsafe';
  safetyReason?: string;
  reason: string;
}

export interface IPluginLifecyclePlan {
  schema: 'sharkcraft.plugin-lifecycle/v1';
  action: PluginLifecycleAction;
  /** Profile id (e.g. "my-monorepo"). Engine does not constrain this to a literal. */
  profile: string;
  oldName: string;
  newName?: string;
  destructive: boolean;
  humanApprovalRequired: boolean;
  replaceOps: ReadonlyArray<IPluginLifecycleReplaceOp>;
  manualSteps: ReadonlyArray<IPluginLifecycleManualStep>;
  /** Structured folder operations when --emit-folder-ops is requested. */
  folderOps?: ReadonlyArray<IPluginLifecycleFolderOp>;
  conflicts: ReadonlyArray<string>;
  validationCommands: ReadonlyArray<string>;
}

function readFileSafe(absPath: string): string | null {
  if (!existsSync(absPath)) return null;
  try {
    return readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a global regex that matches `${segment}/${name}` only when
 * `name` ends at a true token boundary (the next character is NOT an
 * identifier-continuation: kebab `-`, underscore `_`, digit, letter, or
 * dot). Prevents `data` from matching inside `dataflow`, `data-flow`, or
 * `data.foo`.
 */
function segmentBoundaryRegex(segment: string, name: string): RegExp {
  return new RegExp(
    `${escapeRegex(segment)}/${escapeRegex(name)}(?![A-Za-z0-9_\\-.])`,
    'g',
  );
}

function splitWords(input: string): string[] {
  if (!input) return [];
  // kebab / snake split
  if (input.includes('-') || input.includes('_')) {
    return input.split(/[-_]/).filter(Boolean);
  }
  // camel / pascal split on case boundaries
  return input.split(/(?=[A-Z])/).map((w) => w.toLowerCase()).filter(Boolean);
}

function toCase(input: string, style: CaseStyle): string {
  const words = splitWords(input);
  if (words.length === 0) return input;
  switch (style) {
    case CaseStyle.Kebab:
      return words.map((w) => w.toLowerCase()).join('-');
    case CaseStyle.UpperSnake:
      return words.map((w) => w.toUpperCase()).join('_');
    case CaseStyle.Pascal:
      return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
    case CaseStyle.Camel: {
      return words
        .map((w, i) =>
          i === 0
            ? w.toLowerCase()
            : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
        )
        .join('');
    }
    default:
      return input;
  }
}

function pluginKeysEntryRegex(keyTable: IPluginLifecycleKeyTable, name: string): RegExp {
  const key = toCase(name, keyTable.keyCase);
  const value = toCase(name, keyTable.valueCase);
  return new RegExp(`\\s*${escapeRegex(key)}:\\s*['"]${escapeRegex(value)}['"],?\\n`);
}

function findFirstMatch(content: string | null, re: RegExp): string | null {
  if (!content) return null;
  const m = content.match(re);
  return m ? m[0] : null;
}

interface ILoadedProfileContext {
  projectRoot: string;
  keyTablePath: string | null;
  keyTableContent: string | null;
  barrels: { barrel: IPluginLifecycleBarrel; absPath: string; content: string | null }[];
}

function loadProfileContext(
  projectRoot: string,
  profile: IPluginLifecycleProfile,
): ILoadedProfileContext {
  const keyTablePath = profile.keyTable?.path ? join(projectRoot, profile.keyTable.path) : null;
  const keyTableContent = keyTablePath ? readFileSafe(keyTablePath) : null;
  const barrels = (profile.barrels ?? []).map((b) => {
    const absPath = join(projectRoot, b.path);
    return { barrel: b, absPath, content: readFileSafe(absPath) };
  });
  return { projectRoot, keyTablePath, keyTableContent, barrels };
}

export interface IBuildPluginRenameInput {
  projectRoot: string;
  profile: IPluginLifecycleProfile;
  oldName: string;
  newName: string;
  /** When true, also emit structured folder rename ops in `folderOps[]`. */
  emitFolderOps?: boolean;
}

export function buildPluginRenamePlan(input: IBuildPluginRenameInput): IPluginLifecyclePlan {
  const { projectRoot, profile, oldName, newName } = input;
  const ctx = loadProfileContext(projectRoot, profile);
  const replaceOps: IPluginLifecycleReplaceOp[] = [];
  const manualSteps: IPluginLifecycleManualStep[] = [];
  const conflicts: string[] = [];

  // Key-table entry rename
  if (profile.keyTable && ctx.keyTableContent) {
    const keyTablePath = profile.keyTable.path;
    const keysFind = findFirstMatch(
      ctx.keyTableContent,
      pluginKeysEntryRegex(profile.keyTable, oldName),
    );
    if (keysFind) {
      const oldKey = toCase(oldName, profile.keyTable.keyCase);
      const newKey = toCase(newName, profile.keyTable.keyCase);
      const oldValue = toCase(oldName, profile.keyTable.valueCase);
      const newValue = toCase(newName, profile.keyTable.valueCase);
      replaceOps.push({
        targetPath: keyTablePath,
        operation: {
          kind: 'replace',
          find: keysFind,
          replaceWith: keysFind
            .replace(new RegExp(escapeRegex(oldKey)), newKey)
            .replace(new RegExp(`['"]${escapeRegex(oldValue)}['"]`), `'${newValue}'`),
          description: `Rename key-table entry ${oldKey} → ${newKey}; '${oldValue}' → '${newValue}'.`,
        },
      });
    } else {
      conflicts.push(`Key-table entry for "${oldName}" not found in ${keyTablePath}.`);
    }
  }

  // Barrel exports: word/token-bounded matching prevents substring
  // overlap (e.g. `data` matching inside `dataflow`). A segment match is
  // valid only when the character after `${segment}/${name}` is NOT a
  // kebab/identifier continuation character (so `data` doesn't pre-match
  // `dataflow`, `data-flow`, or `data_flow`).
  for (const { barrel, content } of ctx.barrels) {
    if (!content) continue;
    const segment = barrel.exportSegment ?? 'plugins';
    const segmentMatchRe = segmentBoundaryRegex(segment, oldName);
    if (segmentMatchRe.test(content)) {
      const lines = content.split('\n');
      for (const line of lines) {
        // Reset lastIndex so the global regex doesn't skip lines.
        segmentMatchRe.lastIndex = 0;
        if (segmentMatchRe.test(line)) {
          replaceOps.push({
            targetPath: barrel.path,
            operation: {
              kind: 'replace',
              find: line + '\n',
              replaceWith:
                line.replace(
                  segmentBoundaryRegex(segment, oldName),
                  `${segment}/${newName}`,
                ) + '\n',
              description: `Update barrel export from ${segment}/${oldName} to ${segment}/${newName}.`,
            },
          });
        }
      }
    } else {
      conflicts.push(`No barrel export referencing "${segment}/${oldName}" in ${barrel.path}.`);
    }
  }

  // Plugin folder renames — manual unless folder ops requested at the caller
  const folderOps: IPluginLifecycleFolderOp[] = [];
  for (const root of profile.pluginRoots) {
    const oldDir = join(projectRoot, root.path, oldName);
    if (existsSync(oldDir)) {
      if (input.emitFolderOps) {
        const safety = checkFolderOpSafety(projectRoot, `${root.path}/${oldName}`, 'rename-folder');
        folderOps.push({
          kind: 'rename-folder',
          targetPath: `${root.path}/${oldName}`,
          newPath: `${root.path}/${newName}`,
          safety: safety.safety,
          ...(safety.reason ? { safetyReason: safety.reason } : {}),
          reason:
            'Structured rename-folder op. Apply rejects unsafe paths automatically; humans still review.',
        });
      } else {
        manualSteps.push({
          kind: 'rename-folder',
          targetPath: `${root.path}/${oldName}`,
          newPath: `${root.path}/${newName}`,
          reason:
            'Rename plugin folder. Plan v2 has no rename-folder op by default; pass `--emit-folder-ops` to include them in the plan.',
        });
      }
    }
  }

  return {
    schema: 'sharkcraft.plugin-lifecycle/v1',
    action: PluginLifecycleAction.Rename,
    profile: profile.id,
    oldName,
    newName,
    destructive: manualSteps.length > 0 || folderOps.length > 0,
    humanApprovalRequired: true,
    replaceOps,
    manualSteps,
    ...(folderOps.length > 0 ? { folderOps } : {}),
    conflicts,
    validationCommands: profile.validationCommands ?? [
      'shrk check boundaries --changed-only',
      'shrk doctor',
    ],
  };
}

export interface IBuildPluginRemoveInput {
  projectRoot: string;
  profile: IPluginLifecycleProfile;
  oldName: string;
  /** When true, also emit structured folder delete ops in `folderOps[]`. */
  emitFolderOps?: boolean;
}

export function buildPluginRemovePlan(input: IBuildPluginRemoveInput): IPluginLifecyclePlan {
  const { projectRoot, profile, oldName } = input;
  const ctx = loadProfileContext(projectRoot, profile);
  const replaceOps: IPluginLifecycleReplaceOp[] = [];
  const manualSteps: IPluginLifecycleManualStep[] = [];
  const folderOps: IPluginLifecycleFolderOp[] = [];
  const conflicts: string[] = [];

  if (profile.keyTable && ctx.keyTableContent) {
    const keyTablePath = profile.keyTable.path;
    const keysFind = findFirstMatch(
      ctx.keyTableContent,
      pluginKeysEntryRegex(profile.keyTable, oldName),
    );
    if (keysFind) {
      const oldKey = toCase(oldName, profile.keyTable.keyCase);
      replaceOps.push({
        targetPath: keyTablePath,
        operation: {
          kind: 'replace',
          find: keysFind,
          replaceWith: '',
          description: `Remove key-table entry ${oldKey}.`,
        },
      });
    } else {
      conflicts.push(`Key-table entry for "${oldName}" not found in ${keyTablePath}.`);
    }
  }

  for (const { barrel, content } of ctx.barrels) {
    if (!content) continue;
    const segment = barrel.exportSegment ?? 'plugins';
    const segmentMatchRe = segmentBoundaryRegex(segment, oldName);
    const lines = content.split('\n');
    for (const line of lines) {
      segmentMatchRe.lastIndex = 0;
      if (segmentMatchRe.test(line)) {
        replaceOps.push({
          targetPath: barrel.path,
          operation: {
            kind: 'replace',
            find: line + '\n',
            replaceWith: '',
            description: `Remove barrel export referencing ${segment}/${oldName} from ${barrel.path}.`,
          },
        });
      }
    }
  }

  for (const root of profile.pluginRoots) {
    const oldDir = join(projectRoot, root.path, oldName);
    if (existsSync(oldDir)) {
      if (input.emitFolderOps) {
        const safety = checkFolderOpSafety(projectRoot, `${root.path}/${oldName}`, 'delete-folder');
        folderOps.push({
          kind: 'delete-folder',
          targetPath: `${root.path}/${oldName}`,
          safety: safety.safety,
          ...(safety.reason ? { safetyReason: safety.reason } : {}),
          reason:
            'Structured delete-folder op. Apply rejects unsafe paths and requires `--allow-delete-folder`.',
        });
      } else {
        manualSteps.push({
          kind: 'delete-folder',
          targetPath: `${root.path}/${oldName}`,
          reason:
            'Delete plugin folder. Destructive; plan v2 has no delete-folder op by default. Use `git rm -r` after the plan is applied, or pass `--emit-folder-ops`.',
        });
      }
    }
  }

  return {
    schema: 'sharkcraft.plugin-lifecycle/v1',
    action: PluginLifecycleAction.Remove,
    profile: profile.id,
    oldName,
    destructive: true,
    humanApprovalRequired: true,
    replaceOps,
    manualSteps,
    ...(folderOps.length > 0 ? { folderOps } : {}),
    conflicts,
    validationCommands: profile.validationCommands ?? [
      'shrk check boundaries --changed-only',
      'shrk doctor',
    ],
  };
}

/**
 * Convert a plugin-lifecycle plan into a saved plan (synthetic
 * templateId) so it can flow through `shrk apply`. ReplaceOps become
 * `expectedChanges` carrying their operation intent; folderOps[] is copied
 * through. The plan is unsigned by this helper; call `signPlan` separately.
 */
export const PLUGIN_LIFECYCLE_SYNTHETIC_TEMPLATE = '__plugin-lifecycle__';

export function pluginLifecyclePlanToSavedPlan(
  plan: IPluginLifecyclePlan,
  projectRoot: string,
): {
  schema: 'sharkcraft.plan/v2';
  templateId: string;
  name?: string;
  variables: Record<string, string>;
  projectRoot: string;
  createdAt: string;
  expectedChanges: {
    type: string;
    relativePath: string;
    sizeBytes: number;
    operation: IPluginLifecycleReplaceOp['operation'];
  }[];
  folderOps?: { kind: 'rename-folder' | 'delete-folder'; targetPath: string; newPath?: string; reason?: string }[];
  note?: string;
} {
  // Drop redundant no-op replace entries (find == replaceWith).
  const seen = new Set<string>();
  const filteredReplaceOps = plan.replaceOps.filter((op) => {
    if (op.operation.find === op.operation.replaceWith) return false;
    const key = `${op.targetPath}::${op.operation.find}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Compute the post-apply file size for each replace op against the
  // current file, so apply-time divergence detection doesn't false-positive
  // size-changes against a sentinel value.
  const expectedChanges = filteredReplaceOps.map((op) => {
    const abs = join(projectRoot, op.targetPath);
    let sizeBytes = Buffer.byteLength(op.operation.replaceWith, 'utf8');
    const existing = readFileSafe(abs);
    if (existing !== null) {
      // Compute the size as the file would look after the replace at save
      // time. Apply will re-evaluate against the (potentially newer) file
      // and `diffPlanChanges` compares this to the size produced by the
      // live evaluator.
      const findCount = (existing.match(new RegExp(escapeRegex(op.operation.find), 'g')) ?? []).length;
      if (findCount === 1) {
        const next = existing.replace(op.operation.find, op.operation.replaceWith);
        sizeBytes = Buffer.byteLength(next, 'utf8');
      } else {
        sizeBytes = Buffer.byteLength(existing, 'utf8');
      }
    }
    return {
      type: 'replace',
      relativePath: op.targetPath,
      sizeBytes,
      operation: op.operation,
    };
  });
  const out: {
    schema: 'sharkcraft.plan/v2';
    templateId: string;
    variables: Record<string, string>;
    projectRoot: string;
    createdAt: string;
    expectedChanges: typeof expectedChanges;
    folderOps?: { kind: 'rename-folder' | 'delete-folder'; targetPath: string; newPath?: string; reason?: string }[];
    note?: string;
    name?: string;
  } = {
    schema: 'sharkcraft.plan/v2',
    templateId: PLUGIN_LIFECYCLE_SYNTHETIC_TEMPLATE,
    variables: {
      profile: plan.profile,
      oldName: plan.oldName,
      ...(plan.newName ? { newName: plan.newName } : {}),
      action: plan.action,
    },
    projectRoot,
    createdAt: new Date().toISOString(),
    expectedChanges,
  };
  if (plan.folderOps && plan.folderOps.length > 0) {
    out.folderOps = plan.folderOps.map((fo) => {
      const entry: { kind: 'rename-folder' | 'delete-folder'; targetPath: string; newPath?: string; reason?: string } = {
        kind: fo.kind,
        targetPath: fo.targetPath,
        reason: fo.reason,
      };
      if (fo.newPath !== undefined) entry.newPath = fo.newPath;
      return entry;
    });
  }
  return out;
}

export function renderPluginLifecyclePlanText(plan: IPluginLifecyclePlan): string {
  const lines: string[] = [];
  lines.push(`=== Plugin ${plan.action} (${plan.profile} profile) ===`);
  lines.push(`  oldName       ${plan.oldName}`);
  if (plan.newName) lines.push(`  newName       ${plan.newName}`);
  lines.push(`  destructive   ${plan.destructive ? 'YES' : 'no'}`);
  lines.push(`  approval      ${plan.humanApprovalRequired ? 'human review required' : 'auto'}`);
  lines.push('');
  lines.push(`Planned replace ops (${plan.replaceOps.length}):`);
  for (const op of plan.replaceOps) {
    lines.push(`  • ${op.targetPath}`);
    lines.push(`      ${op.operation.description}`);
  }
  if (plan.manualSteps.length > 0) {
    lines.push('');
    lines.push(`Manual steps required (${plan.manualSteps.length}):`);
    for (const step of plan.manualSteps) {
      lines.push(`  • [${step.kind}] ${step.targetPath}${step.newPath ? ` → ${step.newPath}` : ''}`);
      lines.push(`      ${step.reason}`);
    }
  }
  if (plan.conflicts.length > 0) {
    lines.push('');
    lines.push(`Conflicts (${plan.conflicts.length}):`);
    for (const c of plan.conflicts) lines.push(`  • ${c}`);
  }
  lines.push('');
  lines.push(`Validation commands:`);
  for (const c of plan.validationCommands) lines.push(`  $ ${c}`);
  return lines.join('\n') + '\n';
}

export interface IPluginLifecycleListingInput {
  projectRoot: string;
  profile: IPluginLifecycleProfile;
}

export function buildPluginLifecycleListing(input: IPluginLifecycleListingInput): {
  pluginsByLayer: Readonly<Record<string, ReadonlyArray<string>>>;
  pluginKeys: ReadonlyArray<{ key: string; value: string }>;
} {
  const { projectRoot, profile } = input;
  const layers: Record<string, string[]> = {};
  for (const root of profile.pluginRoots) {
    const dir = join(projectRoot, root.path);
    if (!existsSync(dir)) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as Dirent[];
    } catch {
      continue;
    }
    layers[root.path] = entries
      .filter((e) => e.isDirectory())
      .map((e) => String(e.name));
  }
  const pluginKeys: { key: string; value: string }[] = [];
  if (profile.keyTable) {
    const keyTableContent = readFileSafe(join(projectRoot, profile.keyTable.path));
    if (keyTableContent) {
      const re = /(^|\n)\s*([A-Za-z_][A-Za-z0-9_]*):\s*'([A-Za-z_][A-Za-z0-9_-]*)'/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(keyTableContent)) !== null) {
        pluginKeys.push({ key: match[2]!, value: match[3]! });
      }
    }
  }
  return { pluginsByLayer: layers, pluginKeys };
}

/**
 * Doctor check: a profile is valid if every declared file exists and the
 * key-table file (if any) parses. This stays read-only; no fs mutations.
 */
export interface IPluginLifecycleProfileDoctorEntry {
  readonly id: 'missing-key-table' | 'missing-barrel' | 'missing-plugin-root' | 'ok';
  readonly severity: 'info' | 'warning' | 'error';
  readonly path?: string;
  readonly message: string;
}

export function checkPluginLifecycleProfileHealth(
  projectRoot: string,
  profile: IPluginLifecycleProfile,
): readonly IPluginLifecycleProfileDoctorEntry[] {
  const out: IPluginLifecycleProfileDoctorEntry[] = [];
  if (profile.keyTable) {
    const abs = join(projectRoot, profile.keyTable.path);
    if (!existsSync(abs)) {
      out.push({
        id: 'missing-key-table',
        severity: 'warning',
        path: profile.keyTable.path,
        message: `keyTable.path "${profile.keyTable.path}" not found in this workspace.`,
      });
    }
  }
  for (const b of profile.barrels ?? []) {
    if (!existsSync(join(projectRoot, b.path))) {
      out.push({
        id: 'missing-barrel',
        severity: 'warning',
        path: b.path,
        message: `Barrel "${b.id}" path "${b.path}" not found.`,
      });
    }
  }
  for (const r of profile.pluginRoots) {
    if (!existsSync(join(projectRoot, r.path))) {
      out.push({
        id: 'missing-plugin-root',
        severity: 'warning',
        path: r.path,
        message: `Plugin root "${r.id}" path "${r.path}" not found.`,
      });
    }
  }
  if (out.length === 0) {
    out.push({
      id: 'ok',
      severity: 'info',
      message: `Profile "${profile.id}" looks healthy in this workspace.`,
    });
  }
  return out;
}
