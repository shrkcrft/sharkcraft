# Pack compatibility

Optional `compatibility` field on the pack manifest:

```ts
compatibility: {
  sharkcraft?: '^0.1.0',
  runtimes?: ['bun', 'node'],
  frameworks?: ['angular', 'react', 'node', 'generic'],
  packageManagers?: ['bun', 'npm', 'pnpm', 'yarn'],
}
```

```bash
shrk packs compatibility [<pkg>] [--json]
```

Output for each pack:

- `overall`: `compatible | incompatible | warning`
- `sharkcraftVersion`, `runtime`, `packageManager`, `workspaceProfiles`
- `hits[]` with per-field reasoning

Semver matching is a minimal `^X.Y.Z` / `~X.Y.Z` / exact subset — enough for
the small range of values packs typically declare.
