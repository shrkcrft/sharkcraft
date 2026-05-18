# dogfood-target

Realistic Bun-native TypeScript HTTP service used to dogfood SharkCraft from an
external-feeling repository. It exposes a couple of endpoints, has a real
service / utility / test layout, and ships a fully populated `sharkcraft/`
folder.

## Scenario: "Generate a UserProfile service with a test file"

From the SharkCraft monorepo root, with no environment variables set:

```bash
# 1. Inspect the target — confirm the project root is detected correctly
bun run shrk --cwd examples/dogfood-target inspect

# 2. Validate setup — should end with "Ready for AI-agent use."
bun run shrk --cwd examples/dogfood-target doctor

# 3. Retrieve only the rules that matter for this task
bun run shrk --cwd examples/dogfood-target rules relevant \
  --task "generate a user profile service"

# 4. Build the task context (token-budgeted)
bun run shrk --cwd examples/dogfood-target context \
  --task "generate a user profile service" --max-tokens 3000

# 5. Preview a generation plan (no writes)
bun run shrk --cwd examples/dogfood-target gen typescript.service user-profile \
  --var className=UserProfileService --dry-run

# 6. Preview a matching test file
bun run shrk --cwd examples/dogfood-target gen typescript.test user-profile \
  --var pascal=UserProfile --dry-run
```

If both plans are conflict-free, replace `--dry-run` with `--write` to apply.

## Scenario: drive it through MCP

```bash
SHARKCRAFT_PROJECT_ROOT="$PWD/examples/dogfood-target" \
  bun run packages/mcp-server/src/main.ts
```

The MCP server now operates against `examples/dogfood-target` even if you started
it from anywhere else. See `docs/claude-code.md` for client wiring.
