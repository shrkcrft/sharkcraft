import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IToolDefinition } from '../server/tool-definition.ts';

/**
 * `plan_quality_review` — score a plan blob for hallucination,
 * generic boilerplate, contradictions, and ungrounded commands.
 *
 * Inputs:
 *   - `plan`: either a stringified JSON / Markdown plan body, OR a
 *     `{ from: { slug } }` reference that resolves to a saved
 *     `.sharkcraft/smart-context/<slug>.plan.json`.
 *   - `recommendedCommands` (optional): the set of commands that are
 *     considered "real" (typically `verificationCommands` from the
 *     same focused bundle). Anything outside this set in
 *     `firstCommands`/`validationCommands` gets flagged.
 *
 * Output: structured findings + an overall verdict so the calling
 * agent can decide whether to use, retry, or reject the plan.
 *
 * Read-only — does not modify or rewrite the plan.
 */
export const planQualityReviewTool: IToolDefinition = {
  name: 'plan_quality_review',
  description:
    'Critique a plan (JSON or Markdown) for hallucinated paths, generic boilerplate, contradictions, and ungrounded commands. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      plan: { type: 'string' },
      planFrom: { type: 'object' },
      recommendedCommands: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    let planText: string | undefined;
    const planFrom = input['planFrom'];
    if (typeof input['plan'] === 'string' && (input['plan'] as string).length > 0) {
      planText = input['plan'] as string;
    } else if (planFrom && typeof planFrom === 'object') {
      const slug =
        typeof (planFrom as Record<string, unknown>)['slug'] === 'string'
          ? ((planFrom as Record<string, unknown>)['slug'] as string)
          : '';
      if (slug.length === 0) {
        return { data: { error: 'planFrom.slug is required when using planFrom' } };
      }
      const path = nodePath.join(ctx.cwd, '.sharkcraft', 'smart-context', `${slug}.plan.json`);
      if (!existsSync(path)) {
        return { data: { error: 'no-plan-for-slug', slug, lookedAt: path } };
      }
      try {
        const { readFileSync } = await import('node:fs');
        planText = readFileSync(path, 'utf8');
      } catch (e) {
        return { data: { error: `read failed: ${(e as Error).message}` } };
      }
    } else {
      return { data: { error: 'one of `plan` or `planFrom` is required' } };
    }
    if (!planText) return { data: { error: 'empty plan' } };

    const parsed = tryExtractJson(planText);
    const recommendedCommandsRaw = Array.isArray(input['recommendedCommands'])
      ? (input['recommendedCommands'] as unknown[]).filter((c): c is string => typeof c === 'string')
      : [];
    const knownCommands = new Set(recommendedCommandsRaw.map(normaliseCommand));

    const findings = analysePlan({
      cwd: ctx.cwd,
      raw: planText,
      parsed,
      knownCommands,
    });

    const score = scoreFindings(findings);
    const verdict =
      score >= 0.85
        ? 'good'
        : score >= 0.6
          ? 'usable-with-review'
          : score >= 0.35
            ? 'weak'
            : 'reject';

    return {
      data: {
        verdict,
        score,
        parsed: parsed !== null,
        findings,
        handoffForClaude:
          verdict === 'reject'
            ? 'Reject this plan — too many ungrounded claims.'
            : verdict === 'weak'
              ? 'Plan is weak; consider regenerating with --polish or a stronger model.'
              : verdict === 'usable-with-review'
                ? 'Plan is usable but verify the flagged paths and commands.'
                : 'Plan looks well-grounded.',
      },
    };
  },
};

interface IFinding {
  category: 'hallucinated-path' | 'generic-boilerplate' | 'contradiction' | 'ungrounded-command' | 'missing-section';
  severity: 'low' | 'medium' | 'high';
  message: string;
  where?: string;
}

interface IAnalysisInput {
  cwd: string;
  raw: string;
  parsed: Record<string, unknown> | null;
  knownCommands: Set<string>;
}

function analysePlan(input: IAnalysisInput): IFinding[] {
  const out: IFinding[] = [];

  // 1. Hallucinated paths — walk the parsed JSON.
  if (input.parsed) {
    const seen = new Set<string>();
    walkPathLeaves(input.parsed, '$', (path, where) => {
      const id = `${where}:${path}`;
      if (seen.has(id)) return;
      seen.add(id);
      if (!looksLikePathRef(path)) return;
      if (!pathExistsInWorkspace(input.cwd, path)) {
        out.push({
          category: 'hallucinated-path',
          severity: 'high',
          message: `Path "${path}" does not exist in the workspace.`,
          where,
        });
      }
    });
  }

  // 2. Generic boilerplate (the polish preamble's anti-patterns).
  const genericPatterns: Array<{ re: RegExp; msg: string }> = [
    { re: /may require additional resources and infrastructure/i, msg: 'Generic "additional resources" boilerplate.' },
    { re: /may introduce additional complexity/i, msg: 'Generic "additional complexity" boilerplate.' },
    { re: /may require additional security and privacy considerations/i, msg: 'Generic "security and privacy" boilerplate.' },
    { re: /can be implemented as a separate tool or as a plugin/i, msg: '"Can be implemented as a separate tool" — useless differentiation.' },
    { re: /documentation and support level/i, msg: 'Enterprise-boilerplate question about "documentation and support level".' },
    { re: /\bGET\b.*\b(cli|file|stdout|mcp)/i, msg: 'HTTP verb on a CLI/file/stdout/MCP surface.' },
  ];
  for (const p of genericPatterns) {
    if (p.re.test(input.raw)) {
      out.push({ category: 'generic-boilerplate', severity: 'medium', message: p.msg });
    }
  }

  // 3. Contradictions: filesToAvoid ∩ likelyFilesToModify.
  if (input.parsed) {
    const avoid = collectPathSet(input.parsed['filesToAvoid']);
    const modify = collectPathSet(input.parsed['likelyFilesToModify']);
    const overlap = [...avoid].filter((p) => modify.has(p));
    for (const p of overlap) {
      out.push({
        category: 'contradiction',
        severity: 'high',
        message: `"${p}" appears in both filesToAvoid and likelyFilesToModify.`,
      });
    }
  }

  // 4. Ungrounded commands.
  if (input.parsed && input.knownCommands.size > 0) {
    const firstCmds = collectStringArrayFromKey(input.parsed['firstCommands'], 'command');
    const valCmds = collectStringArrayFromKey(input.parsed['validationCommands'], 'command');
    const plainVal = collectStringArray(input.parsed['validationCommands']);
    const all = new Set<string>([...firstCmds, ...valCmds, ...plainVal].map(normaliseCommand));
    for (const c of all) {
      if (c.length === 0) continue;
      // Don't flag commands that obviously start with `git` or `bun x tsc` —
      // those are universal even when the rule registry doesn't list them.
      if (/^(git|bun\s+x\s+tsc|npm|pnpm|yarn)\b/.test(c)) continue;
      if (!input.knownCommands.has(c)) {
        out.push({
          category: 'ungrounded-command',
          severity: 'low',
          message: `Command "${c}" is not in the supplied recommendedCommands.`,
        });
      }
    }
  }

  // 5. Missing-section heuristic for arch-plan shapes.
  if (input.parsed) {
    if ('candidateArchitectures' in input.parsed) {
      // architecture mode — recommendedMvp + firstSpike are required.
      if (!input.parsed['recommendedMvp']) {
        out.push({
          category: 'missing-section',
          severity: 'medium',
          message: 'architecture plan is missing recommendedMvp.',
        });
      }
      if (!input.parsed['firstSpike']) {
        out.push({
          category: 'missing-section',
          severity: 'medium',
          message: 'architecture plan is missing firstSpike.',
        });
      }
    }
  }

  return out;
}

function scoreFindings(findings: readonly IFinding[]): number {
  if (findings.length === 0) return 1;
  let penalty = 0;
  for (const f of findings) {
    penalty += f.severity === 'high' ? 0.2 : f.severity === 'medium' ? 0.08 : 0.03;
  }
  return Math.max(0, 1 - penalty);
}

function walkPathLeaves(
  value: unknown,
  where: string,
  visit: (path: string, where: string) => void,
): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) walkPathLeaves(value[i], `${where}[${i}]`, visit);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const rec = value as Record<string, unknown>;
  for (const k of Object.keys(rec)) {
    if (k === 'path' && typeof rec[k] === 'string') {
      visit(rec[k] as string, `${where}.${k}`);
      continue;
    }
    walkPathLeaves(rec[k], `${where}.${k}`, visit);
  }
}

function collectPathSet(value: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    if (item && typeof item === 'object' && typeof (item as Record<string, unknown>)['path'] === 'string') {
      out.add(((item as Record<string, unknown>)['path'] as string).trim());
    }
  }
  return out;
}

function collectStringArrayFromKey(value: unknown, key: string): string[] {
  const out: string[] = [];
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    if (item && typeof item === 'object' && typeof (item as Record<string, unknown>)[key] === 'string') {
      out.push(((item as Record<string, unknown>)[key] as string).trim());
    }
  }
  return out;
}

function collectStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).filter((s): s is string => typeof s === 'string');
}

function looksLikePathRef(s: string): boolean {
  if (s.length === 0) return false;
  if (/[<>{}]/.test(s)) return false;
  if (s.includes('/')) return true;
  return /\.(ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|css|html)$/.test(s);
}

function pathExistsInWorkspace(cwd: string, candidate: string): boolean {
  const normalised = candidate.replace(/\\/g, '/').replace(/^\.\//, '');
  const abs = nodePath.isAbsolute(normalised) ? normalised : nodePath.join(cwd, normalised);
  try {
    return existsSync(abs);
  } catch {
    return false;
  }
}

function normaliseCommand(c: string): string {
  return c.trim().replace(/\s+/g, ' ');
}

function tryExtractJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Try balanced extraction
  }
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      const parsed = JSON.parse(candidate.slice(first, last + 1));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore
    }
  }
  return null;
}
