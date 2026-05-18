/**
 * R30 PART 7 — SharkCraft local feedback rules.
 *
 * Each rule extends the built-in keyword scanner. Pack-contributed rules
 * land via `feedbackRuleFiles[]` in a pack manifest; this file is the
 * local engine-side surface.
 */

interface ILocalFeedbackRule {
  id: string;
  title: string;
  description?: string;
  keywords?: readonly string[];
  phrases?: readonly string[];
  regexes?: readonly string[];
  targetArea?: string;
  tag?: string;
  tags?: readonly string[];
  severity?: 'info' | 'minor' | 'major' | 'blocker';
  suggestedActions?: readonly string[];
  relatedCommands?: readonly string[];
}

function defineFeedbackRule(r: ILocalFeedbackRule): ILocalFeedbackRule {
  return r;
}

export default [
  defineFeedbackRule({
    id: 'sharkcraft.fuzzy-trace-impact-friction',
    title: 'Fuzzy trace/impact friction',
    keywords: ['fuzzy', 'resolve', 'ambiguous'],
    phrases: ['shrk trace', 'shrk impact'],
    targetArea: 'fuzzy-impact',
    tag: 'fuzzy',
    suggestedActions: [
      'shrk trace <query> --deep',
      'shrk impact <query> --explain-resolution',
    ],
  }),
  defineFeedbackRule({
    id: 'sharkcraft.knowledge-stale-ci',
    title: 'Knowledge stale-check CI integration',
    keywords: ['stale', 'rot', 'references'],
    phrases: ['stale check', 'knowledge stale'],
    targetArea: 'knowledge-stale-check',
    tag: 'knowledge-ci',
    suggestedActions: [
      'shrk knowledge stale-check --ci',
      'shrk release readiness --with-knowledge-check',
    ],
  }),
  defineFeedbackRule({
    id: 'sharkcraft.template-drift-noise',
    title: 'Template drift noise',
    keywords: ['drift', 'noise', 'path-no-convention'],
    phrases: ['template drift'],
    targetArea: 'template-drift',
    tag: 'template-drift',
    suggestedActions: [
      'shrk templates drift --min-severity warning',
      'shrk templates drift --hide path-no-convention',
    ],
  }),
  defineFeedbackRule({
    id: 'sharkcraft.agent-test-ranker-drift',
    title: 'Agent test ranker drift',
    keywords: ['ranker', 'rank'],
    phrases: ['agent test', 'agent tests', 'ranker drift'],
    targetArea: 'agent-tests',
    tag: 'ranker',
    suggestedActions: [
      'shrk test agent',
      'shrk task "<task>" --explain-ranking',
    ],
  }),
  defineFeedbackRule({
    id: 'sharkcraft.changed-only-boundary-friction',
    title: 'Changed-only boundary friction',
    keywords: ['legacy', 'pre-existing'],
    phrases: ['changed only', 'changed-only', 'boundary violations'],
    targetArea: 'boundaries-changed-only',
    tag: 'changed-only',
    suggestedActions: [
      'shrk check boundaries --changed-only',
      'shrk architecture violations --changed-only',
    ],
  }),
  defineFeedbackRule({
    id: 'sharkcraft.mcp-readonly-enforcement',
    title: 'MCP read-only invariant',
    keywords: ['mcp', 'write-tool'],
    phrases: ['mcp tool', 'mcp write'],
    targetArea: 'mcp-read-only',
    tag: 'mcp-safety',
    severity: 'major',
    suggestedActions: [
      'shrk safety audit --deep',
      'shrk commands doctor',
    ],
  }),
  defineFeedbackRule({
    id: 'sharkcraft.warning-noise',
    title: 'Doctor warning noise',
    keywords: ['noisy', 'noise', 'warnings'],
    phrases: ['action-hint', 'action hint'],
    targetArea: 'doctor-suppressions',
    tag: 'doctor-noise',
    severity: 'minor',
    suggestedActions: [
      'shrk doctor --quiet-known',
      'shrk doctor suppressions list',
    ],
  }),
  defineFeedbackRule({
    id: 'sharkcraft.feedback-rules-pack',
    title: 'Pack-extensible feedback rules',
    keywords: ['feedback'],
    phrases: ['feedback rules', 'pack rules'],
    targetArea: 'feedback-rules',
    tag: 'feedback-rules',
    suggestedActions: [
      'shrk feedback rules list',
      'shrk feedback rules doctor',
    ],
  }),
];
