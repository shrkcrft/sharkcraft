import { defineKnowledgeEntry, KnowledgeType, KnowledgePriority } from '@shrkcrft/knowledge';

export const projectOverview = defineKnowledgeEntry({
  id: 'project.overview',
  title: 'Project overview',
  type: KnowledgeType.Architecture,
  priority: KnowledgePriority.High,
  scope: ['typescript', 'bun', 'backend'],
  tags: ['overview'],
  appliesWhen: ['onboard', 'plan-work'],
  summary: 'Bun-native HTTP service exposing user endpoints.',
  content: `dogfood-target is a small Bun.serve() HTTP service. The service exposes
/users/:id and /health. Business logic lives under src/services. Pure helpers
live under src/utils. Tests live under tests/ and run with bun test.`,
});

export const techStack = defineKnowledgeEntry({
  id: 'project.tech-stack',
  title: 'Tech stack',
  type: KnowledgeType.Technical,
  priority: KnowledgePriority.High,
  scope: ['typescript', 'bun'],
  tags: ['tech', 'stack'],
  appliesWhen: ['onboard', 'review-code'],
  content: `Runtime: Bun >= 1.1. Language: TypeScript with strict mode.
HTTP layer: Bun.serve(). Tests: bun test. No external web framework.`,
});

export const agentBriefing = defineKnowledgeEntry({
  id: 'agent.briefing',
  title: 'AI agent briefing',
  type: KnowledgeType.Convention,
  priority: KnowledgePriority.Critical,
  scope: ['ai-agent'],
  tags: ['agent', 'mcp'],
  appliesWhen: ['agent-start', 'agent-plan'],
  content: `Use SharkCraft MCP tools to retrieve only relevant context per task.
Always call get_relevant_rules and create_generation_plan before suggesting
file writes. Never propose writes outside the project root.`,
});

export const generationSafety = defineKnowledgeEntry({
  id: 'safety.generation',
  title: 'Generation safety',
  type: KnowledgeType.Warning,
  priority: KnowledgePriority.Critical,
  scope: ['generation'],
  tags: ['safety'],
  appliesWhen: ['generate-code'],
  content: `shrk gen defaults to dry-run. Writes require --write AND a clean
plan with no conflicts. Refuse absolute target paths and ../ traversal.`,
});

export const httpEndpointDecision = defineKnowledgeEntry({
  id: 'decision.no-framework',
  title: 'Decision: do not introduce an HTTP framework yet',
  type: KnowledgeType.Decision,
  priority: KnowledgePriority.Medium,
  scope: ['backend'],
  tags: ['http', 'architecture'],
  appliesWhen: ['add-endpoint', 'review-code'],
  content: `For v0.1 we use Bun.serve() directly. Switching to Hono / Elysia /
Express requires a separate ADR. Routes stay in src/server.ts; logic stays in
services so tests don't need an HTTP layer.`,
});

export default [
  projectOverview,
  techStack,
  agentBriefing,
  generationSafety,
  httpEndpointDecision,
];
