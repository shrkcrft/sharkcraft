/**
 * Canonical agent task entrypoint.
 *
 * `prepareAgentTask` is the recommended first call an AI agent (or
 * MCP client) makes when it picks up a task. It bundles:
 *   - intent classification
 *   - relevant rules / paths / templates / playbooks / profiles / conventions
 *   - recommended CLI commands (inspection / generation / validation)
 *   - uncertainty signals
 *   - safety notes
 *   - next safe action
 *
 * Read-only. Never writes; never executes commands.
 */
import { buildTaskPacket } from './task-packet.ts';
import { listPluginLifecycleProfiles } from './plugin-lifecycle-profile-registry.ts';
import { listConventions } from './convention-registry.ts';
import { listTaskRoutingHints, explainTaskRouting } from './task-routing-hint-registry.ts';
import { buildUncertaintySummary } from './uncertainty.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const AGENT_TASK_PREP_SCHEMA = 'sharkcraft.agent-task-prep/v1';

export interface IAgentTaskPrepReport {
  readonly schema: typeof AGENT_TASK_PREP_SCHEMA;
  readonly generatedAt: string;
  readonly task: string;
  readonly intentHints: readonly string[];
  readonly confidence: 'high' | 'medium' | 'low';
  readonly missingSignals: readonly string[];
  readonly primaryCommands: readonly string[];
  readonly inspectionCommands: readonly string[];
  readonly generationCommands: readonly string[];
  readonly validationCommands: readonly string[];
  readonly relevantProfiles: readonly { id: string; title: string }[];
  readonly relevantConventions: readonly { id: string; title: string }[];
  readonly routingHints: readonly { id: string; title: string; reasons: readonly string[] }[];
  readonly safetyNotes: readonly string[];
  readonly nextSafeAction: string;
}

export async function prepareAgentTask(
  inspection: ISharkcraftInspection,
  task: string,
): Promise<IAgentTaskPrepReport> {
  const packet = buildTaskPacket(inspection, task);
  const uncertaintyReport = buildUncertaintySummary(packet);
  const lifecycle = await listPluginLifecycleProfiles(inspection);
  const conventions = await listConventions(inspection);
  const routing = await explainTaskRouting(inspection, task);
  await listTaskRoutingHints(inspection); // warm cache

  const inspectionCommands: string[] = [
    `shrk context --task "${task}" --commands-first`,
    `shrk task "${task}"`,
    `shrk why ${routing[0]?.hint.id ?? '<id>'} --for-task "${task}"`,
    'shrk packs contributions',
    'shrk self-config doctor',
  ];
  const generationCommands: string[] = [
    `shrk gen <template-id> <name> --dry-run --save-plan /tmp/plan.json`,
  ];
  const validationCommands: string[] = [
    'shrk doctor',
    'shrk check boundaries --changed-only',
    'shrk test agent',
    'shrk self-config doctor',
  ];
  const primaryCommands: string[] = routing.flatMap((m) => m.hint.recommends.commands ?? []).slice(0, 5);

  const intentHints: string[] = [];
  if (/\brename\b/i.test(task)) intentHints.push('refactor');
  if (/\bremove\b/i.test(task)) intentHints.push('removal');
  if (/\badd\b|\bcreate\b/i.test(task)) intentHints.push('generate-code');

  return {
    schema: AGENT_TASK_PREP_SCHEMA,
    generatedAt: new Date().toISOString(),
    task,
    intentHints,
    confidence: uncertaintyReport.confidence,
    missingSignals: uncertaintyReport.uncertainty.map((s) => s.code),
    primaryCommands,
    inspectionCommands,
    generationCommands,
    validationCommands,
    relevantProfiles: lifecycle.slice(0, 5).map((e) => ({ id: e.profile.id, title: e.profile.title })),
    relevantConventions: conventions.slice(0, 5).map((e) => ({ id: e.convention.id, title: e.convention.title })),
    routingHints: routing.slice(0, 5).map((m) => ({ id: m.hint.id, title: m.hint.title, reasons: m.reasons })),
    safetyNotes: [
      'SharkCraft engine never auto-applies plans. The human runs `shrk apply --verify-signature`.',
      'MCP tools are read-only; every write happens via the CLI.',
      'Folder rename/delete plans default to manual checklist; pass `--emit-folder-ops` to opt into structured plan ops with strict safety gates.',
    ],
    nextSafeAction:
      'Inspect the recommended commands above before writing any code. Start with `shrk task "<task>" --commands-first` for the human-friendly summary.',
  };
}
