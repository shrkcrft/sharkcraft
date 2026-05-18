/**
 * Plugin lifecycle profile (generic).
 *
 * A pack can contribute one or more lifecycle profiles describing where its
 * plugins live, what their barrels and key-tables look like, and which
 * registry files participate. The engine reads these profiles and plans
 * plugin rename / remove operations against them.
 *
 * The engine never embeds project-specific plugin layouts; all of that comes
 * from a profile. Pack contributions are static data — no executable code.
 */

export enum PluginLifecycleRootKind {
  Api = 'api',
  Cross = 'cross',
  Ui = 'ui',
  Angular = 'angular',
  React = 'react',
  Node = 'node',
  Runtime = 'runtime',
  Other = 'other',
}

export interface IPluginLifecycleRoot {
  readonly id: string;
  readonly path: string;
  readonly kind?: PluginLifecycleRootKind;
  readonly pluginFolderSegment?: string;
}

export enum BarrelSort {
  Alphabetical = 'alphabetical',
  Preserve = 'preserve',
  Append = 'append',
}

export interface IPluginLifecycleBarrel {
  readonly id: string;
  readonly path: string;
  readonly exportSegment?: string;
  readonly sort?: BarrelSort;
}

export enum CaseStyle {
  UpperSnake = 'upperSnake',
  Pascal = 'pascal',
  Camel = 'camel',
  Kebab = 'kebab',
}

export interface IPluginLifecycleKeyTable {
  readonly path: string;
  readonly keyCase: CaseStyle;
  readonly valueCase: CaseStyle;
  readonly entryAnchor?: string;
  readonly id?: string;
}

export enum PluginRegistryFileKind {
  PluginKey = 'plugin-key',
  UserPluginEntry = 'user-plugin-entry',
  Defaults = 'defaults',
  Event = 'event',
  Command = 'command',
  Composer = 'composer',
  Other = 'other',
}

export interface IPluginLifecycleRegistryFile {
  readonly id: string;
  readonly path: string;
  readonly kind: PluginRegistryFileKind;
  readonly entryPattern?: string;
}

export interface IPluginLifecycleNaming {
  readonly pluginIdCase?: CaseStyle;
  readonly classNameSuffix?: string;
}

export interface IPluginLifecycleProfile {
  readonly id: string;
  readonly title: string;
  readonly description?: string;

  readonly pluginRoots: readonly IPluginLifecycleRoot[];
  readonly barrels?: readonly IPluginLifecycleBarrel[];
  readonly keyTable?: IPluginLifecycleKeyTable;
  readonly registryFiles?: readonly IPluginLifecycleRegistryFile[];
  readonly naming?: IPluginLifecycleNaming;

  readonly validationCommands?: readonly string[];
  readonly safetyNotes?: readonly string[];
  readonly appliesWhen?: readonly string[];
  readonly tags?: readonly string[];
}

export interface IPluginLifecycleProfileValidationIssue {
  readonly field: string;
  readonly message: string;
}

export interface IPluginLifecycleProfileValidationResult {
  readonly valid: boolean;
  readonly issues: readonly IPluginLifecycleProfileValidationIssue[];
}

/**
 * Validate a plugin lifecycle profile shape. Lightweight runtime check; no
 * dependency on zod (plugin-api stays dependency-light, like pack-manifest).
 */
export function validatePluginLifecycleProfile(
  value: unknown,
): IPluginLifecycleProfileValidationResult {
  const issues: IPluginLifecycleProfileValidationIssue[] = [];
  if (!value || typeof value !== 'object') {
    return { valid: false, issues: [{ field: '<root>', message: 'profile must be an object' }] };
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.id !== 'string' || obj.id.length === 0) {
    issues.push({ field: 'id', message: 'id must be a non-empty string' });
  }
  if (typeof obj.title !== 'string' || obj.title.length === 0) {
    issues.push({ field: 'title', message: 'title must be a non-empty string' });
  }
  if (!Array.isArray(obj.pluginRoots) || obj.pluginRoots.length === 0) {
    issues.push({ field: 'pluginRoots', message: 'pluginRoots must be a non-empty array' });
  } else {
    obj.pluginRoots.forEach((root, idx) => {
      if (!root || typeof root !== 'object') {
        issues.push({ field: `pluginRoots[${idx}]`, message: 'root must be an object' });
        return;
      }
      const r = root as Record<string, unknown>;
      if (typeof r.id !== 'string' || r.id.length === 0) {
        issues.push({ field: `pluginRoots[${idx}].id`, message: 'id required' });
      }
      if (typeof r.path !== 'string' || r.path.length === 0) {
        issues.push({ field: `pluginRoots[${idx}].path`, message: 'path required' });
      }
    });
  }
  if (obj.barrels !== undefined) {
    if (!Array.isArray(obj.barrels)) {
      issues.push({ field: 'barrels', message: 'barrels must be an array' });
    } else {
      obj.barrels.forEach((b, idx) => {
        if (!b || typeof b !== 'object') {
          issues.push({ field: `barrels[${idx}]`, message: 'barrel must be an object' });
          return;
        }
        const br = b as Record<string, unknown>;
        if (typeof br.id !== 'string' || br.id.length === 0) {
          issues.push({ field: `barrels[${idx}].id`, message: 'id required' });
        }
        if (typeof br.path !== 'string' || br.path.length === 0) {
          issues.push({ field: `barrels[${idx}].path`, message: 'path required' });
        }
      });
    }
  }
  if (obj.keyTable !== undefined && obj.keyTable !== null) {
    const k = obj.keyTable as Record<string, unknown>;
    if (typeof k !== 'object') {
      issues.push({ field: 'keyTable', message: 'keyTable must be an object' });
    } else {
      if (typeof k.path !== 'string' || k.path.length === 0) {
        issues.push({ field: 'keyTable.path', message: 'path required' });
      }
      const validCase = new Set(['upperSnake', 'pascal', 'camel', 'kebab']);
      if (typeof k.keyCase !== 'string' || !validCase.has(k.keyCase as string)) {
        issues.push({ field: 'keyTable.keyCase', message: 'keyCase must be one of upperSnake|pascal|camel|kebab' });
      }
      if (typeof k.valueCase !== 'string' || !validCase.has(k.valueCase as string)) {
        issues.push({ field: 'keyTable.valueCase', message: 'valueCase must be one of upperSnake|pascal|camel|kebab' });
      }
    }
  }
  return { valid: issues.length === 0, issues };
}
