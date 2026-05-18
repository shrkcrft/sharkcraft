/**
 * Memory MCP tools. All read-only.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  AGENT_CONTRACT_APPROVAL_SCHEMA,
  buildApproval,
  buildTaskExecutionGraph,
  checkAgentContract,
  computeContractHash,
  queryExecutionGraph,
  type IAgentContract,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

function resolveAgainstInspection(planPath: string, projectRoot: string): string {
  return nodePath.isAbsolute(planPath) ? planPath : nodePath.resolve(projectRoot, planPath);
}

export const getContractStatusTool: IToolDefinition = {
  name: 'get_contract_status',
  description: 'Validate an agent contract (optionally against a plan + approval). Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      contractPath: { type: 'string' },
      planPath: { type: 'string' },
      approvalPath: { type: 'string' },
    },
    required: ['contractPath'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const contractPath = typeof input['contractPath'] === 'string' ? (input['contractPath'] as string) : '';
    if (!contractPath) {
      return { isError: true, error: { code: 'invalid-input', message: 'contractPath is required.' } };
    }
    const abs = resolveAgainstInspection(contractPath, ctx.inspection.projectRoot);
    if (!existsSync(abs)) {
      return { isError: true, error: { code: 'not-found', message: `Contract not found: ${abs}` } };
    }
    let contract: IAgentContract;
    try {
      contract = JSON.parse(readFileSync(abs, 'utf8')) as IAgentContract;
    } catch (e) {
      return { isError: true, error: { code: 'invalid-input', message: `Failed to parse contract: ${(e as Error).message}` } };
    }
    const planPath = typeof input['planPath'] === 'string' ? (input['planPath'] as string) : undefined;
    const approvalPath = typeof input['approvalPath'] === 'string' ? (input['approvalPath'] as string) : undefined;
    const report = await checkAgentContract(ctx.inspection, contract, {
      ...(planPath ? { planPath: resolveAgainstInspection(planPath, ctx.inspection.projectRoot) } : {}),
      ...(approvalPath ? { approvalPath: resolveAgainstInspection(approvalPath, ctx.inspection.projectRoot) } : {}),
    });
    return { data: report };
  },
};

/**
 * MCP preview only — never writes a file. The human runs
 * `shrk contract approve … --output …` to actually persist an approval.
 */
export const createContractApprovalPreviewTool: IToolDefinition = {
  name: 'create_contract_approval_preview',
  description:
    'Preview a contract approval (does NOT write anything). The human runs `shrk contract approve … --output <file>` to persist. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      contractPath: { type: 'string' },
      approvedBy: { type: 'string' },
      reason: { type: 'string' },
      approvedGates: { type: 'array', items: { type: 'string' } },
      expiresAt: { type: 'string' },
    },
    required: ['contractPath', 'approvedBy', 'reason'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const contractPath = typeof input['contractPath'] === 'string' ? (input['contractPath'] as string) : '';
    const approvedBy = typeof input['approvedBy'] === 'string' ? (input['approvedBy'] as string) : '';
    const reason = typeof input['reason'] === 'string' ? (input['reason'] as string) : '';
    if (!contractPath || !approvedBy || !reason) {
      return { isError: true, error: { code: 'invalid-input', message: 'contractPath, approvedBy, reason are all required.' } };
    }
    const abs = resolveAgainstInspection(contractPath, ctx.inspection.projectRoot);
    if (!existsSync(abs)) {
      return { isError: true, error: { code: 'not-found', message: `Contract not found: ${abs}` } };
    }
    let contract: IAgentContract;
    try {
      contract = JSON.parse(readFileSync(abs, 'utf8')) as IAgentContract;
    } catch (e) {
      return { isError: true, error: { code: 'invalid-input', message: `Failed to parse contract: ${(e as Error).message}` } };
    }
    const hash = computeContractHash(contract);
    const approval = buildApproval({
      contractHash: hash,
      approvedBy,
      reason,
      ...(Array.isArray(input['approvedGates'])
        ? {
            approvedGates: (input['approvedGates'] as unknown[]).filter(
              (x): x is string => typeof x === 'string',
            ),
          }
        : {}),
      ...(typeof input['expiresAt'] === 'string' ? { expiresAt: input['expiresAt'] as string } : {}),
    });
    return {
      data: {
        schema: AGENT_CONTRACT_APPROVAL_SCHEMA,
        approvalPreview: approval,
        contractHash: hash,
        nextCommand: `shrk contract approve <contract.json> --by "${approvedBy}" --reason "${reason}" --output <approval.json>`,
        note: 'Preview only — MCP does not write. The human must run the CLI to persist the approval.',
      },
    };
  },
};

export const queryExecutionGraphTool: IToolDefinition = {
  name: 'query_execution_graph',
  description:
    'Query a saved execution graph (by JSON path) or rebuild for a task, then return matching nodes/edges. Supported queries: blocks:done, kind:<x>, edge:<x>, text:<x>. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      graphPath: { type: 'string' },
      task: { type: 'string' },
      role: { type: 'string' },
      query: { type: 'string' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const query = typeof input['query'] === 'string' ? (input['query'] as string) : '';
    if (!query) {
      return { isError: true, error: { code: 'invalid-input', message: 'query is required.' } };
    }
    const graphPath = typeof input['graphPath'] === 'string' ? (input['graphPath'] as string) : undefined;
    if (graphPath) {
      const abs = resolveAgainstInspection(graphPath, ctx.inspection.projectRoot);
      if (!existsSync(abs)) {
        return { isError: true, error: { code: 'not-found', message: `Graph not found: ${abs}` } };
      }
      const graph = JSON.parse(readFileSync(abs, 'utf8'));
      return { data: queryExecutionGraph(graph, query) };
    }
    const task = typeof input['task'] === 'string' ? (input['task'] as string) : '';
    if (!task) {
      return { isError: true, error: { code: 'invalid-input', message: 'graphPath or task is required.' } };
    }
    const role = typeof input['role'] === 'string' ? (input['role'] as string) : undefined;
    const graph = await buildTaskExecutionGraph(task, ctx.inspection, role ? { role } : {});
    return { data: queryExecutionGraph(graph, query) };
  },
};
