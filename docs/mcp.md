# SharkCraft MCP server

The SharkCraft MCP server exposes structured project intelligence to any
MCP-capable AI agent (Claude Code, etc.). It is built on
`@modelcontextprotocol/sdk` and speaks both **stdio** and **Streamable HTTP**.

> **Important:** The MCP server is read-only. It returns data and plans. It
> **never** writes files. Writes happen through the `shrk` CLI by the
> human, who reviews each plan.

## Start it

```bash
# Stdio (Claude Code, etc.)
bun run mcp                                            # uses $PWD
SHARKCRAFT_PROJECT_ROOT=/path/to/repo bun run mcp      # explicit target
bun run shrk -- --cwd /path/to/repo mcp serve --watch  # with hot reload

# Streamable HTTP
bun run shrk -- --cwd /path/to/repo mcp serve --http --port 4000
curl http://localhost:4000/healthz
```

See [`docs/claude-code.md`](claude-code.md) for a copy-paste Claude Code config.

## Tools

Tools are grouped by surface. Each lists its name, one-line intent, and key
inputs. All inputs are zod-validated at the boundary. The exact count is
maintained in `packages/mcp-server/src/tools/index.ts` (`ALL_TOOLS`).

### Project overview / inspection

| Tool | Intent | Inputs |
|---|---|---|
| `get_project_overview` | Compact project overview (name, package manager, frameworks, top-level dirs). | _none_ |
| `inspect_workspace` | Structured workspace info: package manager, frameworks, scripts, top-level dirs, sharkcraft folder presence. | _none_ |
| `inspect_sharkcraft_setup` | Validate the SharkCraft setup (config, knowledge, templates) and surface issues. | _none_ |
| `get_ai_readiness_report` | Deterministic 0..100 readiness score with per-dimension breakdown + recommendations. | _none_ |

### Knowledge

| Tool | Intent | Inputs |
|---|---|---|
| `list_knowledge` | List knowledge entries (id, title, type, tags, scope, priority, appliesWhen). Filterable. | `types?`, `scope?`, `tags?`, `appliesWhen?`, `framework?`, `area?` |
| `get_knowledge` | One entry by id (full content). | `id` |
| `search_knowledge` | Search by query/tags/types/scope/appliesWhen. | `query?`, `types?`, `tags?`, `scope?`, `appliesWhen?`, `limit?` |
| `get_relevant_context` | Token-budgeted, AI-ready context for a task. Only relevant rules/paths/templates/etc. | `task`, `maxTokens?`, `framework?`, `area?`, `scope?` |

### Rules

| Tool | Intent | Inputs |
|---|---|---|
| `list_rules` | List all rules with compact metadata. | _none_ |
| `get_rule` | One rule by id (full content). | `id` |
| `get_relevant_rules` | Rules relevant to the current task. Optionally include scope/tags/appliesWhen. | `task`, `scope?`, `tags?`, `limit?` |

### Paths

| Tool | Intent | Inputs |
|---|---|---|
| `list_path_conventions` | List known path conventions. | _none_ |
| `get_path_convention` | One path convention by id. | `id` |
| `search_path_conventions` | Search path conventions by query/scope/tags. | `query?`, `scope?`, `tags?`, `limit?` |

### Templates

| Tool | Intent | Inputs |
|---|---|---|
| `list_templates` | List available generator templates. | _none_ |
| `get_template` | One template by id (variables + notes). | `id` |
| `search_templates` | Search templates by free-text query. | `query`, `limit?` |
| `render_template_preview` | Render a template preview (without writing). Returns target paths + contents. | `templateId`, `name?`, `variables?` |
| `explain_generation_target` | Explain where a generated file would go and why (template + closest path convention). | `templateId`, `name?`, `variables?` |
| `create_generation_plan` | Build a generation plan (dry-run). **Never writes.** Use to preview before applying. | `templateId`, `name?`, `variables?` |

### Agent helpers

| Tool | Intent | Inputs |
|---|---|---|
| `get_agent_instructions` | Compact instructions for AI agents on using this repo through SharkCraft. | _none_ |
| `get_repository_commands` | Known package scripts (from package.json) + documented commands (knowledge of type "command"). | _none_ |
| `get_current_tasks` | Current tasks/roadmap entries (type "task" or `tasks/*.md`-sourced). | _none_ |
| `get_architecture_constraints` | Architecture-related entries (type "architecture" or "decision"). | _none_ |
| `get_testing_guidelines` | Testing-related rules and conventions. | _none_ |
| `get_security_guidelines` | Security-related rules and warnings. | _none_ |
| `get_action_hints` | Aggregate per-task: CLI commands, MCP tools, preferred flow, forbidden actions, verification commands, related templates/paths, human-review markers. | `task` or `entryIds` |

### Pipelines

| Tool | Intent | Inputs |
|---|---|---|
| `list_pipelines` | List available declarative agent workflows. | _none_ |
| `get_pipeline` | One pipeline by id (all steps + inputs + notes). | `id` |
| `get_pipeline_context` | Pipeline + token-budgeted context for the task. Use after choosing a pipeline. | `id`, `task`, `maxTokens?`, `scope?` |
| `create_pipeline_plan` | Resolve a pipeline against a task + inputs; return the interpolated step list. Optionally include a copy-pasteable shell script with manual-confirm prompts for apply/write steps. Never executes. | `id`, `task`, `inputs?`, `includeOptional?`, `withScript?` |

### Packs

| Tool | Intent | Inputs |
|---|---|---|
| `list_packs` | Discovered SharkCraft packs (third-party npm packages). Returns id + status + contribution counts. | _none_ |
| `get_pack` | One pack by package name. Manifest info, contribution counts, validation issues, post-install notes. | `name` |
| `inspect_packs` | Pack-discovery overview: scanned package count, valid/invalid counts, warnings. | _none_ |
| `doctor_packs` | Validate pack discovery: invalid manifests, duplicate ids, missing contribution files. | _none_ |

### Quality & safety

| Tool | Intent | Inputs |
|---|---|---|
| `get_quality_report` | Same structured report as `shrk quality`, but with `skipShell: true`. Gates that would invoke shell are recorded as `executed: false` and the response carries a `nextCommand` hint pointing to `shrk quality --strict`. | `strict?`, `requireBoundaryClean?`, `requireDriftClean?`, `requireAgentTests?`, `requireContextTests?`, `requirePackSignatures?`, `minReadiness?` |
| `get_safety_audit` | Deterministic safety audit: every CLI command grouped by safety level; MCP tools listed with `canWrite` (always false); verification commands split into trusted/pack/untrusted; pack signature status; plan-signing status; recommendations. | _none_ |
| `get_command_catalog` | The CLI command catalog with safety labels, side effects, and MCP availability. | `safetyLevel?`, `category?` |

`get_quality_report` and `get_safety_audit` are both **read-only**; they
return data plus a `nextCommand` hint when the corresponding work would
have to run on the CLI.

### Architecture & ownership (R10)

| Tool | Intent | Inputs |
|---|---|---|
| `get_repo_area_map` | Area map (folders → kind / file count / boundary rule ids). | _none_ |
| `get_impact_analysis` | Impact analysis v2 — direct + transitive dependents, risk + reasons, suggested commands. | `task?`, `files?`, `specifier?`, `planTargets?`, `maxDepth?`, `limit?` |
| `get_test_impact` | Test impact analysis (likely / missing tests, package commands). | `task?`, `files?` |
| `get_ownership` | Loaded ownership rules + sources. | _none_ |
| `match_owners` | Match files against ownership rules. | `files` |
| `get_policy_report` | Full policy engine report. | `planFile?`, `bundleId?`, `sessionId?` |
| `get_quality_baseline_comparison` | Live comparison against a saved baseline. | `baselineFile?` |
| `get_review_packet_v2` | Enriched review packet v2 (areaMap + impact + ownership + policy). | `since?`, `ownershipFiles?`, `qualityBaselineFile?` |
| `get_import_graph_analysis` | Workspace import-graph snapshot (cycles, fan-in/out, alias groups). | _none_ |

### Bundles, sessions, runtime reports

| Tool | Intent | Inputs |
|---|---|---|
| `list_feature_bundles` / `get_feature_bundle` | Feature workflow bundles (R8/R10). | `id` |
| `list_dev_sessions` / `get_dev_session` / `get_dev_status` / `get_dev_next_action` / `get_dev_report` / `start_dev_session_preview` | Dev-session metadata, read-only. | `id?`, `task?` |
| `get_session_html_report` / `get_quality_html_report` / `get_safety_html_report` / `get_review_html_report` / `get_coverage_report_rendered` / `get_drift_report_rendered` / `get_adoption_report` | Render the corresponding report. | format-specific |
| `get_dashboard_summary` | One-call workspace summary (quality + safety + coverage + drift + bundles + sessions + constructs + playbooks + nextCommands). See [`mcp-dashboard-summary.md`](mcp-dashboard-summary.md). | `includeRecentSessions?`, `includeRecentBundles?`, `maxItems?` |

### Search, briefs, constructs, playbooks (R11/R12)

| Tool | Intent | Inputs |
|---|---|---|
| `search_all` | Unified deterministic ranker across every registry + docs/sessions/bundles/constructs/playbooks. | `query`, `kinds?`, `sources?`, `limit?`, `explain?` |
| `list_search_tuning` | Pack/local search-tuning entries + load issues (R12). | _none_ |
| `create_agent_brief` | Render an agent brief (compact/full/review/implementation/handoff). Supports `chunked: true` and `sectionBudgets` (R12). | `task?`, `mode?`, `files?`, `bundleId?`, `sessionId?`, `maxTokens?`, `chunked?`, `sectionBudgets?` |
| `list_constructs` / `get_construct` / `trace_construct` / `get_construct_api` / `list_construct_facets` | Generic construct/facet inspection (R11). | `id?`, `type?` |
| `infer_constructs_preview` | Construct auto-discovery preview (R12). Read-only — drafts only land via `shrk constructs infer --write-drafts`. | `type?`, `minConfidence?`, `limit?` |
| `list_playbooks` / `get_playbook` / `recommend_playbooks` | Named runbooks (R11). | `id?`, `task?`, `limit?` |
| `preview_playbook_script` | Structured plan + bash-style preview + validation for a playbook (R12). | `id`, `task?` |

### Bundle replay & quality baseline diff (R11/R12)

| Tool | Intent | Inputs |
|---|---|---|
| `replay_bundle_apply` | Replay a bundle's audit log; flag tamper / missing-validation / out-of-order. | `bundleId`, `strict?` |
| `get_report_site_preview` | Structured page preview of the static report site without filesystem writes. | `bundleId?` |
| `get_quality_baseline_diff` | File-to-file diff of two saved baselines. | `oldFile`, `newFile` |

`ALL_TOOLS_FOR_AUDIT` in `packages/mcp-server/src/tools/command-catalog.tool.ts`
mirrors `ALL_TOOLS` — every tool in the runtime array appears in the audit
list and vice versa. The contract is enforced by tests.

## Resources

In addition to tools, the server exposes a few resources for convenience:

| URI | What | Notes |
|---|---|---|
| `sharkcraft://knowledge/all` | All knowledge entries (JSON) | Whole-document fallback |
| `sharkcraft://docs/<file>` | A markdown doc | One resource per file in `sharkcraft/docs/` |
| `sharkcraft://templates/<id>` | A template (JSON) | One per registered template |
| `sharkcraft://schemas/<name>` | A JSON schema (manifest, plan, config, …) | Useful for IDEs |

The server fires `notifications/resources/list_changed` on a watcher signal
(`--watch`) when knowledge / templates / pipelines change on disk.

## Calling a tool by hand

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_relevant_context","arguments":{"task":"generate a user profile service","maxTokens":2000}}}' \
  | SHARKCRAFT_PROJECT_ROOT="$(pwd)/examples/dogfood-target" bun run mcp
```

You should see a single JSON-RPC response with `result.content[0].text`
containing the rendered context.

## Suggested agent flow

1. **Bootstrap** — `get_project_overview`, `get_agent_instructions`,
   `get_ai_readiness_report`.
2. **Plan** — `list_pipelines` → `get_pipeline` → `get_pipeline_context`
   (or `get_relevant_context` for ad-hoc tasks).
3. **Act** — `get_action_hints` to see what commands and MCP tools to use,
   what to avoid, and how to verify.
4. **Generate** — `create_generation_plan` (preview) and hand the plan to a
   human who runs `shrk apply` via the CLI.
5. **Verify** — run the verification commands from the action hints; run
   `inspect_sharkcraft_setup` / `get_ai_readiness_report` again before
   finishing.

## Safety properties

- All inputs are zod-validated at the boundary; malformed input returns a
  clean JSON-RPC error.
- The server never writes files. `create_generation_plan` and
  `render_template_preview` return data, not changes.
- The `sharkcraft.config.ts` file is loaded as project config (trusted, same
  as `vite.config.ts`). The server never executes anything else from the
  filesystem.
- Plan signing happens in the CLI (`--sign`, `--verify-signature`) using
  `SHARKCRAFT_PLAN_SECRET`; the MCP server is intentionally out of the trust
  chain for writes.
