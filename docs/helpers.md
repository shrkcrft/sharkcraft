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

## One catalog (round 11)

Every helper surface reads ONE catalog — `listAllHelpers(inspection)` in
`@shrkcrft/inspector`: the engine's built-in `HELPERS` ∪ local
`sharkcraft/helpers.ts` ∪ every pack's `helperFiles[]`, deduped by id
(built-ins first). `helper list|get|plan|doctor`, the MCP helper tools, and
the id resolver (`referenceIdsFor(inspection, 'helper')`) all read it, so
"which helpers exist" has one answer. (Before round 11 `helper list|get|plan`
read only the built-in set — which ships empty — while the resolver read the
pack loader: the self-config doctor saw a helper that `helper get` called
unknown.)

## Commands

```bash
shrk helper list [--source builtin|local|pack] [--json]
shrk helper get <id> [--json]
shrk helper plan <id> [--var k=v] [--output <plan.json>] [--json]
shrk helper doctor [--allow-empty] [--json]
```

- `helper list` prints a SOURCE column (`builtin`, `local`, `pack <name>`).
  An invalid `--source` value is a usage error (exit 3).
- `helper get` prints the source file, safety flags, variables, declarative
  operations and the manual checklist.
- `helper plan` renders a pack/local helper's declarative operations
  (`append-line` → append, `insert-before` → insert-before, `replace-line` →
  replace, `remove-line` → replace with an empty snippet, `manual-checklist` →
  manual steps), substituting `{{var}}` placeholders (declared defaults apply
  first). A missing required variable is refused (exit 1) — never a plan with
  blank snippets. `--save-plan` is **refused (exit 2)** for pack/local helpers:
  a declarative helper plan cannot yet be converted into a saved plan
  `shrk apply` reads; use `--output` for the preview JSON.
- `helper doctor` validates every helper FILE: load failures, invalid helpers,
  duplicate ids (errors → exit 1) and unknown operation keys (warnings). With
  no helper file at all it examined nothing → exit 2; `--allow-empty` accepts
  that explicitly.

`validatePackHelper` checks every `operations[i]` against a closed allow-list
(`PACK_HELPER_OPERATION_FIELDS`): an unknown kind or a missing required field
(`append-line{targetPath, snippet}`, `insert-before{targetPath, anchor,
snippet}`, `replace-line{targetPath, find, replaceWith}`,
`remove-line{targetPath, find}`, `manual-checklist{checklist}`) is an error;
an unknown key is a warning (the engine would drop it).

## MCP

| Tools | Read |
|---|---|
| `list_helpers`, `get_helper`, `preview_helper_plan` | the ONE catalog (built-in ∪ local ∪ pack); `preview_helper_plan` renders a pack helper's declarative operations |
| `list_pack_helpers`, `get_pack_helper` | the pack/local loader entries (raw `IPackHelper` records) |

The pack-side pair carries the `pack` prefix because both families previously
registered under `list_helpers` / `get_helper`. The MCP dispatch table is
last-wins, so a collision does not error — it makes one tool unreachable while
`tools/list` advertises the name twice. `ALL_TOOLS` name uniqueness is now
asserted mechanically (see
`packages/mcp-server/src/__tests__/r66-tool-name-uniqueness.test.ts`).

## Rejected helpers (round 12)

A helper `validatePackHelper` errors on (a missing `safety`, …) or a reused id
is a REJECTED entry: `shrk helper list` ends with `⚠ 1 entry rejected from
<file>: 'h.bad' (default[1]) — safety: safety required → shrk helper doctor`
(its old `N helper file error(s)` line now counts only helper FILES that failed
to load or are missing), and `shrk self-config doctor` reports `helper-invalid`
(error). `--json` keeps its array and writes the note to stderr.

## Safety

- Helpers are static data — no executable pack code.
- Operations are declarative; the engine renders them as plan-v2 ops
  (or manual checklist when `outputKind === 'checklist'`).
- MCP previews helper plans but never writes.
