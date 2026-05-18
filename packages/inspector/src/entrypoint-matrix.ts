/**
 * Entrypoint matrix.
 *
 * Classifies SharkCraft's many "get me context" / "what should I do?" surfaces
 * into four discrete entrypoint classes:
 *
 *   - human-interactive    — shells / TTY use; primary first answer.
 *   - agent-mcp            — what an AI coding agent should call first.
 *   - machine-json         — non-human, machine-consumable JSON packets.
 *   - debug-explainability — ranker / boundary / search debugging.
 *
 * This is pure curated data. The CLI exposes it via `shrk commands matrix`,
 * and individual commands (`shrk task`, `shrk context`, `shrk recommend`)
 * include a one-line banner referencing this matrix so the operator sees
 * which class they reached.
 */

export const ENTRYPOINT_MATRIX_SCHEMA = 'sharkcraft.entrypoint-matrix/v1';

export enum EntrypointClass {
  HumanInteractive = 'human-interactive',
  AgentMcp = 'agent-mcp',
  MachineJson = 'machine-json',
  DebugExplainability = 'debug-explainability',
}

export interface IEntrypointMatrixEntry {
  readonly id: string;
  readonly class: EntrypointClass;
  readonly callShape: string;
  readonly whenToUse: string;
  readonly safety: 'read-only' | 'writes-drafts' | 'writes-source';
  readonly docs?: string;
  /** Identifier of an alternative entrypoint to consider, when relevant. */
  readonly seeAlso?: ReadonlyArray<string>;
}

export interface IEntrypointMatrixReport {
  readonly schema: typeof ENTRYPOINT_MATRIX_SCHEMA;
  readonly entries: ReadonlyArray<IEntrypointMatrixEntry>;
  /**
   * Curated decision-tree the renderer leans on:
   *   "If you are a … use …"
   */
  readonly decisionTree: ReadonlyArray<{
    readonly when: string;
    readonly use: string;
  }>;
}

const MATRIX_ENTRIES: ReadonlyArray<IEntrypointMatrixEntry> = [
  {
    id: 'recommend',
    class: EntrypointClass.HumanInteractive,
    callShape: 'shrk recommend "<task>"',
    whenToUse:
      'You are a human at a terminal and want "what should I do?" — primary interactive entrypoint.',
    safety: 'read-only',
    docs: 'docs/recommend.md',
    seeAlso: ['start-here', 'task-context'],
  },
  {
    id: 'start-here',
    class: EntrypointClass.HumanInteractive,
    callShape: 'shrk start-here [--flow <name>]',
    whenToUse:
      'First-time onboarding overview — 30-second explanation, primary flows, safety pledge.',
    safety: 'read-only',
    docs: 'docs/start-here.md',
    seeAlso: ['recommend'],
  },
  {
    id: 'context',
    class: EntrypointClass.HumanInteractive,
    callShape: 'shrk context --task "<task>"',
    whenToUse:
      'Build a focused, token-budgeted context bundle for a specific task. For action-like tasks, commands surface first.',
    safety: 'read-only',
    docs: 'docs/context.md',
    seeAlso: ['recommend', 'task-context'],
  },
  {
    id: 'prepare-agent-task',
    class: EntrypointClass.AgentMcp,
    callShape: 'mcp__sharkcraft__prepare_agent_task',
    whenToUse:
      'An AI agent\'s first MCP call for a task — returns brief + plan + verification commands. Read-only.',
    safety: 'read-only',
    docs: 'docs/agent-task-prep.md',
    seeAlso: ['get-relevant-context', 'get-task-packet'],
  },
  {
    id: 'get-relevant-context',
    class: EntrypointClass.AgentMcp,
    callShape: 'mcp__sharkcraft__get_relevant_context',
    whenToUse:
      'Agent-side equivalent of `shrk context`. Token-budgeted, read-only.',
    safety: 'read-only',
  },
  {
    id: 'get-task-packet',
    class: EntrypointClass.AgentMcp,
    callShape: 'mcp__sharkcraft__get_task_packet',
    whenToUse: 'Agent-side equivalent of `shrk task` — full task packet.',
    safety: 'read-only',
  },
  {
    id: 'task',
    class: EntrypointClass.MachineJson,
    callShape: 'shrk task "<task>" --json',
    whenToUse:
      'Machine-readable JSON envelope of rules + templates + pipelines + commands. Pipe into another tool.',
    safety: 'read-only',
    seeAlso: ['get-task-packet', 'context'],
  },
  {
    id: 'search',
    class: EntrypointClass.MachineJson,
    callShape: 'shrk search "<query>" [--json]',
    whenToUse:
      'Registry search across knowledge, rules, templates, playbooks, etc. JSON for piping; text for humans.',
    safety: 'read-only',
  },
  {
    id: 'why',
    class: EntrypointClass.DebugExplainability,
    callShape: 'shrk why <id> | shrk why-not <id>',
    whenToUse:
      'Debug the ranker — why a registry entry was / was not surfaced for a task.',
    safety: 'read-only',
    docs: 'docs/why.md',
    seeAlso: ['recommend', 'context'],
  },
  {
    id: 'graph-why',
    class: EntrypointClass.DebugExplainability,
    callShape: 'shrk graph why <a> <b>',
    whenToUse: 'Shortest-path explanation between two graph nodes.',
    safety: 'read-only',
    seeAlso: ['why'],
  },
  {
    id: 'apply-explain-dispatch',
    class: EntrypointClass.DebugExplainability,
    callShape: 'shrk apply <plan> --explain-dispatch',
    whenToUse:
      'Describe which dispatch path apply would take (template / helper / plugin-lifecycle / registration-hint / synthetic) without applying anything.',
    safety: 'read-only',
  },
  // Distinguish `shrk task` text output (machine packet) from
  // `task --json` (the canonical machine surface).
  {
    id: 'task-text',
    class: EntrypointClass.MachineJson,
    callShape: 'shrk task "<task>"',
    whenToUse:
      'Machine packet rendered as text. For a human answer prefer `shrk recommend`; for piping prefer `shrk task --json`.',
    safety: 'read-only',
    seeAlso: ['recommend', 'task', 'get-task-packet'],
  },
  // Make `shrk search` self-evidently a registry search, not
  // "what should I do?".
  {
    id: 'search-registry',
    class: EntrypointClass.MachineJson,
    callShape: 'shrk search "<query>"',
    whenToUse:
      'Registry search over knowledge / rules / templates / playbooks. NOT "what should I do?" — for that use `shrk recommend`.',
    safety: 'read-only',
    seeAlso: ['recommend', 'context'],
  },
];

const DECISION_TREE: ReadonlyArray<{ when: string; use: string }> = [
  {
    when: 'You are a HUMAN in a terminal asking "what should I do?"',
    use: 'shrk recommend "<task>"',
  },
  {
    when: 'You are a HUMAN exploring SharkCraft for the first time',
    use: 'shrk start-here',
  },
  {
    when: 'You are an AGENT making your first MCP call for a task',
    use: 'mcp__sharkcraft__prepare_agent_task',
  },
  {
    when: 'You want a MACHINE-readable JSON packet',
    use: 'shrk task "<task>" --json',
  },
  {
    when: 'You are DEBUGGING the ranker / boundary / dispatch',
    use: 'shrk why <id> / shrk graph why <a> <b> / shrk apply <plan> --explain-dispatch',
  },
];

export function buildEntrypointMatrix(): IEntrypointMatrixReport {
  return {
    schema: ENTRYPOINT_MATRIX_SCHEMA,
    entries: MATRIX_ENTRIES,
    decisionTree: DECISION_TREE,
  };
}

export function renderEntrypointMatrixText(report: IEntrypointMatrixReport): string {
  const lines: string[] = [];
  lines.push('# SharkCraft entrypoint matrix');
  lines.push('');
  lines.push('## When you are …');
  for (const d of report.decisionTree) lines.push(`  • ${d.when}\n      → ${d.use}`);
  lines.push('');
  lines.push('## By class');
  const grouped = new Map<string, IEntrypointMatrixEntry[]>();
  for (const e of report.entries) {
    const arr = grouped.get(e.class) ?? [];
    arr.push(e);
    grouped.set(e.class, arr);
  }
  for (const [cls, list] of grouped) {
    lines.push('');
    lines.push(`### ${cls}`);
    for (const e of list) {
      lines.push(`  $ ${e.callShape}`);
      lines.push(`    ${e.whenToUse}`);
      lines.push(`    safety: ${e.safety}${e.docs ? `  docs: ${e.docs}` : ''}`);
      if (e.seeAlso && e.seeAlso.length > 0) {
        lines.push(`    see also: ${e.seeAlso.join(', ')}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * Short banner each command can print to make its role explicit.
 * Wording aligned with the canonical-entrypoint message so every
 * overlapping surface points back at `shrk recommend` for the
 * "what should I do?" question.
 *
 *   shrk recommend  — canonical human entrypoint.
 *   shrk context    — context for doing the task; recommend is the workflow.
 *   shrk task       — machine/task-packet surface; recommend is the workflow.
 *   shrk search     — registry search; recommend is the workflow.
 *   shrk why        — ranker reasoning; recommend is the workflow.
 */
export function entrypointBanner(
  id: 'task' | 'context' | 'recommend' | 'search' | 'why' | 'task-json',
): string {
  switch (id) {
    case 'task':
      return 'Entrypoint class: machine-json — task packet for agents / JSON pipes. For human workflow guidance run `shrk recommend "<task>"`. For agent grounding prefer `prepare_agent_task`.';
    case 'task-json':
      return 'Entrypoint class: machine-json (--json). Pipe into another tool; humans usually want `shrk recommend` or `shrk context`.';
    case 'context':
      return 'Entrypoint class: human-interactive — context for doing the task. For step-by-step workflow guidance run `shrk recommend "<task>"`.';
    case 'recommend':
      return 'Entrypoint class: human-interactive — canonical human entrypoint for "what should I do?".';
    case 'search':
      return 'Entrypoint class: machine-json — searches registries/contributions. For workflow guidance run `shrk recommend "<query>"`; for ranking explanation run `shrk why <id> --for-task "<query>"`.';
    case 'why':
      return 'Entrypoint class: debug-explainability — explains ranker decisions. Not the main workflow entrypoint — for that run `shrk recommend`.';
  }
}
