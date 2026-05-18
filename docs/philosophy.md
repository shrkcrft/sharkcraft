# Philosophy

## Structured knowledge over doc dumping

Most "AI-friendly" repos store conventions in long markdown documents. Agents read all of it to find the one fact they need. SharkCraft inverts this:

- Conventions, rules, paths, templates are **typed entries** with tags, scope, priority, and `appliesWhen`.
- The retrieval layer asks: *which entries match this task?* and returns only those.
- Markdown remains useful for narrative depth, but it is not the source of truth.

## Retrieval-first

Every CLI flag and every MCP tool is built around retrieval, not enumeration. `get_relevant_context`, `get_relevant_rules`, `find_best_path` — all return a short, ordered list with reasons.

## Bun-native

- Bun runtime, Bun workspaces, Bun lockfile.
- The CLI binary runs with Bun.
- The MCP server runs with Bun.
- Node APIs are wrapped behind `IFileSystem` so they can be swapped later.

## Plan-first generation

Code generation defaults to **dry-run**. The plan lists every file, its target path, conflict status, and contents. A write requires `--write` and a clean plan. AI agents must call `create_generation_plan` before any write.

## Deterministic output

Same input → same retrieval order. Scoring is documented and reproducible. No hidden state, no language-model "vibes" inside SharkCraft itself.
