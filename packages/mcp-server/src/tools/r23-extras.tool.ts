/**
 * Agent-contract MCP tools. All read-only.
 */
import {
  buildAgentContract,
  buildHealingPlanFromCommand,
  buildHealingPlanFromError,
  buildHealingPlanFromFile,
  buildHealingPlanFromReport,
  buildRepositoryMemory,
  buildTaskExecutionGraph,
  loadRepositoryMemory,
  memoryRiskForTask,
  simulatePlan,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const createAgentContractTool: IToolDefinition = {
  name: 'create_agent_contract',
  description:
    'Build a deterministic agent contract for a task (intent + risk + impact + ownership + boundaries + policies + playbooks). Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string' },
      role: { type: 'string' },
      mode: { type: 'string' },
      files: { type: 'array', items: { type: 'string' } },
      since: { type: 'string' },
      staged: { type: 'boolean' },
    },
    required: ['task'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const task = typeof input['task'] === 'string' ? (input['task'] as string) : '';
    const role = typeof input['role'] === 'string' ? (input['role'] as string) : undefined;
    const mode = typeof input['mode'] === 'string' ? (input['mode'] as string) : undefined;
    const since = typeof input['since'] === 'string' ? (input['since'] as string) : undefined;
    const staged = input['staged'] === true;
    const files = Array.isArray(input['files'])
      ? (input['files'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : undefined;
    const contract = await buildAgentContract(task, ctx.inspection, {
      ...(role ? { role } : {}),
      ...(mode ? { mode } : {}),
      ...(files ? { files } : {}),
      ...(since ? { since } : {}),
      ...(staged ? { staged: true } : {}),
    });
    return { data: contract };
  },
};

export const simulatePlanTool: IToolDefinition = {
  name: 'simulate_plan',
  description:
    'Simulate a saved generation plan (v1 or v2): virtual final content, classified operations, boundary/policy/impact gates, apply readiness. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      planPath: { type: 'string' },
      strict: { type: 'boolean' },
      includeBoundaries: { type: 'boolean' },
      includeImpact: { type: 'boolean' },
      includeTests: { type: 'boolean' },
      includePolicies: { type: 'boolean' },
      includeOwnership: { type: 'boolean' },
      includeMemory: { type: 'boolean' },
    },
    required: ['planPath'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const planPath = typeof input['planPath'] === 'string' ? (input['planPath'] as string) : '';
    if (!planPath) {
      return {
        isError: true,
        error: { code: 'invalid-input', message: 'planPath is required.' },
      };
    }
    const report = await simulatePlan(ctx.inspection, planPath, {
      strict: input['strict'] === true,
      includeBoundaries: input['includeBoundaries'] !== false,
      includeImpact: input['includeImpact'] !== false,
      includeTests: input['includeTests'] !== false,
      includePolicies: input['includePolicies'] !== false,
      includeOwnership: input['includeOwnership'] !== false,
      includeMemory: input['includeMemory'] === true,
    });
    return { data: report };
  },
};

export const getMemoryReportTool: IToolDefinition = {
  name: 'get_memory_report',
  description:
    'Get the local repository memory index (built by `shrk memory build`). Read-only.',
  inputSchema: {
    type: 'object',
    properties: { rebuild: { type: 'boolean' } },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    if (input['rebuild'] === true) {
      const built = await buildRepositoryMemory(ctx.inspection);
      return { data: built };
    }
    const index = loadRepositoryMemory(ctx.inspection.projectRoot);
    if (!index) {
      return {
        isError: true,
        error: {
          code: 'no-memory-index',
          message: 'No memory index found. Run `shrk memory build` first (or call this tool with rebuild=true).',
        },
      };
    }
    return { data: index };
  },
};

export const getMemoryRiskTool: IToolDefinition = {
  name: 'get_memory_risk',
  description: 'Compute memory-based risk overlap for a task. Read-only.',
  inputSchema: {
    type: 'object',
    properties: { task: { type: 'string' } },
    required: ['task'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const task = typeof input['task'] === 'string' ? (input['task'] as string) : '';
    const index = loadRepositoryMemory(ctx.inspection.projectRoot);
    return { data: memoryRiskForTask(index, task) };
  },
};

export const listMemoryFilesTool: IToolDefinition = {
  name: 'list_memory_files',
  description: 'List historically risky files from the local memory index. Read-only.',
  inputSchema: {
    type: 'object',
    properties: { limit: { type: 'number' } },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const index = loadRepositoryMemory(ctx.inspection.projectRoot);
    if (!index) {
      return {
        isError: true,
        error: {
          code: 'no-memory-index',
          message: 'No memory index found. Run `shrk memory build` first.',
        },
      };
    }
    const lim = typeof input['limit'] === 'number' ? (input['limit'] as number) : 50;
    return { data: index.files.slice(0, lim) };
  },
};

export const getMemoryDiagnosticsTool: IToolDefinition = {
  name: 'get_memory_diagnostics',
  description: 'List recurring diagnostics from the local memory index. Read-only.',
  inputSchema: {
    type: 'object',
    properties: { limit: { type: 'number' } },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const index = loadRepositoryMemory(ctx.inspection.projectRoot);
    if (!index) {
      return {
        isError: true,
        error: {
          code: 'no-memory-index',
          message: 'No memory index found. Run `shrk memory build` first.',
        },
      };
    }
    const lim = typeof input['limit'] === 'number' ? (input['limit'] as number) : 50;
    return { data: index.diagnostics.slice(0, lim) };
  },
};

export const createHealingPlanTool: IToolDefinition = {
  name: 'create_healing_plan',
  description:
    'Build a deterministic healing plan from a free-form error string, a log file, a JSON report, or a failed command. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      errorText: { type: 'string' },
      filePath: { type: 'string' },
      reportPath: { type: 'string' },
      command: { type: 'string' },
      exitCode: { type: 'number' },
      stderrText: { type: 'string' },
    },
    additionalProperties: false,
  },
  async handler(input) {
    if (typeof input['errorText'] === 'string' && (input['errorText'] as string).length > 0) {
      return { data: buildHealingPlanFromError(input['errorText'] as string) };
    }
    if (typeof input['filePath'] === 'string' && (input['filePath'] as string).length > 0) {
      return { data: buildHealingPlanFromFile(input['filePath'] as string) };
    }
    if (typeof input['reportPath'] === 'string' && (input['reportPath'] as string).length > 0) {
      return { data: buildHealingPlanFromReport(input['reportPath'] as string) };
    }
    if (typeof input['command'] === 'string' && (input['command'] as string).length > 0) {
      const cmd = input['command'] as string;
      const code = typeof input['exitCode'] === 'number' ? (input['exitCode'] as number) : 1;
      const stderr = typeof input['stderrText'] === 'string' ? (input['stderrText'] as string) : '';
      return { data: buildHealingPlanFromCommand(cmd, code, stderr) };
    }
    return {
      isError: true,
      error: {
        code: 'invalid-input',
        message: 'Provide one of: errorText, filePath, reportPath, or command + exitCode + stderrText.',
      },
    };
  },
};

export const createExecutionGraphTool: IToolDefinition = {
  name: 'create_execution_graph',
  description:
    'Build a task execution graph (task → intent → risk → contract → constructs → plans → gates → validation → done). Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string' },
      role: { type: 'string' },
      mode: { type: 'string' },
      files: { type: 'array', items: { type: 'string' } },
      since: { type: 'string' },
      staged: { type: 'boolean' },
    },
    required: ['task'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const task = typeof input['task'] === 'string' ? (input['task'] as string) : '';
    const role = typeof input['role'] === 'string' ? (input['role'] as string) : undefined;
    const mode = typeof input['mode'] === 'string' ? (input['mode'] as string) : undefined;
    const since = typeof input['since'] === 'string' ? (input['since'] as string) : undefined;
    const staged = input['staged'] === true;
    const files = Array.isArray(input['files'])
      ? (input['files'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : undefined;
    const graph = await buildTaskExecutionGraph(task, ctx.inspection, {
      ...(role ? { role } : {}),
      ...(mode ? { mode } : {}),
      ...(files ? { files } : {}),
      ...(since ? { since } : {}),
      ...(staged ? { staged: true } : {}),
    });
    return { data: graph };
  },
};
