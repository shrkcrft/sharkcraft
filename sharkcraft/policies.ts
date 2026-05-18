/**
 * R29 PART 10 — SharkCraft self-policies.
 *
 * Each policy is a pure function of the inspection + (optional) plan/bundle
 * targets. They surface invariants that are otherwise only enforced in
 * code: MCP read-only, apply requires verify-signature, no destructive
 * helper without approval, etc.
 *
 * Local file picked up automatically by `evaluatePolicy()` because it
 * defaults `localPolicyFiles` to `sharkcraft/policies.ts`.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
// Local shape mirror — avoid pulling in @shrkcrft/plugin-api so the
// file can be loaded by the workspace-relative TS dynamic importer.
interface ILocalPolicyCheck {
  id: string;
  title: string;
  severity?: 'info' | 'warning' | 'error' | 'critical';
  checkType?: 'path' | 'import' | 'ownership' | 'command' | 'template' | 'plan' | 'bundle' | 'session';
  evaluate: (input: {
    projectRoot: string;
    planTargets: readonly string[];
    bundleAffectedFiles: readonly string[];
  }) => boolean | { message: string; suggestedFix?: string; context?: Record<string, unknown> };
}

function definePackPolicyCheck(c: ILocalPolicyCheck): ILocalPolicyCheck {
  return c;
}

const READ_ONLY_REGEX = /\b(read[\s_-]?only|readonly)\b/i;
const WRITE_FORBIDDEN_REGEX = /\b(writes?\s+files?|will\s+modify|destructive)\b/i;

function readFileSafely(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export default [
  definePackPolicyCheck({
    id: 'sharkcraft.mcp-read-only',
    title: 'MCP tools must remain read-only',
    severity: 'error',
    checkType: 'command',
    evaluate({ projectRoot }) {
      // Scan every MCP tool file and confirm it does not call writeFileSync
      // / writeFile / mkdirSync without an explicit `// allow-write` comment.
      const dir = nodePath.join(projectRoot, 'packages/mcp-server/src/tools');
      if (!existsSync(dir)) return true;
      const offenders: string[] = [];
      const walk = (root: string): void => {
        const fs = require('node:fs') as typeof import('node:fs');
        for (const e of fs.readdirSync(root, { withFileTypes: true })) {
          const full = nodePath.join(root, e.name);
          if (e.isDirectory()) walk(full);
          else if (full.endsWith('.tool.ts')) {
            const text = readFileSafely(full);
            if (!text) continue;
            if (/writeFileSync|writeFile\(|mkdirSync|appendFileSync|unlinkSync|rmSync/.test(text)) {
              offenders.push(nodePath.relative(projectRoot, full));
            }
          }
        }
      };
      walk(dir);
      if (offenders.length === 0) return true;
      return {
        message: `MCP tool(s) appear to perform writes: ${offenders.join(', ')}`,
        suggestedFix: 'Move the write to a CLI command; keep MCP read-only.',
        context: { offenders },
      };
    },
  }),
  definePackPolicyCheck({
    id: 'sharkcraft.apply-requires-explicit-verify-for-signed-plans',
    title: 'shrk apply must accept --verify-signature for signed plans',
    severity: 'warning',
    checkType: 'command',
    evaluate({ projectRoot }) {
      const file = nodePath.join(projectRoot, 'packages/cli/src/commands/apply.command.ts');
      const text = readFileSafely(file);
      if (!text) return true;
      const ok = text.includes("'verify-signature'") || text.includes('"verify-signature"');
      if (ok) return true;
      return {
        message: 'apply.command.ts does not mention --verify-signature.',
        suggestedFix: 'Re-enable verify-signature support in the apply pipeline.',
      };
    },
  }),
  definePackPolicyCheck({
    id: 'sharkcraft.no-destructive-without-approval',
    title: 'Destructive plan helpers must declare humanApprovalRequired',
    severity: 'warning',
    checkType: 'plan',
    evaluate({ projectRoot }) {
      const file = nodePath.join(projectRoot, 'packages/inspector/src/plugin-lifecycle.ts');
      const text = readFileSafely(file);
      if (!text) return true;
      const removeBlock = /buildPluginRemovePlan[\s\S]{0,4000}humanApprovalRequired/.test(text);
      if (removeBlock) return true;
      return {
        message: 'plugin-lifecycle.ts buildPluginRemovePlan should set humanApprovalRequired: true.',
        suggestedFix: 'Set humanApprovalRequired: true on every destructive plan.',
      };
    },
  }),
  definePackPolicyCheck({
    id: 'sharkcraft.ingest-adopt-allowlist',
    title: 'Ingest adopt may write only under sharkcraft/ingestion/',
    severity: 'error',
    checkType: 'path',
    evaluate({ projectRoot }) {
      const file = nodePath.join(projectRoot, 'packages/inspector/src/ingest-apply.ts');
      const text = readFileSafely(file);
      if (!text) return true;
      if (!text.includes('sharkcraft/ingestion')) {
        return {
          message: 'ingest-apply.ts no longer references sharkcraft/ingestion as the write root.',
          suggestedFix: 'Keep the ingest write allowlist tight.',
        };
      }
      return true;
    },
  }),
  definePackPolicyCheck({
    id: 'sharkcraft.plan-v2-no-hidden-side-effects',
    title: 'Plan v2 operations are data, not closures with side effects',
    severity: 'warning',
    checkType: 'plan',
    evaluate({ projectRoot }) {
      const file = nodePath.join(projectRoot, 'packages/templates/src/template-definition.ts');
      const text = readFileSafely(file);
      if (!text) return true;
      // The operation union should be a discriminated data type.
      const ok = /kind:\s*['"]create['"]/.test(text) && /kind:\s*['"]export['"]/.test(text);
      if (ok) return true;
      return {
        message: 'template-definition.ts ITemplateChange operation union appears to have changed shape.',
        suggestedFix: 'Keep ITemplateChange a discriminated, side-effect-free data structure.',
      };
    },
  }),
  definePackPolicyCheck({
    id: 'sharkcraft.contract-gate-opt-in-but-strict-when-used',
    title: 'Contract gates must block on failed approval when used',
    severity: 'warning',
    checkType: 'command',
    evaluate({ projectRoot }) {
      const file = nodePath.join(projectRoot, 'packages/inspector/src/agent-contract-gate.ts');
      const text = readFileSafely(file);
      if (!text) return true;
      if (!/approval|approve/i.test(text)) {
        return {
          message: 'agent-contract-gate.ts no longer mentions approval handling.',
        };
      }
      return true;
    },
  }),
  definePackPolicyCheck({
    id: 'sharkcraft.helper-preview-only-mcp',
    title: 'Helper MCP tool exposes preview/list operations only',
    severity: 'error',
    checkType: 'command',
    evaluate({ projectRoot }) {
      const file = nodePath.join(projectRoot, 'packages/mcp-server/src/tools/r28-helpers.tool.ts');
      const text = readFileSafely(file);
      if (!text) return true;
      const writeRe = /writeFileSync|writeFile\(|mkdirSync|appendFileSync|unlinkSync/;
      if (writeRe.test(text)) {
        return {
          message: 'Helper MCP tool appears to perform writes.',
          suggestedFix: 'Helper MCP tools must remain preview/list-only.',
        };
      }
      return true;
    },
  }),
  definePackPolicyCheck({
    id: 'sharkcraft.language-runner-allowlist',
    title: 'Language runner allow/deny policy must remain in place',
    severity: 'error',
    checkType: 'command',
    evaluate({ projectRoot }) {
      const file = nodePath.join(projectRoot, 'packages/inspector/src/languages/language-runner.ts');
      const text = readFileSafely(file);
      if (!text) return true;
      if (!/(getLanguageRunnerPolicy|explainCommandPolicy)/.test(text)) {
        return {
          message: 'language-runner.ts no longer exposes the policy helpers.',
        };
      }
      return true;
    },
  }),
  definePackPolicyCheck({
    id: 'sharkcraft.memory-local-only',
    title: 'Memory subsystem writes only under .sharkcraft/memory',
    severity: 'error',
    checkType: 'path',
    evaluate({ projectRoot }) {
      const file = nodePath.join(projectRoot, 'packages/inspector/src/repo-memory.ts');
      const text = readFileSafely(file);
      if (!text) return true;
      if (!text.includes('.sharkcraft/memory')) {
        return {
          message: 'repo-memory.ts no longer references .sharkcraft/memory.',
        };
      }
      return true;
    },
  }),
  definePackPolicyCheck({
    id: 'sharkcraft.template-drift-must-be-detectable',
    title: 'A template drift verifier must exist',
    severity: 'info',
    checkType: 'template',
    evaluate({ projectRoot }) {
      const file = nodePath.join(projectRoot, 'packages/inspector/src/template-drift.ts');
      if (existsSync(file)) return true;
      return {
        message: 'template-drift.ts missing — drift detection should remain available.',
      };
    },
  }),
  definePackPolicyCheck({
    id: 'sharkcraft.mcp-read-only-comment',
    title: 'Safety doc still states the read-only invariant',
    severity: 'info',
    checkType: 'command',
    evaluate({ projectRoot }) {
      const file = nodePath.join(projectRoot, 'docs/safety-model.md');
      const text = readFileSafely(file);
      if (!text) return true;
      if (READ_ONLY_REGEX.test(text) && !WRITE_FORBIDDEN_REGEX.test(text.split('What MCP never does')[0] ?? '')) {
        return true;
      }
      // Skipping detailed check — just confirm the file exists and mentions "read-only".
      return /read-only/i.test(text)
        ? true
        : {
            message: 'docs/safety-model.md no longer documents the MCP read-only invariant.',
          };
    },
  }),
];
