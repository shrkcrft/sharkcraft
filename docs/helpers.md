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

Two distinct helper families, each with its own tools — read-only, both of them:

| Family | Source | Tools |
|---|---|---|
| Helper registry (R32) | the engine's built-in `HELPERS` | `list_helpers`, `get_helper`, `preview_helper_plan` |
| Pack/local helpers (R33) | `helperFiles[]` on a pack manifest | `list_pack_helpers`, `get_pack_helper` |

The pack-side pair carries the `pack` prefix because both families previously
registered under `list_helpers` / `get_helper`. The MCP dispatch table is
last-wins, so a collision does not error — it makes one tool unreachable while
`tools/list` advertises the name twice. `ALL_TOOLS` name uniqueness is now
asserted mechanically (see
`packages/mcp-server/src/__tests__/r66-tool-name-uniqueness.test.ts`).

## Safety

- Helpers are static data — no executable pack code.
- Operations are declarative; the engine renders them as plan-v2 ops
  (or manual checklist when `outputKind === 'checklist'`).
- MCP previews helper plans but never writes.
