import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { rankAll } from './task-ranker.ts';

export const TASK_DECOMPOSE_SCHEMA = 'sharkcraft.task-decomposition/v1';

export enum TaskVerb {
  Create = 'create',
  Add = 'add',
  Refactor = 'refactor',
  Fix = 'fix',
  Test = 'test',
  Document = 'document',
  Review = 'review',
  Migrate = 'migrate',
  Remove = 'remove',
  Unknown = 'unknown',
}

const VERB_PATTERNS: Array<{ verb: TaskVerb; words: readonly string[] }> = [
  { verb: TaskVerb.Create, words: ['create', 'generate', 'scaffold', 'build', 'implement', 'new'] },
  { verb: TaskVerb.Add, words: ['add', 'introduce', 'extend', 'expose'] },
  { verb: TaskVerb.Refactor, words: ['refactor', 'rewrite', 'rename', 'extract'] },
  { verb: TaskVerb.Fix, words: ['fix', 'patch', 'repair', 'bug'] },
  { verb: TaskVerb.Test, words: ['test', 'spec', 'coverage'] },
  { verb: TaskVerb.Document, words: ['document', 'doc', 'readme'] },
  { verb: TaskVerb.Review, words: ['review', 'audit'] },
  { verb: TaskVerb.Migrate, words: ['migrate', 'upgrade', 'port'] },
  { verb: TaskVerb.Remove, words: ['remove', 'delete', 'drop'] },
];

const DOMAIN_HINTS = [
  'plugin',
  'policy',
  'capability',
  'adapter',
  'service',
  'component',
  'api',
  'table',
  'auth',
  'route',
  'controller',
  'middleware',
  'queue',
  'job',
  'worker',
  'cli',
  'mcp',
];

export interface ITaskSubtask {
  id: string;
  title: string;
  reason: string;
  relatedTemplateIds: readonly string[];
  relatedPipelineIds: readonly string[];
  riskLevel: 'low' | 'medium' | 'high';
}

export interface ITaskDecomposition {
  schema: typeof TASK_DECOMPOSE_SCHEMA;
  task: string;
  verb: TaskVerb;
  domainHints: readonly string[];
  subtasks: readonly ITaskSubtask[];
  suggestedTemplateIds: readonly string[];
  suggestedPipelineIds: readonly string[];
  requiredVariables: readonly string[];
  riskAreas: readonly string[];
  validationSuggestions: readonly string[];
  recommendedOrder: readonly string[];
}

export function detectVerb(task: string): TaskVerb {
  const lower = task.toLowerCase();
  for (const { verb, words } of VERB_PATTERNS) {
    if (words.some((w) => new RegExp(`\\b${w}`).test(lower))) return verb;
  }
  return TaskVerb.Unknown;
}

function detectDomainHints(task: string): string[] {
  const lower = task.toLowerCase();
  return DOMAIN_HINTS.filter((d) => lower.includes(d));
}

export function decomposeTask(
  inspection: ISharkcraftInspection,
  task: string,
): ITaskDecomposition {
  const verb = detectVerb(task);
  const domainHints = detectDomainHints(task);
  const ranking = rankAll(inspection, task, 6);

  const subtasks: ITaskSubtask[] = [];

  if (verb === TaskVerb.Create || verb === TaskVerb.Add) {
    if (domainHints.includes('plugin') || domainHints.includes('capability')) {
      subtasks.push(stepFor('contract', 'Create plugin contract / interface', ranking, 'low'));
      subtasks.push(stepFor('cross-impl', 'Create cross / shared implementation', ranking, 'medium'));
      subtasks.push(stepFor('defaults', 'Wire defaults / registration', ranking, 'medium'));
    } else if (domainHints.includes('adapter')) {
      subtasks.push(stepFor('adapter-iface', 'Define adapter interface', ranking, 'low'));
      subtasks.push(stepFor('adapter-impl', 'Implement adapter', ranking, 'medium'));
    } else if (domainHints.includes('service') || domainHints.includes('controller')) {
      subtasks.push(stepFor('service', 'Implement service', ranking, 'medium'));
      subtasks.push(stepFor('service-tests', 'Add unit tests', ranking, 'low'));
    } else if (domainHints.includes('component') || domainHints.includes('cli')) {
      subtasks.push(stepFor('feature', 'Implement primary unit', ranking, 'medium'));
    } else {
      subtasks.push(stepFor('feature', 'Implement primary unit', ranking, 'medium'));
    }
  } else if (verb === TaskVerb.Refactor || verb === TaskVerb.Migrate) {
    subtasks.push(stepFor('analyze', 'Map current behavior', ranking, 'low'));
    subtasks.push(stepFor('plan', 'Plan the refactor / migration steps', ranking, 'medium'));
    subtasks.push(stepFor('apply', 'Apply changes', ranking, 'high'));
  } else if (verb === TaskVerb.Fix) {
    subtasks.push(stepFor('reproduce', 'Reproduce the bug locally', ranking, 'low'));
    subtasks.push(stepFor('fix', 'Apply the fix', ranking, 'medium'));
    subtasks.push(stepFor('regression', 'Add regression test', ranking, 'low'));
  } else if (verb === TaskVerb.Test) {
    subtasks.push(stepFor('cases', 'Enumerate cases', ranking, 'low'));
    subtasks.push(stepFor('spec', 'Write tests', ranking, 'low'));
  } else if (verb === TaskVerb.Remove) {
    subtasks.push(stepFor('locate', 'Locate all references', ranking, 'low'));
    subtasks.push(stepFor('delete', 'Delete', ranking, 'high'));
  } else {
    subtasks.push(stepFor('explore', 'Explore + plan', ranking, 'low'));
  }

  subtasks.push({
    id: `${subtasks.length + 1}-validate`,
    title: 'Validate (boundaries, types, tests)',
    reason: 'Required by policy: changes must pass boundary check and tests.',
    relatedTemplateIds: [],
    relatedPipelineIds: [],
    riskLevel: 'low',
  });

  const suggestedTemplateIds = ranking.templates.slice(0, 5).map((t) => t.item.id);
  const suggestedPipelineIds = ranking.pipelines.slice(0, 3).map((p) => p.item.id);

  const requiredVariables = uniqueStrings(
    ranking.templates
      .slice(0, 5)
      .flatMap((t) => (t.item.variables ?? []).filter((v) => v.required).map((v) => v.name)),
  );

  const riskAreas = uniqueStrings(
    ranking.paths.slice(0, 5).map((p) => p.item.id),
  );

  const validationSuggestions = uniqueStrings([
    'shrk doctor',
    'shrk check boundaries',
    'bun x tsc -p tsconfig.base.json --noEmit',
    'bun test',
  ]);

  const recommendedOrder = subtasks.map((s) => s.id);

  return {
    schema: TASK_DECOMPOSE_SCHEMA,
    task,
    verb,
    domainHints,
    subtasks,
    suggestedTemplateIds,
    suggestedPipelineIds,
    requiredVariables,
    riskAreas,
    validationSuggestions,
    recommendedOrder,
  };
}

function stepFor(
  slug: string,
  title: string,
  ranking: ReturnType<typeof rankAll>,
  risk: 'low' | 'medium' | 'high',
): ITaskSubtask {
  const tpl = ranking.templates[0]?.item.id;
  const pipe = ranking.pipelines[0]?.item.id;
  return {
    id: `${slug}`,
    title,
    reason: 'derived from verb + domain hints',
    relatedTemplateIds: tpl ? [tpl] : [],
    relatedPipelineIds: pipe ? [pipe] : [],
    riskLevel: risk,
  };
}

function uniqueStrings(xs: readonly string[]): string[] {
  return [...new Set(xs)];
}
