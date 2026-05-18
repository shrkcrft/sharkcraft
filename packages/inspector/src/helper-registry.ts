/**
 * Helper plan generators (profile-driven for project-specific paths).
 *
 * Helpers are one-shot plan-v2 producers for small, well-bounded edits.
 * They are dry-run by default and idempotent where the plan engine supports it.
 *
 * No helper writes source directly. The output is a structured `IHelperPlan`
 * containing planned ops (using the existing plan-v2 operation set) and a
 * list of advisory conflicts when an expected anchor cannot be resolved.
 *
 * Helpers must accept an IPluginLifecycleProfile instead of hardcoded paths,
 * so the engine knows where the key-table / plugin roots live.
 * Project-specific helpers contributed by packs travel in pack-contributed
 * playbooks/scaffolds; the engine just provides the generic shapes.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CaseStyle,
  type IPluginLifecycleProfile,
} from '@shrkcrft/plugin-api';

export enum HelperId {
  AddPluginKey = 'core.add-plugin-key',
  RemovePluginKey = 'core.remove-plugin-key',
  RenamePluginKey = 'core.rename-plugin-key',
  AddBarrelExport = 'core.add-barrel-export',
  RemoveBarrelExport = 'core.remove-barrel-export',
  AddEventEntry = 'core.add-event-entry',
  RemoveEventEntry = 'core.remove-event-entry',
  AddDefaultRegistration = 'core.add-default-registration',
  RemoveDefaultRegistration = 'core.remove-default-registration',
  AddComposerEntry = 'core.add-composer-entry',
  RemoveComposerEntry = 'core.remove-composer-entry',
  RenamePluginFolder = 'core.rename-plugin-folder',
  RemoveUserPluginEntry = 'core.remove-user-plugin-entry',
}

export interface IHelperDefinition {
  id: HelperId;
  description: string;
  destructive: boolean;
  requiresHumanReview: boolean;
  requiresProfile?: boolean;
  variables: ReadonlyArray<{ name: string; required: boolean; description: string }>;
}

export const HELPERS: ReadonlyArray<IHelperDefinition> = Object.freeze([
  {
    id: HelperId.AddPluginKey,
    description:
      'Insert a plugin key-table entry just before the closing `} as const;` brace (profile-driven).',
    destructive: false,
    requiresHumanReview: false,
    requiresProfile: true,
    variables: [
      { name: 'key', required: true, description: 'kebab-case plugin key (e.g. user-card).' },
    ],
  },
  {
    id: HelperId.RemovePluginKey,
    description: 'Remove a plugin key-table entry (profile-driven). Destructive.',
    destructive: true,
    requiresHumanReview: true,
    requiresProfile: true,
    variables: [{ name: 'key', required: true, description: 'kebab-case plugin key.' }],
  },
  {
    id: HelperId.RenamePluginKey,
    description: 'Rename a plugin key-table entry (profile-driven). Destructive.',
    destructive: true,
    requiresHumanReview: true,
    requiresProfile: true,
    variables: [
      { name: 'old', required: true, description: 'old kebab-case key.' },
      { name: 'new', required: true, description: 'new kebab-case key.' },
    ],
  },
  {
    id: HelperId.AddBarrelExport,
    description: 'Append an `export * from <module>` to a barrel.',
    destructive: false,
    requiresHumanReview: false,
    variables: [
      { name: 'barrel', required: true, description: 'project-relative path to the barrel file.' },
      { name: 'from', required: true, description: 'relative module path to re-export.' },
    ],
  },
  {
    id: HelperId.RemoveBarrelExport,
    description: 'Remove a barrel `export * from` line. Destructive.',
    destructive: true,
    requiresHumanReview: true,
    variables: [
      { name: 'barrel', required: true, description: 'project-relative path to the barrel file.' },
      { name: 'from', required: true, description: 'relative module path to remove.' },
    ],
  },
  {
    id: HelperId.AddEventEntry,
    description:
      'Append a typed event entry to a plugin events file (requires `eventsPath` var when no profile root is suitable).',
    destructive: false,
    requiresHumanReview: false,
    variables: [
      { name: 'plugin', required: true, description: 'host plugin kebab-case.' },
      { name: 'event', required: true, description: 'PascalCase event name.' },
      {
        name: 'eventsPath',
        required: false,
        description:
          'Override target path. Otherwise derived from the first profile pluginRoot + plugin + /events.ts.',
      },
    ],
  },
  {
    id: HelperId.RemoveEventEntry,
    description: 'Remove a typed event block from a plugin events file. Destructive.',
    destructive: true,
    requiresHumanReview: true,
    variables: [
      { name: 'plugin', required: true, description: 'host plugin kebab-case.' },
      { name: 'event', required: true, description: 'PascalCase event name.' },
      {
        name: 'eventsPath',
        required: false,
        description:
          'Override target path. Otherwise derived from the first profile pluginRoot + plugin + /events.ts.',
      },
    ],
  },
  {
    id: HelperId.AddDefaultRegistration,
    description: 'Register default config/state providers (manual checklist; locations vary).',
    destructive: false,
    requiresHumanReview: true,
    variables: [
      { name: 'name', required: true, description: 'plugin kebab-case.' },
      { name: 'pascal', required: true, description: 'plugin PascalCase.' },
    ],
  },
  {
    id: HelperId.RemoveDefaultRegistration,
    description: 'Remove default config/state provider registration (manual checklist). Destructive.',
    destructive: true,
    requiresHumanReview: true,
    variables: [{ name: 'pascal', required: true, description: 'plugin PascalCase.' }],
  },
  {
    id: HelperId.AddComposerEntry,
    description: 'Append a composer entry (manual checklist — composer locations vary).',
    destructive: false,
    requiresHumanReview: true,
    variables: [{ name: 'plugin', required: true, description: 'plugin kebab-case.' }],
  },
  {
    id: HelperId.RemoveComposerEntry,
    description: 'Remove a composer entry (manual checklist).',
    destructive: true,
    requiresHumanReview: true,
    variables: [{ name: 'plugin', required: true, description: 'plugin kebab-case.' }],
  },
  {
    id: HelperId.RenamePluginFolder,
    description: 'Manual checklist: rename a plugin folder across the profile roots.',
    destructive: true,
    requiresHumanReview: true,
    requiresProfile: true,
    variables: [
      { name: 'old', required: true, description: 'old plugin kebab-case.' },
      { name: 'new', required: true, description: 'new plugin kebab-case.' },
    ],
  },
  {
    id: HelperId.RemoveUserPluginEntry,
    description: 'Remove a plugin entry from user-facing key-by-scope tables (heuristic).',
    destructive: true,
    requiresHumanReview: true,
    variables: [{ name: 'key', required: true, description: 'plugin kebab-case.' }],
  },
]);

export interface IHelperPlanOp {
  targetPath: string;
  operation: Record<string, unknown>;
}

export interface IHelperPlan {
  schema: 'sharkcraft.helper-plan/v1';
  helperId: HelperId;
  variables: Record<string, string>;
  ops: ReadonlyArray<IHelperPlanOp>;
  manualSteps: ReadonlyArray<string>;
  conflicts: ReadonlyArray<string>;
  destructive: boolean;
  humanReviewRequired: boolean;
}

/**
 * Convert a helper plan into a saved plan (synthetic templateId) so
 * it flows through `shrk apply`. Helper ops are persisted as v2 operation
 * intents; the apply path evaluates them against the live file system.
 * Unsigned by default; call `signPlan` separately when desired.
 */
export const HELPER_SYNTHETIC_TEMPLATE = '__helper__';

export function helperPlanToSavedPlan(
  plan: IHelperPlan,
  projectRoot: string,
): {
  schema: 'sharkcraft.plan/v2';
  templateId: string;
  variables: Record<string, string>;
  projectRoot: string;
  createdAt: string;
  expectedChanges: {
    type: string;
    relativePath: string;
    sizeBytes: number;
    operation: Record<string, unknown>;
  }[];
  note?: string;
} {
  // Map each helper op to a saved expectedChange. The sizeBytes is the
  // best-effort post-apply size (zero for inserts whose snippet is empty)
  // — the live evaluator recomputes the actual size at apply time.
  const expectedChanges = plan.ops.map((op) => {
    const kind = typeof op.operation['kind'] === 'string' ? (op.operation['kind'] as string) : 'append';
    let sizeBytes = 0;
    if (typeof op.operation['snippet'] === 'string') {
      sizeBytes = Buffer.byteLength(op.operation['snippet'] as string, 'utf8');
    } else if (typeof op.operation['replaceWith'] === 'string') {
      sizeBytes = Buffer.byteLength(op.operation['replaceWith'] as string, 'utf8');
    } else if (typeof op.operation['content'] === 'string') {
      sizeBytes = Buffer.byteLength(op.operation['content'] as string, 'utf8');
    }
    return {
      type: kind,
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
    note?: string;
  } = {
    schema: 'sharkcraft.plan/v2',
    templateId: HELPER_SYNTHETIC_TEMPLATE,
    variables: {
      helperId: plan.helperId,
      ...plan.variables,
    },
    projectRoot,
    createdAt: new Date().toISOString(),
    expectedChanges,
  };
  if (plan.manualSteps.length > 0) {
    out.note = `Manual steps required: ${plan.manualSteps.join('; ')}`;
  }
  return out;
}

function readFileSafe(p: string): string | null {
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function splitWords(input: string): string[] {
  if (!input) return [];
  if (input.includes('-') || input.includes('_')) return input.split(/[-_]/).filter(Boolean);
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
    case CaseStyle.Camel:
      return words
        .map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
        .join('');
    default:
      return input;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface IHelperBuildInput {
  helperId: HelperId;
  projectRoot: string;
  vars: Record<string, string>;
  /** Required for helpers marked requiresProfile in HELPERS. */
  profile?: IPluginLifecycleProfile;
}

function requireProfile(helperId: HelperId, profile?: IPluginLifecycleProfile): IPluginLifecycleProfile {
  if (!profile) {
    throw new Error(
      `Helper ${helperId} requires a lifecycle profile. Pass the profile loaded from sharkcraft/plugin-lifecycle-profiles or a pack.`,
    );
  }
  return profile;
}

export function buildHelperPlan(input: IHelperBuildInput): IHelperPlan {
  const def = HELPERS.find((h) => h.id === input.helperId);
  if (!def) {
    throw new Error(`Unknown helper id: ${input.helperId}`);
  }
  for (const v of def.variables) {
    if (v.required && !input.vars[v.name]) {
      throw new Error(`Helper ${def.id} requires variable "${v.name}".`);
    }
  }
  const ops: IHelperPlanOp[] = [];
  const manual: string[] = [];
  const conflicts: string[] = [];

  switch (input.helperId) {
    case HelperId.AddPluginKey: {
      const profile = requireProfile(input.helperId, input.profile);
      if (!profile.keyTable) {
        conflicts.push(`Profile "${profile.id}" has no keyTable; cannot add a plugin key entry.`);
        break;
      }
      const keyTablePath = profile.keyTable.path;
      const keyName = input.vars.key!;
      const key = toCase(keyName, profile.keyTable.keyCase);
      const value = toCase(keyName, profile.keyTable.valueCase);
      ops.push({
        targetPath: keyTablePath,
        operation: {
          kind: 'insert-before',
          anchor: '} as const;',
          snippet: `  ${key}: '${value}',\n`,
          ifMissing: `${key}:`,
          description: `Register key-table entry ${key} = '${value}'.`,
        },
      });
      break;
    }
    case HelperId.RemovePluginKey: {
      const profile = requireProfile(input.helperId, input.profile);
      if (!profile.keyTable) {
        conflicts.push(`Profile "${profile.id}" has no keyTable; nothing to remove.`);
        break;
      }
      const keyTablePath = profile.keyTable.path;
      const keyName = input.vars.key!;
      const key = toCase(keyName, profile.keyTable.keyCase);
      const value = toCase(keyName, profile.keyTable.valueCase);
      const file = join(input.projectRoot, keyTablePath);
      const content = readFileSafe(file);
      const re = new RegExp(`\\s*${escapeRegex(key)}:\\s*['"]${escapeRegex(value)}['"],?\\n`);
      const m = content?.match(re);
      if (m) {
        ops.push({
          targetPath: keyTablePath,
          operation: {
            kind: 'replace',
            find: m[0],
            replaceWith: '',
            description: `Remove key-table entry ${key}.`,
          },
        });
      } else {
        conflicts.push(`Key-table entry ${key} not found in ${keyTablePath}.`);
      }
      break;
    }
    case HelperId.RenamePluginKey: {
      const profile = requireProfile(input.helperId, input.profile);
      if (!profile.keyTable) {
        conflicts.push(`Profile "${profile.id}" has no keyTable; nothing to rename.`);
        break;
      }
      const keyTablePath = profile.keyTable.path;
      const oldName = input.vars.old!;
      const newName = input.vars.new!;
      const oldKey = toCase(oldName, profile.keyTable.keyCase);
      const newKey = toCase(newName, profile.keyTable.keyCase);
      const oldValue = toCase(oldName, profile.keyTable.valueCase);
      const newValue = toCase(newName, profile.keyTable.valueCase);
      const file = join(input.projectRoot, keyTablePath);
      const content = readFileSafe(file);
      const re = new RegExp(`(\\s*)${escapeRegex(oldKey)}:\\s*['"]${escapeRegex(oldValue)}['"](,?\\n)`);
      const m = content?.match(re);
      if (m) {
        ops.push({
          targetPath: keyTablePath,
          operation: {
            kind: 'replace',
            find: m[0],
            replaceWith: `${m[1]}${newKey}: '${newValue}'${m[2]}`,
            description: `Rename key-table entry ${oldKey} → ${newKey}.`,
          },
        });
      } else {
        conflicts.push(`Key-table entry ${oldKey} not found.`);
      }
      break;
    }
    case HelperId.AddBarrelExport: {
      const barrel = input.vars.barrel!;
      const from = input.vars.from!;
      ops.push({
        targetPath: barrel,
        operation: {
          kind: 'export',
          from,
          description: `Append export * from '${from}' to ${barrel}.`,
        },
      });
      break;
    }
    case HelperId.RemoveBarrelExport: {
      const barrel = input.vars.barrel!;
      const from = input.vars.from!;
      const content = readFileSafe(join(input.projectRoot, barrel));
      const lines = (content ?? '').split('\n');
      const match = lines.find((l) => l.includes(`'${from}'`) || l.includes(`"${from}"`));
      if (match) {
        ops.push({
          targetPath: barrel,
          operation: {
            kind: 'replace',
            find: match + '\n',
            replaceWith: '',
            description: `Remove export * from '${from}' from ${barrel}.`,
          },
        });
      } else {
        conflicts.push(`No export referencing '${from}' in ${barrel}.`);
      }
      break;
    }
    case HelperId.AddEventEntry: {
      const plugin = input.vars.plugin!;
      const eventPascal = input.vars.event!;
      const upper = toCase(eventPascal, CaseStyle.UpperSnake);
      let eventsPath = input.vars.eventsPath;
      if (!eventsPath) {
        const profile = requireProfile(input.helperId, input.profile);
        const root = profile.pluginRoots[0];
        if (!root) {
          conflicts.push(`Profile "${profile.id}" has no pluginRoots; cannot derive eventsPath.`);
          break;
        }
        eventsPath = `${root.path}/${plugin}/events.ts`;
      }
      const beginMarker = `// ─── ${eventPascal} event (helper) ───`;
      const snippet =
        `\n${beginMarker}\n` +
        `export interface ${eventPascal}Payload {}\n` +
        `// ${eventPascal} event entry; wire EventType.${upper} manually.\n` +
        `// ─── end ${eventPascal} event ───\n`;
      ops.push({
        targetPath: eventsPath,
        operation: {
          kind: 'append',
          snippet,
          ifMissing: beginMarker,
          description: `Append ${eventPascal} event block to ${eventsPath}.`,
        },
      });
      manual.push(
        `Add the EventType.${upper} = '${plugin}.${toCase(eventPascal, CaseStyle.Camel)}' enum entry inside the host's EventType enum.`,
      );
      break;
    }
    case HelperId.RemoveEventEntry: {
      const plugin = input.vars.plugin!;
      const eventPascal = input.vars.event!;
      let eventsPath = input.vars.eventsPath;
      if (!eventsPath) {
        const profile = requireProfile(input.helperId, input.profile);
        const root = profile.pluginRoots[0];
        if (!root) {
          conflicts.push(`Profile "${profile.id}" has no pluginRoots; cannot derive eventsPath.`);
          break;
        }
        eventsPath = `${root.path}/${plugin}/events.ts`;
      }
      const file = join(input.projectRoot, eventsPath);
      const content = readFileSafe(file);
      const beginMarker = `// ─── ${eventPascal} event`;
      const endMarker = `// ─── end ${eventPascal} event ───`;
      if (content && content.includes(beginMarker) && content.includes(endMarker)) {
        const start = content.indexOf(beginMarker);
        const end = content.indexOf(endMarker) + endMarker.length + 1;
        const block = content.slice(start, end);
        ops.push({
          targetPath: eventsPath,
          operation: {
            kind: 'replace',
            find: block,
            replaceWith: '',
            description: `Remove ${eventPascal} event block from ${eventsPath}.`,
          },
        });
      } else {
        conflicts.push(`Event block ${eventPascal} not found in ${eventsPath}.`);
      }
      break;
    }
    case HelperId.AddDefaultRegistration: {
      const pascal = input.vars.pascal!;
      manual.push(
        `Register ${pascal} default providers in the runtime composition layer (composer location varies — review manually).`,
      );
      break;
    }
    case HelperId.RemoveDefaultRegistration: {
      const pascal = input.vars.pascal!;
      manual.push(
        `Remove ${pascal} default providers from the runtime composition layer (composer location varies — review manually).`,
      );
      break;
    }
    case HelperId.AddComposerEntry: {
      const plugin = input.vars.plugin!;
      manual.push(
        `Append ${plugin} entry to the appropriate composer. Composer locations vary — review manually.`,
      );
      break;
    }
    case HelperId.RemoveComposerEntry: {
      const plugin = input.vars.plugin!;
      manual.push(
        `Remove ${plugin} entry from the appropriate composer. Composer locations vary — review manually.`,
      );
      break;
    }
    case HelperId.RenamePluginFolder: {
      const oldName = input.vars.old!;
      const newName = input.vars.new!;
      const profile = requireProfile(input.helperId, input.profile);
      for (const root of profile.pluginRoots) {
        manual.push(`git mv ${root.path}/${oldName} ${root.path}/${newName}`);
      }
      break;
    }
    case HelperId.RemoveUserPluginEntry: {
      const key = input.vars.key!;
      manual.push(
        `Search for "${key}" in user-facing key-by-scope tables and remove the corresponding entry. Heuristic — review manually.`,
      );
      break;
    }
  }

  return {
    schema: 'sharkcraft.helper-plan/v1',
    helperId: input.helperId,
    variables: { ...input.vars },
    ops,
    manualSteps: manual,
    conflicts,
    destructive: def.destructive,
    humanReviewRequired: def.requiresHumanReview,
  };
}

export function renderHelperPlanText(plan: IHelperPlan): string {
  const lines: string[] = [];
  lines.push(`=== Helper plan: ${plan.helperId} ===`);
  lines.push(`  destructive   ${plan.destructive ? 'YES' : 'no'}`);
  lines.push(`  review        ${plan.humanReviewRequired ? 'human review required' : 'auto'}`);
  lines.push('');
  lines.push(`Operations (${plan.ops.length}):`);
  for (const op of plan.ops) {
    const o = op.operation as { kind?: string; description?: string };
    lines.push(`  • ${op.targetPath} [${o.kind ?? '?'}]`);
    if (o.description) lines.push(`      ${o.description}`);
  }
  if (plan.manualSteps.length > 0) {
    lines.push('');
    lines.push(`Manual steps:`);
    for (const m of plan.manualSteps) lines.push(`  • ${m}`);
  }
  if (plan.conflicts.length > 0) {
    lines.push('');
    lines.push(`Conflicts:`);
    for (const c of plan.conflicts) lines.push(`  • ${c}`);
  }
  return lines.join('\n') + '\n';
}
