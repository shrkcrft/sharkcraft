# Conventions (R33)

Naming / path / barrel / layout / command / validation / ownership /
testing / release / safety conventions contributed by packs or local
`sharkcraft/conventions.ts`. The engine ships zero conventions; every
entry comes from a contribution.

## Commands

```bash
shrk conventions list [--kind <kind>] [--source local|pack]
shrk conventions get <id>
shrk conventions doctor
shrk conventions check [--files a,b,c] [--since <ref>] [--staged]
shrk conventions explain <id>
```

## Shape

```ts
interface IConvention {
  id: string;
  title: string;
  description?: string;
  kind: 'path' | 'naming' | 'barrel' | 'layout' | 'command' |
        'validation' | 'ownership' | 'testing' | 'release' | 'safety';
  appliesTo?: { languages?: ...; frameworks?: ...; fileGlobs?: ...;
                constructKinds?: ...; profileIds?: ... };
  rules: { id, description, expectMatch?, forbidMatch?, filePattern?,
           severity? }[];
  examples?: { description, good?, bad? }[];
  references?: { kind, value }[];
  severity: 'info' | 'warning' | 'error';
  tags?: string[];
}
```

## MCP

- `list_conventions`, `get_convention`, `get_conventions_doctor` —
  read-only.

## Schemas

- Convention shape: described by `IConvention` (no schema marker).
- Registry: `sharkcraft.convention-registry/v1`.
- Check report: `sharkcraft.convention-check/v1`.
