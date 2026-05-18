# Pack helpers (R33)

The engine ships profile-driven generic helpers (R32). Packs contribute
project-specific helpers via `helperFiles[]` on the manifest.

## Shape

```ts
interface IPackHelper {
  id: string;
  title: string;
  description: string;
  variables: { name; required; description; defaultValue? }[];
  operations?: IPackHelperOperationInput[];  // declarative only
  manualChecklist?: readonly string[];
  tags?: readonly string[];
  appliesWhen?: readonly string[];
  safety: {
    readOnly?: boolean;
    writesDrafts?: boolean;
    writesSource?: boolean;
    requiresProfile?: boolean;
    requiresHumanReview?: boolean;
    destructivePotential?: boolean;
    outputKind: 'preview' | 'plan' | 'checklist';
  };
}
```

## Commands

```bash
shrk helper list [--source pack|local]
shrk helper get <id>
shrk helper doctor
shrk helper plan <id> [--profile <id>] [--var k=v]
```

## MCP

- `list_helpers`, `get_helper`, `preview_helper_plan` — read-only.

## Safety

- Helpers are static data — no executable pack code.
- Operations are declarative; the engine renders them as plan-v2 ops
  (or manual checklist when `outputKind === 'checklist'`).
- MCP previews helper plans but never writes.
