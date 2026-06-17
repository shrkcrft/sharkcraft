/**
 * Primary MCP tools — the ~30 tools advertised to a connected agent
 * by default. Every tool in {@link ALL_TOOLS} stays callable (so an
 * agent that already knows the name can use it), but `tools/list`
 * only advertises the primary set. Smaller surface = better
 * tool-selection accuracy for the agent.
 *
 * Picked to match the CLI's allowlist semantics: anything an agent
 * could realistically reach for during a normal task — discovery,
 * context, planning, validation — is in. Internal introspection
 * (catalog dumps, fix-preview internals, drift baselines) is out;
 * still callable, just not in the default tool list.
 *
 * Escape hatch: set `SHRK_MCP_FULL_TOOLS=1` to advertise the full
 * catalog (useful when debugging an agent's tool selection).
 */
export const PRIMARY_MCP_TOOLS: ReadonlySet<string> = new Set([
  // Project orientation
  'inspect_workspace',
  'get_project_overview',
  'get_agent_instructions',
  'get_start_here',
  // Context / task routing
  'get_relevant_context',
  'get_task_packet',
  'get_action_hints',
  'create_agent_brief',
  'get_relevant_rules',
  'explain_command',
  // Browse the registries
  'list_knowledge',
  'get_knowledge',
  'list_rules',
  'get_rule',
  'list_path_conventions',
  'list_templates',
  'get_template',
  'list_pipelines',
  'get_pipeline',
  'list_presets',
  'get_preset',
  'list_packs',
  'get_pack',
  // Safe code generation (plan-first)
  'create_generation_plan',
  'render_template_preview',
  'explain_generation_target',
  // Validation gates (read-only)
  'check_boundaries',
  'get_diff_check_report',
  'get_file_advice',
  'get_architecture_constraints',
  'get_architecture_violations',
  // Doctor / readiness
  'get_ai_readiness_report',
  'doctor_packs',
  // Search
  'search_all',
  'search_knowledge',
  'search_commands',
  // Token compression (deterministic, reversible)
  'compress_context',
  'retrieve_original',
  'align_cache',
  'restore_cache',
]);

/**
 * Should `tools/list` advertise the full catalog instead of the
 * primary set? Driven by the env var so an agent operator can flip it
 * without rebuilding.
 */
export function shouldAdvertiseFullToolset(): boolean {
  const v = process.env.SHRK_MCP_FULL_TOOLS;
  return v === '1' || v === 'true' || v === 'yes';
}
