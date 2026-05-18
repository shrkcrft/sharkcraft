# Plugin lifecycle profiles (R32)

Plugin lifecycle profiles describe where a project's plugins live and what
their key-table / barrels / registry files look like. The SharkCraft
engine has zero project-specific paths; everything flows through profile
data contributed by a pack or local `sharkcraft/`.

## Profile shape

```ts
interface IPluginLifecycleProfile {
  id: string;
  title: string;
  description?: string;

  pluginRoots: readonly IPluginLifecycleRoot[];
  barrels?: readonly IPluginLifecycleBarrel[];
  keyTable?: IPluginLifecycleKeyTable;
  registryFiles?: readonly IPluginLifecycleRegistryFile[];
  naming?: IPluginLifecycleNaming;

  validationCommands?: readonly string[];
  safetyNotes?: readonly string[];
  appliesWhen?: readonly string[];
  tags?: readonly string[];
}
```

Key sub-shapes:

- `IPluginLifecycleRoot` — `{ id, path, kind?, pluginFolderSegment? }`
- `IPluginLifecycleBarrel` — `{ id, path, exportSegment?, sort? }`
- `IPluginLifecycleKeyTable` — `{ path, keyCase, valueCase, entryAnchor?, id? }`
- `IPluginLifecycleRegistryFile` — `{ id, path, kind, entryPattern? }`
- `IPluginLifecycleNaming` — `{ pluginIdCase?, classNameSuffix? }`

`keyCase` and `valueCase` accept `'upperSnake' | 'pascal' | 'camel' | 'kebab'`.

## Contributing a profile from a pack

Add a file (default-exports an `IPluginLifecycleProfile[]`):

```ts
// tools/sharkcraft-pack/src/assets/plugin-lifecycle-profile.ts
export default [{
  id: 'my-monorepo',
  title: 'Layered plugin lifecycle profile',
  pluginRoots: [
    { id: 'api', path: 'packages/app/plugins/plugin-api/src/lib/plugins' },
    { id: 'cross', path: 'packages/app/plugins/plugin-cross/src/lib/plugins' },
    { id: 'angular', path: 'packages/app/plugins/plugin-angular/src/lib/plugins' },
  ],
  barrels: [
    { id: 'api-barrel', path: 'packages/app/plugins/plugin-api/src/index.ts', exportSegment: './lib/plugins' },
    { id: 'cross-barrel', path: 'packages/app/plugins/plugin-cross/src/index.ts', exportSegment: './lib/plugins' },
    { id: 'angular-barrel', path: 'packages/app/plugins/plugin-angular/src/index.ts', exportSegment: './lib/plugins' },
  ],
  keyTable: {
    path: 'packages/app/plugins/plugin-core/src/lib/types/feature-keys.ts',
    keyCase: 'upperSnake',
    valueCase: 'camel',
  },
}];
```

Wire it in the manifest:

```ts
contributions: {
  pluginLifecycleProfileFiles: ['./src/assets/plugin-lifecycle-profile.ts'],
},
```

Re-sign with `shrk packs sign <manifest>` when ready.

## CLI

```bash
shrk plugin lifecycle profiles                  # list registered profiles
shrk plugin lifecycle profile <id>              # show one
shrk plugin lifecycle doctor [--profile <id>]   # surface load issues + health
shrk plugin lifecycle list   --profile <id>     # detected plugins
shrk plugin lifecycle inspect <name> --profile <id>
shrk plugin rename <old> <new> --profile <id> [--dry-run] [--output <plan.json>]
shrk plugin remove <name>     --profile <id> [--dry-run] [--output <plan.json>]
```

If exactly one profile is registered, `--profile` is implicit. With more
than one, the CLI prints the available ids and exits.

## MCP (read-only)

- `list_plugin_lifecycle_profiles`
- `get_plugin_lifecycle_profile`
- `get_plugin_lifecycle_profile_doctor`
- `list_profiles` / `get_profile` / `get_profiles_doctor` — generic
  surface, includes lifecycle profiles + migration profiles.
- `preview_plugin_rename` / `preview_plugin_remove` — both accept an
  optional `profile` input and resolve via the registry.

## Schemas

- Profile: described by `IPluginLifecycleProfile` (no schema marker).
- Plan: `sharkcraft.plugin-lifecycle/v1`.
- Registry: `sharkcraft.plugin-lifecycle-profile-registry/v1`.
