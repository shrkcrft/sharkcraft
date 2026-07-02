import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex, GraphStore } from '@shrkcrft/graph';
import {
  smartContextCommand,
  smartContextListCommand,
  smartContextPlanAheadCommand,
  smartContextShowCommand,
} from '../commands/smart-context.command.ts';
import type { ParsedArgs } from '../command-registry.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const DOGFOOD = join(REPO_ROOT, 'examples/dogfood-target');
const ORIGINAL_FETCH = globalThis.fetch;

// Disable auto-refresh + plan-cache in tests; otherwise running against
// REPO_ROOT would try to load the real embedding model and OOM Bun.
process.env.SHRK_DISABLE_AUTO_AI = '1';

// Stage-1 file briefs — and therefore the export-signature lines the
// "enriched seed" suite asserts on — are only emitted when the code graph
// index exists. That index lives under the gitignored `.sharkcraft/graph/`,
// so a fresh CI checkout has none (a dev machine usually does from prior
// runs). Build it once here so the assertions are deterministic in CI and
// locally alike. `buildFullIndex` persists the snapshot under REPO_ROOT.
beforeAll(() => {
  if (!new GraphStore(REPO_ROOT).exists()) {
    buildFullIndex({ projectRoot: REPO_ROOT });
  }
}, 120_000);

const writeOut = process.stdout.write.bind(process.stdout);
const writeErr = process.stderr.write.bind(process.stderr);

async function captureStdio<T>(
  fn: () => T | Promise<T>,
): Promise<{ value: T; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  (process.stdout.write as unknown as (s: string) => boolean) = ((s: string) => {
    stdout += s;
    return true;
  }) as never;
  (process.stderr.write as unknown as (s: string) => boolean) = ((s: string) => {
    stderr += s;
    return true;
  }) as never;
  try {
    const value = await Promise.resolve(fn());
    return { value, stdout, stderr };
  } finally {
    process.stdout.write = writeOut as never;
    process.stderr.write = writeErr as never;
  }
}

function makeArgs(positional: string[], flags: Array<[string, string | boolean]>): ParsedArgs {
  return {
    positional,
    flags: new Map<string, string | boolean>(flags),
    multiFlags: new Map<string, string[]>(),
  };
}

const ORIGINAL_KEY = process.env.GEMINI_API_KEY;
const ORIGINAL_AI_PROVIDER = process.env.AI_PROVIDER;
const ORIGINAL_OLLAMA_HOST = process.env.OLLAMA_HOST;

beforeEach(() => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.AI_PROVIDER;
  delete process.env.OLLAMA_HOST;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_KEY === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = ORIGINAL_KEY;
  if (ORIGINAL_AI_PROVIDER === undefined) delete process.env.AI_PROVIDER;
  else process.env.AI_PROVIDER = ORIGINAL_AI_PROVIDER;
  if (ORIGINAL_OLLAMA_HOST === undefined) delete process.env.OLLAMA_HOST;
  else process.env.OLLAMA_HOST = ORIGINAL_OLLAMA_HOST;
  delete process.env.ANTHROPIC_API_KEY;
});

describe('shrk smart-context — argument handling', () => {
  test('exits 2 with usage when no task is supplied', async () => {
    const { value, stderr } = await captureStdio(() =>
      smartContextCommand.run(makeArgs([], [])),
    );
    expect(value).toBe(2);
    expect(stderr).toContain('Usage: shrk smart-context');
  });

  test('exits 1 with actionable message when GEMINI_API_KEY is missing and not --dry-run', async () => {
    const { value, stderr } = await captureStdio(() =>
      smartContextCommand.run(
        makeArgs(['add', 'a', 'new', 'CLI', 'command'], [
          ['cwd', DOGFOOD],
          ['provider', 'gemini'],
        ]),
      ),
    );
    expect(value).toBe(1);
    // The explicit `--provider gemini` branch still surfaces a
    // descriptive error so legacy callers don't get a generic message —
    // hosted providers are deprecated but the path still routes to a
    // clear "key missing" message.
    expect(stderr).toMatch(/GEMINI_API_KEY|deprecated/);
  });
});

describe('shrk smart-context — enriched seed', () => {
  test('accepts the documented --task flag as well as the positional form', async () => {
    // No positional; the task is supplied via --task. Must build a brief (exit 0),
    // not hit the "Usage" guard (exit 2).
    const { value, stdout } = await captureStdio(() =>
      smartContextCommand.run(
        makeArgs([], [
          ['cwd', REPO_ROOT],
          ['task', 'improve the smart-context command'],
          ['dry-run', true],
          ['no-instructions', true],
        ]),
      ),
    );
    expect(value).toBe(0);
    expect(stdout).toContain('STRICT GROUNDING');
  });

  test('dry-run brief includes graph candidates, verification commands, and stricter system prompt', async () => {
    const { value, stdout } = await captureStdio(() =>
      smartContextCommand.run(
        makeArgs(['improve', 'smart-context', 'command'], [
          ['cwd', REPO_ROOT],
          ['dry-run', true],
          ['no-instructions', true],
        ]),
      ),
    );
    expect(value).toBe(0);
    expect(stdout).toContain('STRICT GROUNDING');
    expect(stdout).toContain('Candidate code (graph-ranked');
  });

  test('stage 1 includes Documentation hits and export signatures', async () => {
    const { value, stdout } = await captureStdio(() =>
      smartContextCommand.run(
        makeArgs(['improve', 'smart-context', 'planning'], [
          ['cwd', REPO_ROOT],
          ['dry-run', true],
          ['ai-plan', true],
          ['no-instructions', true],
        ]),
      ),
    );
    expect(value).toBe(0);
    expect(stdout).toContain('Documentation hits (keyword-grep');
    // At least one signature line should accompany the briefs for the top
    // candidate file (signatures: header is only emitted when ≥1 was extracted).
    expect(stdout).toContain('signatures:');
  });

  test('stage 1 prompt (ai-plan dry-run) carries per-file briefs with rich metadata', async () => {
    const { value, stdout } = await captureStdio(() =>
      smartContextCommand.run(
        makeArgs(['improve', 'smart-context', 'planning'], [
          ['cwd', REPO_ROOT],
          ['dry-run', true],
          ['ai-plan', true],
          ['no-instructions', true],
        ]),
      ),
    );
    expect(value).toBe(0);
    expect(stdout).toContain('Candidate file briefs (task-ranked');
    // At least one of the structured-evidence fields must show up — which one
    // depends on what the top-ranked candidate file actually has.
    const hasStructuredEvidence =
      stdout.includes('summary:') ||
      stdout.includes('exports:') ||
      stdout.includes('imports:') ||
      stdout.includes('imported by:');
    expect(hasStructuredEvidence).toBe(true);
    expect(stdout).toContain('PRIMARY SIGNAL');
  });

  test('--log-prompt dumps the full messages array to stderr for inspection', async () => {
    const { value, stderr } = await captureStdio(() =>
      smartContextCommand.run(
        makeArgs(['add', 'a', 'new', 'doctor', 'check'], [
          ['cwd', REPO_ROOT],
          ['dry-run', true],
          ['log-prompt', true],
          ['no-instructions', true],
        ]),
      ),
    );
    expect(value).toBe(0);
    expect(stderr).toContain('[smart-context] prompt log (brief)');
    expect(stderr).toMatch(/"role":\s*"system"/);
    expect(stderr).toMatch(/"role":\s*"user"/);
  });
});

describe('shrk smart-context — dry-run prompt rendering', () => {
  test('brief mode prints a system+user prompt without calling Gemini', async () => {
    const { value, stdout } = await captureStdio(() =>
      smartContextCommand.run(
        makeArgs(['add', 'a', 'new', 'doctor', 'check'], [
          ['cwd', DOGFOOD],
          ['dry-run', true],
          ['no-instructions', true],
        ]),
      ),
    );
    expect(value).toBe(0);
    expect(stdout).toContain('mode: brief');
    expect(stdout).toContain('[system]');
    expect(stdout).toContain('[user]');
    expect(stdout).toContain('# Task');
    expect(stdout.toLowerCase()).toContain('brief');
  });

  test('plan mode preamble describes the structured JSON plan schema', async () => {
    const { value, stdout } = await captureStdio(() =>
      smartContextCommand.run(
        makeArgs(['add', 'a', 'new', 'pack'], [
          ['cwd', DOGFOOD],
          ['dry-run', true],
          ['plan', true],
          ['no-instructions', true],
        ]),
      ),
    );
    expect(value).toBe(0);
    expect(stdout).toContain('mode: plan');
    expect(stdout).toContain('filesToRead');
    expect(stdout).toContain('relatedRules');
    expect(stdout).toContain('implementationSteps');
  });

  test('ai-plan dry-run shows the two-stage prompt flow', async () => {
    const { value, stdout } = await captureStdio(() =>
      smartContextCommand.run(
        makeArgs(['improve', 'smart-context', 'planning'], [
          ['cwd', DOGFOOD],
          ['dry-run', true],
          ['ai-plan', true],
          ['no-instructions', true],
        ]),
      ),
    );
    expect(value).toBe(0);
    expect(stdout).toContain('AI Plan Dry Run');
    expect(stdout).toContain('Stage 1 prompt');
    expect(stdout).toContain('Stage 2 prompt template');
    expect(stdout).toContain('filesToRead');
    expect(stdout).toContain('likelyTechnicalApproach');
  });
});

describe('shrk smart-context --ai-plan', () => {
  test('falls back to deterministic smart-context when the requested provider has no credentials', async () => {
    // With the new local-first auto chain, ollama is always "ready"
    // structurally so the fallback path is only reachable via an
    // explicit `--provider` that can't engage (e.g. gemini without
    // a key). That's still a real path worth covering.
    const { value, stdout } = await captureStdio(() =>
      smartContextCommand.run(
        makeArgs(['improve', 'smart-context', 'planning'], [
          ['cwd', REPO_ROOT],
          ['ai-plan', true],
          ['json', true],
          ['no-instructions', true],
          ['provider', 'gemini'],
        ]),
      ),
    );
    expect(value).toBe(0);
    const parsed = JSON.parse(stdout) as {
      ai: { provider: string; model: string };
      aiPlan?: { strategy: string; fallbackReason?: string };
      content: string;
      mode: string;
    };
    expect(parsed.mode).toBe('plan');
    expect(parsed.ai.provider).toBe('deterministic');
    expect(parsed.aiPlan?.strategy).toBe('deterministic-fallback');
    expect(parsed.aiPlan?.fallbackReason).toContain('GEMINI_API_KEY');
    expect(parsed.content).toContain('deterministic smart-context only');
  });

  test('returns a validated two-stage plan envelope with mocked Gemini responses', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.AI_PROVIDER = 'gemini';
    let call = 0;
    const capturedBodies: any[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      call += 1;
      capturedBodies.push(JSON.parse(String(init?.body ?? '{}')));
      if (call === 1) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        summary: 'Collect command implementation and tests.',
                        filesToRead: [
                          {
                            target: 'packages/cli/src/commands/smart-context.command.ts',
                            why: 'Current implementation.',
                          },
                        ],
                        similarPatterns: [
                          {
                            target: 'ask.command.ts',
                            why: 'Existing AI-backed sibling command.',
                          },
                        ],
                        publicApiFiles: [
                          {
                            target: 'packages/ai/src/index.ts',
                            why: 'AI provider exports.',
                          },
                        ],
                        testsToInspect: [
                          {
                            target: 'packages/cli/src/__tests__/smart-context-command.test.ts',
                            why: 'Current contract coverage.',
                          },
                        ],
                        architectureRules: [
                          {
                            id: 'repo.architecture.respect-layer-order',
                            why: 'Keep CLI orchestration in the CLI layer.',
                          },
                        ],
                        riskyAreas: ['provider selection drift', 'generic JSON validation'],
                        missingInformation: ['Which provider should be default when multiple keys exist?'],
                      }),
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            modelVersion: 'gemini-2.5-flash',
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      summary: 'Add an opt-in two-stage planning path on top of the existing command.',
                      taskUnderstanding: 'Extend smart-context with an opt-in, richer planning mode.',
                      likelyTechnicalApproach: 'Reuse the deterministic seed, add a Stage 1 expansion request, collect bounded graph-backed context, then ask the provider for a richer plan.',
                      existingPatternsToFollow: [
                        {
                          path: 'packages/cli/src/commands/ask.command.ts',
                          why: 'Existing AI-backed CLI command pattern.',
                        },
                      ],
                      filesToRead: [
                        {
                          path: 'packages/cli/src/commands/smart-context.command.ts',
                          why: 'Primary implementation surface.',
                        },
                      ],
                      likelyFilesToModify: [
                        {
                          path: 'packages/cli/src/commands/smart-context.command.ts',
                          why: 'Command orchestration, prompts, fallback, and envelope output.',
                        },
                        {
                          path: 'packages/ai/src/provider-resolver.ts',
                          why: 'Generic provider selection.',
                        },
                      ],
                      filesToAvoid: [
                        {
                          path: 'packages/mcp-server/src',
                          why: 'This feature is CLI-only and should not change MCP behavior.',
                        },
                      ],
                      publicApiFiles: [
                        {
                          path: 'packages/ai/src/index.ts',
                          why: 'Keep the provider helper exported.',
                        },
                      ],
                      testsToInspect: [
                        {
                          path: 'packages/cli/src/__tests__/smart-context-command.test.ts',
                          why: 'Contract tests for ai-plan, dry-run, and fallback behavior.',
                        },
                      ],
                      architectureConstraints: [
                        'Keep the deterministic retrieval engine unchanged unless ai-plan is explicitly requested.',
                        'Do not introduce autonomous editing or file generation.',
                      ],
                      relatedRules: [
                        {
                          id: 'repo.architecture.respect-layer-order',
                          title: 'Respect the package layer order',
                          applyWhen: 'When wiring provider helpers and CLI orchestration across packages.',
                        },
                      ],
                      relatedTemplates: [],
                      firstCommands: [
                        {
                          command: 'bun test packages/cli/src/__tests__/smart-context-command.test.ts',
                          why: 'Verify the command contract after the change.',
                        },
                      ],
                      implementationSteps: [
                        {
                          step: 'Add option parsing and provider selection',
                          details: 'Keep ai-plan opt-in and preserve existing brief/plan behavior.',
                        },
                      ],
                      risks: ['Schema drift between prompts and validators.'],
                      unknowns: ['Whether plan-ahead should grow ai-plan support later.'],
                      validationCommands: ['bun test packages/cli/src/__tests__/smart-context-command.test.ts'],
                      handoffSummary: 'Claude should verify the staged JSON payloads and keep the mode bounded, opt-in, and read-only.',
                    }),
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
          modelVersion: 'gemini-2.5-flash',
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const { value, stdout } = await captureStdio(() =>
      smartContextCommand.run(
        makeArgs(['improve', 'smart-context', 'planning'], [
          ['cwd', REPO_ROOT],
          ['ai-plan', true],
          ['json', true],
          ['no-instructions', true],
        ]),
      ),
    );
    expect(value).toBe(0);
    const parsed = JSON.parse(stdout) as {
      ai: { provider: string };
      aiPlan?: {
        strategy: string;
        stage1Request?: { filesToRead: Array<{ target: string }> };
        collectedContext?: { selectedFiles: Array<{ path: string }> };
        finalPlan?: { handoffSummary: string; likelyFilesToModify: Array<{ path: string }> };
      };
      content: string;
    };
    expect(call).toBe(2);
    expect(parsed.ai.provider).toBe('gemini');
    expect(parsed.aiPlan?.strategy).toBe('two-stage');
    expect(parsed.aiPlan?.stage1Request?.filesToRead[0]?.target).toContain('smart-context.command.ts');
    expect(parsed.aiPlan?.collectedContext?.selectedFiles.some((f) => f.path.endsWith('smart-context.command.ts'))).toBe(true);
    expect(parsed.aiPlan?.finalPlan?.handoffSummary).toContain('Claude');
    expect(parsed.content).toContain('likelyTechnicalApproach');
    expect(capturedBodies[0]?.contents?.length).toBe(1);
    expect(capturedBodies[0]?.generationConfig?.responseMimeType).toBe('application/json');
    expect(capturedBodies[1]?.generationConfig?.responseMimeType).toBe('application/json');
  });

  test('repairs a truncated JSON response when the structure is otherwise valid', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.AI_PROVIDER = 'gemini';
    let call = 0;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      call += 1;
      void init;
      if (call === 1) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: '{"filesToRead":[{"target":"packages/cli/src/commands/smart-context.command.ts","why":"Primary implementation."}],"similarPatterns":[],"publicApiFiles":[],"testsToInspect":[],"architectureRules":[],"riskyAreas":["provider json mode"],"missingInformation":[]',
                    },
                  ],
                },
              },
            ],
            modelVersion: 'gemini-2.5-flash',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: '{"summary":"Use provider-side JSON mode and preserve fallback behavior.","taskUnderstanding":"Strengthen ai-plan response handling.","likelyTechnicalApproach":"Request JSON explicitly, then validate and recover mild truncation.","existingPatternsToFollow":[],"filesToRead":[{"path":"packages/cli/src/commands/smart-context.command.ts","why":"Main orchestration path."}],"likelyFilesToModify":[{"path":"packages/cli/src/commands/smart-context.command.ts","why":"Parser and provider orchestration."}],"filesToAvoid":[],"publicApiFiles":[],"testsToInspect":[{"path":"packages/cli/src/__tests__/smart-context-command.test.ts","why":"Exercise malformed response handling."}],"architectureConstraints":["Keep ai-plan opt-in."],"relatedRules":[],"relatedTemplates":[],"firstCommands":[],"implementationSteps":[{"step":"Request JSON","details":"Use provider-native JSON mode when available."}],"risks":["Provider-specific output drift."],"unknowns":[],"validationCommands":["bun test packages/cli/src/__tests__/smart-context-command.test.ts"],"handoffSummary":"Claude should trust only schema-valid output."}',
                  },
                ],
              },
            },
          ],
          modelVersion: 'gemini-2.5-flash',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const { value, stdout } = await captureStdio(() =>
      smartContextCommand.run(
        makeArgs(['harden', 'ai-plan', 'json', 'handling'], [
          ['cwd', REPO_ROOT],
          ['ai-plan', true],
          ['json', true],
          ['no-instructions', true],
        ]),
      ),
    );

    expect(value).toBe(0);
    const parsed = JSON.parse(stdout) as {
      aiPlan?: {
        stage1Request?: { filesToRead: Array<{ target: string }> };
        finalPlan?: { summary: string };
      };
    };
    expect(parsed.aiPlan?.stage1Request?.filesToRead[0]?.target).toContain('smart-context.command.ts');
    expect(parsed.aiPlan?.finalPlan?.summary).toContain('JSON mode');
  });
});

describe('shrk smart-context — repository instructions inclusion', () => {
  let tempRepo = '';

  beforeEach(() => {
    tempRepo = mkdtempSync(join(tmpdir(), 'shrk-smart-ctx-instr-'));
    // Minimal SharkCraft fixture — symlink the three packages the inspector
    // needs and a stub sharkcraft.config.ts. Same pattern as quality-drift-safety.test.ts.
    mkdirSync(join(tempRepo, 'sharkcraft', 'node_modules', '@shrkcrft'), { recursive: true });
    for (const [n, t] of [
      ['config', 'packages/config'],
      ['knowledge', 'packages/knowledge'],
      ['templates', 'packages/templates'],
    ] as const) {
      const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
      spawnSync('ln', ['-s', join(REPO_ROOT, t), join(tempRepo, 'sharkcraft', 'node_modules', '@shrkcrft', n)]);
    }
    writeFileSync(join(tempRepo, 'package.json'), JSON.stringify({ name: 'instr-test', version: '0.0.0' }));
    writeFileSync(
      join(tempRepo, 'sharkcraft', 'sharkcraft.config.ts'),
      `export default { projectName: 'instr-test', knowledgeFiles: [], ruleFiles: [], pathFiles: [], templateFiles: [], docsFiles: [] };\n`,
    );
  });

  afterEach(() => {
    rmSync(tempRepo, { recursive: true, force: true });
  });

  test('auto-includes CLAUDE.md content when present', async () => {
    writeFileSync(join(tempRepo, 'CLAUDE.md'), '# Test repo rules\n\nDo X, not Y.\n');
    const { value, stdout } = await captureStdio(() =>
      smartContextCommand.run(
        makeArgs(['refactor', 'the', 'thing'], [
          ['cwd', tempRepo],
          ['dry-run', true],
        ]),
      ),
    );
    expect(value).toBe(0);
    expect(stdout).toContain('Repository instructions (CLAUDE.md)');
    expect(stdout).toContain('Do X, not Y.');
  });

  test('--instructions <path> overrides the CLAUDE.md default', async () => {
    writeFileSync(join(tempRepo, 'CLAUDE.md'), '# WRONG file\n');
    writeFileSync(join(tempRepo, 'CUSTOM-INSTR.md'), '# RIGHT file\n');
    const { value, stdout } = await captureStdio(() =>
      smartContextCommand.run(
        makeArgs(['do', 'the', 'thing'], [
          ['cwd', tempRepo],
          ['dry-run', true],
          ['instructions', 'CUSTOM-INSTR.md'],
        ]),
      ),
    );
    expect(value).toBe(0);
    expect(stdout).toContain('Repository instructions (CUSTOM-INSTR.md)');
    expect(stdout).toContain('RIGHT file');
    expect(stdout).not.toContain('WRONG file');
  });

  test('--no-instructions omits the instructions block entirely', async () => {
    writeFileSync(join(tempRepo, 'CLAUDE.md'), '# DO NOT INCLUDE\n');
    const { value, stdout } = await captureStdio(() =>
      smartContextCommand.run(
        makeArgs(['do', 'the', 'thing'], [
          ['cwd', tempRepo],
          ['dry-run', true],
          ['no-instructions', true],
        ]),
      ),
    );
    expect(value).toBe(0);
    expect(stdout).not.toContain('Repository instructions');
    expect(stdout).not.toContain('DO NOT INCLUDE');
  });

  test('falls back to AGENTS.md when CLAUDE.md is missing', async () => {
    writeFileSync(join(tempRepo, 'AGENTS.md'), '# Agents-specific\n');
    const { value, stdout } = await captureStdio(() =>
      smartContextCommand.run(
        makeArgs(['do', 'the', 'thing'], [
          ['cwd', tempRepo],
          ['dry-run', true],
        ]),
      ),
    );
    expect(value).toBe(0);
    expect(stdout).toContain('AGENTS.md');
    expect(stdout).toContain('Agents-specific');
  });
});

describe('shrk smart-context plan-ahead — argument handling', () => {
  test('exits 2 with usage when no tasks supplied', async () => {
    const { value, stderr } = await captureStdio(() =>
      smartContextPlanAheadCommand.run(makeArgs([], [])),
    );
    expect(value).toBe(2);
    expect(stderr).toContain('plan-ahead');
  });

  test('dry-run prints one prompt block per task in plan mode by default', async () => {
    const { value, stdout } = await captureStdio(() =>
      smartContextPlanAheadCommand.run(
        makeArgs(['task one', 'task two', 'task three'], [
          ['cwd', DOGFOOD],
          ['dry-run', true],
          ['no-instructions', true],
        ]),
      ),
    );
    expect(value).toBe(0);
    expect(stdout).toContain('task one');
    expect(stdout).toContain('task two');
    expect(stdout).toContain('task three');
    // plan-ahead defaults to plan mode → schema keyword should appear.
    expect(stdout).toContain('filesToRead');
  });

  test('--brief flag flips plan-ahead back to brief mode', async () => {
    const { value, stdout } = await captureStdio(() =>
      smartContextPlanAheadCommand.run(
        makeArgs(['task one'], [
          ['cwd', DOGFOOD],
          ['dry-run', true],
          ['brief', true],
          ['no-instructions', true],
        ]),
      ),
    );
    expect(value).toBe(0);
    expect(stdout).not.toContain('filesToRead');
    expect(stdout.toLowerCase()).toContain('brief');
  });
});

describe('shrk smart-context list/show — saved-entry round-trip', () => {
  let tempRepo = '';

  beforeEach(() => {
    tempRepo = mkdtempSync(join(tmpdir(), 'shrk-smart-ctx-saved-'));
  });

  afterEach(() => {
    rmSync(tempRepo, { recursive: true, force: true });
  });

  test('list prints a friendly message when nothing is saved', async () => {
    const { value, stdout } = await captureStdio(() =>
      smartContextListCommand.run(makeArgs([], [['cwd', tempRepo]])),
    );
    expect(value).toBe(0);
    expect(stdout.toLowerCase()).toContain('no saved');
  });

  test('list --json on an empty repo returns { entries: [] }', async () => {
    const { value, stdout } = await captureStdio(() =>
      smartContextListCommand.run(makeArgs([], [['cwd', tempRepo], ['json', true]])),
    );
    expect(value).toBe(0);
    const parsed = JSON.parse(stdout) as { entries: unknown[] };
    expect(parsed.entries).toEqual([]);
  });

  test('list picks up a manually-written envelope and show prints it', async () => {
    const dir = join(tempRepo, '.sharkcraft', 'smart-context');
    mkdirSync(dir, { recursive: true });
    const envelope = {
      task: 'add new doctor check',
      mode: 'plan' as const,
      savedAt: '2026-05-24T10:00:00.000Z',
      ai: { provider: 'gemini', model: 'gemini-2.5-flash', finishReason: null, usage: null },
      deterministic: {
        repoInstructionsPath: 'CLAUDE.md',
        relevantRules: [],
        relevantPaths: [],
        relevantTemplates: [],
        recommendedCommands: [],
      },
      content: '## Test plan body',
    };
    const base = 'add-new-doctor-check-plan';
    writeFileSync(join(dir, `${base}.json`), JSON.stringify(envelope), 'utf8');
    writeFileSync(join(dir, `${base}.md`), '# Plan — add new doctor check\n\n## Test plan body\n', 'utf8');

    const listResult = await captureStdio(() =>
      smartContextListCommand.run(makeArgs([], [['cwd', tempRepo]])),
    );
    expect(listResult.value).toBe(0);
    expect(listResult.stdout).toContain(base);
    expect(listResult.stdout).toContain('plan');
    expect(listResult.stdout).toContain('add new doctor check');

    const showResult = await captureStdio(() =>
      smartContextShowCommand.run(makeArgs([base], [['cwd', tempRepo]])),
    );
    expect(showResult.value).toBe(0);
    expect(showResult.stdout).toContain('Test plan body');

    const showJson = await captureStdio(() =>
      smartContextShowCommand.run(makeArgs([base], [['cwd', tempRepo], ['json', true]])),
    );
    expect(showJson.value).toBe(0);
    const parsed = JSON.parse(showJson.stdout) as { task: string; mode: string };
    expect(parsed.task).toBe('add new doctor check');
    expect(parsed.mode).toBe('plan');
  });

  test('show with unknown slug exits 1 with a helpful pointer', async () => {
    const { value, stderr } = await captureStdio(() =>
      smartContextShowCommand.run(makeArgs(['no-such-slug'], [['cwd', tempRepo]])),
    );
    expect(value).toBe(1);
    expect(stderr).toContain('no-such-slug');
    expect(stderr).toContain('smart-context list');
  });
});

describe('shrk smart-context --ai-plan — Ollama hardening', () => {
  function geminiResponse(text: string, status = 200): Response {
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text }] },
            finishReason: 'STOP',
          },
        ],
        modelVersion: 'gemini-2.5-flash',
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 },
      }),
      { status, headers: { 'content-type': 'application/json' } },
    );
  }

  function validStage1JSON(): string {
    return JSON.stringify({
      filesToRead: [
        {
          target: 'packages/cli/src/commands/smart-context.command.ts',
          why: 'primary implementation',
        },
      ],
      similarPatterns: [],
      publicApiFiles: [],
      testsToInspect: [],
      architectureRules: [],
      riskyAreas: [],
      missingInformation: [],
    });
  }

  function validStage2JSON(extraPaths: string[] = []): string {
    const filesToRead = [
      {
        path: 'packages/cli/src/commands/smart-context.command.ts',
        why: 'primary implementation',
      },
      ...extraPaths.map((p) => ({ path: p, why: 'model invented this' })),
    ];
    return JSON.stringify({
      summary: 's',
      taskUnderstanding: 'u',
      likelyTechnicalApproach: 'a',
      existingPatternsToFollow: [],
      filesToRead,
      likelyFilesToModify: [],
      filesToAvoid: [],
      publicApiFiles: [],
      testsToInspect: [],
      architectureConstraints: [],
      relatedRules: [],
      relatedTemplates: [],
      firstCommands: [],
      implementationSteps: [],
      risks: [],
      unknowns: [],
      validationCommands: [],
      handoffSummary: 'h',
    });
  }

  test('retries stage 1 once on bad JSON and recovers', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.AI_PROVIDER = 'gemini';
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 1) return geminiResponse('not json at all');
      if (call === 2) return geminiResponse(validStage1JSON());
      return geminiResponse(validStage2JSON());
    }) as unknown as typeof fetch;

    const { value, stdout, stderr } = await captureStdio(() =>
      smartContextCommand.run(
        makeArgs(['improve', 'smart-context'], [
          ['cwd', REPO_ROOT],
          ['ai-plan', true],
          ['json', true],
          ['no-instructions', true],
        ]),
      ),
    );
    expect(value).toBe(0);
    expect(call).toBe(3);
    const parsed = JSON.parse(stdout) as {
      aiPlan?: { stage1Retried?: boolean; stage1Degraded?: boolean };
    };
    expect(parsed.aiPlan?.stage1Retried).toBe(true);
    expect(parsed.aiPlan?.stage1Degraded).toBeFalsy();
    void stderr;
  });

  test('degrades to empty expansion when stage 1 stays bad after retry', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.AI_PROVIDER = 'gemini';
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      if (call <= 2) return geminiResponse('still not json');
      return geminiResponse(validStage2JSON());
    }) as unknown as typeof fetch;

    const { value, stdout } = await captureStdio(() =>
      smartContextCommand.run(
        makeArgs(['improve', 'smart-context'], [
          ['cwd', REPO_ROOT],
          ['ai-plan', true],
          ['json', true],
          ['no-instructions', true],
        ]),
      ),
    );
    expect(value).toBe(0);
    expect(call).toBe(3);
    const parsed = JSON.parse(stdout) as {
      aiPlan?: {
        stage1Retried?: boolean;
        stage1Degraded?: boolean;
        warnings?: string[];
        stage1Request?: { filesToRead: unknown[] };
      };
    };
    expect(parsed.aiPlan?.stage1Retried).toBe(true);
    expect(parsed.aiPlan?.stage1Degraded).toBe(true);
    expect(parsed.aiPlan?.stage1Request?.filesToRead).toEqual([]);
    expect(parsed.aiPlan?.warnings?.[0]).toContain('Stage 1');
  });

  test('surfaces stage-2 parse failures after retry', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.AI_PROVIDER = 'gemini';
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 1) return geminiResponse(validStage1JSON());
      return geminiResponse('definitely not json');
    }) as unknown as typeof fetch;

    const { value, stderr } = await captureStdio(() =>
      smartContextCommand.run(
        makeArgs(['improve', 'smart-context'], [
          ['cwd', REPO_ROOT],
          ['ai-plan', true],
          ['no-instructions', true],
        ]),
      ),
    );
    expect(value).toBe(1);
    expect(call).toBe(3);
    expect(stderr).toContain('JSON');
  });

  test('flags invented paths in plan as unverifiedPaths', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.AI_PROVIDER = 'gemini';
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 1) return geminiResponse(validStage1JSON());
      return geminiResponse(validStage2JSON(['packages/imaginary/does-not-exist.ts']));
    }) as unknown as typeof fetch;

    const { value, stdout, stderr } = await captureStdio(() =>
      smartContextCommand.run(
        makeArgs(['improve', 'smart-context'], [
          ['cwd', REPO_ROOT],
          ['ai-plan', true],
          ['json', true],
          ['no-instructions', true],
        ]),
      ),
    );
    expect(value).toBe(0);
    const parsed = JSON.parse(stdout) as {
      aiPlan?: { unverifiedPaths?: Array<{ path: string; where: string }> };
    };
    expect(parsed.aiPlan?.unverifiedPaths?.length).toBeGreaterThan(0);
    expect(parsed.aiPlan?.unverifiedPaths?.[0]?.path).toBe('packages/imaginary/does-not-exist.ts');
    void stderr;
  });

  test('--save-conversation writes a conversation file with both prompts and LLM responses (ai-plan)', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.AI_PROVIDER = 'gemini';
    const tempRepo = mkdtempSync(join(tmpdir(), 'shrk-smart-context-conv-'));
    try {
      writeFileSync(
        join(tempRepo, 'package.json'),
        JSON.stringify({ name: 'tmp', version: '0.0.0' }),
        'utf8',
      );
      let call = 0;
      globalThis.fetch = (async () => {
        call += 1;
        if (call === 1) return geminiResponse(validStage1JSON());
        return geminiResponse(validStage2JSON());
      }) as unknown as typeof fetch;

      const { value } = await captureStdio(() =>
        smartContextCommand.run(
          makeArgs(['improve', 'smart-context', 'planning'], [
            ['cwd', tempRepo],
            ['ai-plan', true],
            ['save-conversation', true],
            ['no-instructions', true],
          ]),
        ),
      );
      expect(value).toBe(0);
      const convPath = join(
        tempRepo,
        '.sharkcraft',
        'smart-context',
        'improve-smart-context-planning-plan.conversation.json',
      );
      expect(existsSync(convPath)).toBe(true);
      const conv = JSON.parse(readFileSync(convPath, 'utf8')) as {
        task: string;
        provider: string;
        turns: Array<{
          stage: string;
          request: { messages: Array<{ role: string; content: string }> };
          response: { content: string; model: string };
        }>;
      };
      expect(conv.task).toContain('improve smart-context planning');
      expect(conv.provider).toBe('gemini');
      expect(conv.turns.length).toBe(2);
      expect(conv.turns[0]?.stage).toBe('stage1');
      expect(conv.turns[1]?.stage).toBe('stage2');
      expect(conv.turns[0]?.request.messages.length).toBeGreaterThan(0);
      expect(conv.turns[0]?.response.content).toContain('filesToRead');
      expect(conv.turns[1]?.response.content).toContain('handoffSummary');
    } finally {
      rmSync(tempRepo, { recursive: true, force: true });
    }
  });

  test('--save-conversation still writes when stage 2 parses fail after retry', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.AI_PROVIDER = 'gemini';
    const tempRepo = mkdtempSync(join(tmpdir(), 'shrk-smart-context-conv-fail-'));
    try {
      writeFileSync(
        join(tempRepo, 'package.json'),
        JSON.stringify({ name: 'tmp', version: '0.0.0' }),
        'utf8',
      );
      let call = 0;
      globalThis.fetch = (async () => {
        call += 1;
        if (call === 1) return geminiResponse(validStage1JSON());
        return geminiResponse('definitely not json');
      }) as unknown as typeof fetch;

      const { value } = await captureStdio(() =>
        smartContextCommand.run(
          makeArgs(['improve', 'smart-context'], [
            ['cwd', tempRepo],
            ['ai-plan', true],
            ['save-conversation', true],
            ['no-instructions', true],
          ]),
        ),
      );
      expect(value).toBe(1);
      const convPath = join(
        tempRepo,
        '.sharkcraft',
        'smart-context',
        'improve-smart-context-plan.conversation.json',
      );
      expect(existsSync(convPath)).toBe(true);
      const conv = JSON.parse(readFileSync(convPath, 'utf8')) as {
        turns: Array<{ stage: string; response: { content: string; parseFailed?: boolean } }>;
      };
      expect(conv.turns.length).toBe(2);
      expect(conv.turns[1]?.stage).toBe('stage2');
      expect(conv.turns[1]?.response.parseFailed).toBe(true);
    } finally {
      rmSync(tempRepo, { recursive: true, force: true });
    }
  });

  test('--save-conversation=<path> honours a custom output path (single mode)', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.AI_PROVIDER = 'gemini';
    const tempRepo = mkdtempSync(join(tmpdir(), 'shrk-smart-context-conv-path-'));
    try {
      writeFileSync(
        join(tempRepo, 'package.json'),
        JSON.stringify({ name: 'tmp', version: '0.0.0' }),
        'utf8',
      );
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'brief body' }] }, finishReason: 'STOP' }],
            modelVersion: 'gemini-2.5-flash',
            usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof fetch;
      const customPath = join(tempRepo, 'custom-conv.json');

      const { value } = await captureStdio(() =>
        smartContextCommand.run(
          makeArgs(['debug', 'smart-context'], [
            ['cwd', tempRepo],
            ['save-conversation', customPath],
            ['no-instructions', true],
            // Pipeline is on by default in brief mode; this test
            // asserts the single-shot transcript shape, so opt out.
            ['no-enhance', true],
          ]),
        ),
      );
      expect(value).toBe(0);
      expect(existsSync(customPath)).toBe(true);
      const conv = JSON.parse(readFileSync(customPath, 'utf8')) as {
        turns: Array<{ stage: string; response: { content: string } }>;
      };
      expect(conv.turns.length).toBe(1);
      expect(conv.turns[0]?.stage).toBe('single');
      expect(conv.turns[0]?.response.content).toBe('brief body');
    } finally {
      rmSync(tempRepo, { recursive: true, force: true });
    }
  });

  test('persists raw responses to .raw.json next to the saved envelope', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.AI_PROVIDER = 'gemini';
    const tempRepo = mkdtempSync(join(tmpdir(), 'shrk-smart-context-raw-'));
    try {
      writeFileSync(
        join(tempRepo, 'package.json'),
        JSON.stringify({ name: 'tmp', version: '0.0.0' }),
        'utf8',
      );
      let call = 0;
      globalThis.fetch = (async () => {
        call += 1;
        if (call === 1) return geminiResponse(validStage1JSON());
        return geminiResponse(validStage2JSON());
      }) as unknown as typeof fetch;

      const { value } = await captureStdio(() =>
        smartContextCommand.run(
          makeArgs(['improve', 'smart-context'], [
            ['cwd', tempRepo],
            ['ai-plan', true],
            ['save', true],
            ['no-instructions', true],
          ]),
        ),
      );
      expect(value).toBe(0);
      const rawPath = join(tempRepo, '.sharkcraft', 'smart-context', 'improve-smart-context-plan.raw.json');
      expect(existsSync(rawPath)).toBe(true);
      const raw = JSON.parse(readFileSync(rawPath, 'utf8')) as { stage1?: string; stage2?: string };
      expect(raw.stage1).toContain('filesToRead');
      expect(raw.stage2).toContain('handoffSummary');
    } finally {
      rmSync(tempRepo, { recursive: true, force: true });
    }
  });

  test('Ollama preflight refuses when the daemon is unreachable', async () => {
    process.env.AI_PROVIDER = 'ollama';
    process.env.OLLAMA_HOST = 'http://127.0.0.1:1';
    globalThis.fetch = (async (input: unknown) => {
      // Simulate connection failure for the /api/tags preflight.
      if (String(input).includes('/api/tags')) throw new Error('ECONNREFUSED');
      throw new Error('should not reach /api/chat after preflight failure');
    }) as unknown as typeof fetch;

    const { value, stderr } = await captureStdio(() =>
      smartContextCommand.run(
        makeArgs(['improve', 'smart-context'], [
          ['cwd', REPO_ROOT],
          ['ai-plan', true],
          ['no-instructions', true],
        ]),
      ),
    );
    expect(value).toBe(1);
    expect(stderr).toContain('Ollama');
    expect(stderr.toLowerCase()).toContain('reach');
  });

  test('Ollama preflight refuses when the requested model is not pulled', async () => {
    process.env.AI_PROVIDER = 'ollama';
    process.env.OLLAMA_HOST = 'http://localhost:11434';
    globalThis.fetch = (async (input: unknown) => {
      if (String(input).includes('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'llama3.1' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error('should not reach /api/chat after preflight failure');
    }) as unknown as typeof fetch;

    const { value, stderr } = await captureStdio(() =>
      smartContextCommand.run(
        makeArgs(['improve', 'smart-context'], [
          ['cwd', REPO_ROOT],
          ['ai-plan', true],
          ['model', 'codeqwen:7b'],
          ['no-instructions', true],
        ]),
      ),
    );
    expect(value).toBe(1);
    expect(stderr).toContain('codeqwen:7b');
    expect(stderr).toContain('ollama pull');
  });
});

describe('shrk smart-context — --tiny-only (BGE plan, no LLM)', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'shrk-tiny-only-'));
  let savedSemanticIndex: typeof import('@shrkcrft/embeddings').SemanticIndex;
  let semanticIndexModule: typeof import('@shrkcrft/embeddings');

  beforeEach(async () => {
    // Build a synthetic mini-workspace with two real source files so the
    // extractor has something to chew on. We seed a fake embedder so no
    // model gets downloaded during the test.
    rmSync(fixtureRoot, { recursive: true, force: true });
    mkdirSync(join(fixtureRoot, 'packages/foo/src'), { recursive: true });
    writeFileSync(
      join(fixtureRoot, 'package.json'),
      JSON.stringify({ name: 'tmp', version: '0.0.0' }),
      'utf8',
    );
    writeFileSync(
      join(fixtureRoot, 'packages/foo/src/auth.ts'),
      `/**\n * Authentication flow.\n */\nexport interface ILogin { user: string; pass: string; }\n\nexport function authenticate(login: ILogin): boolean { return false; }\n`,
      'utf8',
    );
    writeFileSync(
      join(fixtureRoot, 'packages/foo/src/render.ts'),
      `export interface IRenderProps { width: number; height: number; }\n\nexport class Renderer { paint(p: IRenderProps) { return p; } }\n`,
      'utf8',
    );
    semanticIndexModule = await import('@shrkcrft/embeddings');
    savedSemanticIndex = semanticIndexModule.SemanticIndex;
    semanticIndexModule.SemanticIndex._embedderForTests = async (text: string) => {
      // Deterministic 4-D unit vector keyed off a content hash. Self-similarity
      // is 1.0; cross-similarity is below the replay threshold by construction.
      const h = (() => {
        let n = 0;
        for (let i = 0; i < text.length; i += 1) n = (n * 31 + text.charCodeAt(i)) | 0;
        return n;
      })();
      const raw = new Float32Array([Math.sin(h), Math.cos(h), Math.sin(h * 1.7), Math.cos(h * 0.3)]);
      let mag = 0;
      for (let i = 0; i < raw.length; i += 1) mag += raw[i]! * raw[i]!;
      mag = Math.sqrt(mag);
      for (let i = 0; i < raw.length; i += 1) raw[i] = raw[i]! / mag;
      return raw;
    };
    // Build the index against the synthetic workspace.
    await semanticIndexModule.SemanticIndex.build(
      fixtureRoot,
      [
        { path: 'packages/foo/src/auth.ts', summary: 'auth', exports: ['authenticate', 'ILogin'] },
        { path: 'packages/foo/src/render.ts', summary: 'renderer', exports: ['Renderer'] },
      ],
      { model: 'fake/embed' },
    );
  });

  afterEach(() => {
    if (semanticIndexModule) semanticIndexModule.SemanticIndex._embedderForTests = null;
    rmSync(fixtureRoot, { recursive: true, force: true });
    void savedSemanticIndex;
  });

  test('--tiny-only emits a deterministic plan with no LLM call', async () => {
    // SHRK_DISABLE_AUTO_AI is set globally above; we need it OFF here to
    // exercise the focused-context flow.
    const wasDisabled = process.env.SHRK_DISABLE_AUTO_AI;
    delete process.env.SHRK_DISABLE_AUTO_AI;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const { value, stdout } = await captureStdio(() =>
        smartContextCommand.run(
          makeArgs(['authenticate', 'a', 'user'], [
            ['cwd', fixtureRoot],
            ['tiny-only', true],
            ['no-instructions', true],
            ['no-refresh-index', true],
          ]),
        ),
      );
      expect(value).toBe(0);
      expect(fetchCalls).toBe(0);
      expect(stdout).toContain('# Tiny-AI Plan');
      expect(stdout).toContain('0 LLM tokens');
      // The plan should reference at least one of our seeded files.
      expect(stdout).toContain('packages/foo/src/auth.ts');
    } finally {
      if (wasDisabled !== undefined) process.env.SHRK_DISABLE_AUTO_AI = wasDisabled;
    }
  });

  test('an abstract architecture prompt is classified as architecture and routes through the design preamble', async () => {
    const wasDisabled = process.env.SHRK_DISABLE_AUTO_AI;
    delete process.env.SHRK_DISABLE_AUTO_AI;
    try {
      const { value, stdout, stderr } = await captureStdio(() =>
        smartContextCommand.run(
          makeArgs(
            [
              'i',
              'want',
              'to',
              'create',
              'a',
              'process',
              'that',
              'works',
              'parallel',
              'with',
              'the',
              'claude',
              'agent',
              'and',
              'constantly',
              'serves',
              'it',
              'with',
              'a',
              'lot',
              'of',
              'information',
            ],
            [
              ['cwd', fixtureRoot],
              ['focused', true],
              ['plan', true],
              ['dry-run', true],
              ['no-instructions', true],
              ['no-refresh-index', true],
            ],
          ),
        ),
      );
      expect(value).toBe(0);
      // Classifier output goes to stderr.
      expect(stderr).toContain('task type: architecture');
      // Architecture preamble is used → these architecture-specific schema
      // fields appear in the system prompt.
      expect(stdout).toContain('candidateArchitectures');
      expect(stdout).toContain('designQuestions');
      // The new schema requires a structured firstSpike + recommendedMvp.
      expect(stdout).toContain('firstSpike');
      expect(stdout).toContain('recommendedMvp');
      expect(stdout).toContain('proposedCommand');
      expect(stdout).toContain('successCriteria');
      expect(stdout).toContain('nonGoals');
      expect(stdout).toContain('filesToInspect');
      // Differentiation rules must be communicated.
      expect(stdout).toContain('uniquePros');
      expect(stdout).toContain('uniqueCons');
      expect(stdout).toContain('differentiator');
      // SHRK integration vocabulary must be present.
      expect(stdout).toContain('cli-watcher');
      expect(stdout).toContain('mcp-tool-call');
      expect(stdout).toContain('background-watcher');
      // Anti-pattern guardrails are explicit.
      expect(stdout).toContain('ANTI-PATTERN');
      expect(stdout).toContain('documentation and support level');
      // The implementation-style schema MUST be absent — that's the bug
      // this whole change was made to prevent.
      expect(stdout).not.toContain('likelyFilesToEdit');
    } finally {
      if (wasDisabled !== undefined) process.env.SHRK_DISABLE_AUTO_AI = wasDisabled;
    }
  });

  test('regression for task6.md: architecture prompt enforces SHRK vocabulary + differentiation', async () => {
    const wasDisabled = process.env.SHRK_DISABLE_AUTO_AI;
    delete process.env.SHRK_DISABLE_AUTO_AI;
    try {
      const { value, stdout } = await captureStdio(() =>
        smartContextCommand.run(
          makeArgs(
            [
              'i',
              'want',
              'to',
              'create',
              'a',
              'process',
              'that',
              'works',
              'parallel',
              'with',
              'the',
              'claude',
              'agent',
              'and',
              'constantly',
              'serves',
              'it',
              'with',
              'a',
              'lot',
              'of',
              'information',
            ],
            [
              ['cwd', fixtureRoot],
              ['focused', true],
              ['plan', true],
              ['dry-run', true],
              ['no-instructions', true],
              ['no-refresh-index', true],
            ],
          ),
        ),
      );
      expect(value).toBe(0);
      // The 7 SHRK-specific design topics are listed in the preamble.
      for (const topic of [
        'Context-packet schema',
        'Update trigger',
        'Deduplication',
        'Context budget per packet',
        'Claude handoff mechanism',
        'MCP vs file-system vs CLI responsibility',
        'Session persistence',
      ]) {
        expect(stdout).toContain(topic);
      }
      // The vocabulary list must enumerate the canonical surface names.
      for (const surface of ['cli-command', 'cli-watcher', 'mcp-tool-call', 'mcp-resource-read', 'file-read', 'file-write', 'stdout-stream', 'background-watcher']) {
        expect(stdout).toContain(surface);
      }
      // Differentiation enforcement is in the prompt.
      expect(stdout).toContain('DIFFERENTIATION RULE');
      // HTTP verbs are banned on local surfaces.
      expect(stdout).toContain('HTTP verbs');
    } finally {
      if (wasDisabled !== undefined) process.env.SHRK_DISABLE_AUTO_AI = wasDisabled;
    }
  });

  test('--tiny-only on the architecture prompt does NOT propose "files to modify"', async () => {
    const wasDisabled = process.env.SHRK_DISABLE_AUTO_AI;
    delete process.env.SHRK_DISABLE_AUTO_AI;
    try {
      const { value, stdout } = await captureStdio(() =>
        smartContextCommand.run(
          makeArgs(
            ['create', 'a', 'process', 'that', 'runs', 'in', 'parallel', 'with', 'the', 'agent'],
            [
              ['cwd', fixtureRoot],
              ['tiny-only', true],
              ['no-instructions', true],
              ['no-refresh-index', true],
            ],
          ),
        ),
      );
      expect(value).toBe(0);
      expect(stdout).toContain('Tiny-AI Design Brief');
      expect(stdout).toContain('This task is abstract');
      expect(stdout).toContain('Design questions to answer first');
      expect(stdout).toContain('Candidate integration shapes');
      expect(stdout).toContain('Non-goals');
      expect(stdout).toContain('Recommended first spike');
      // The implementation-style "modify" lines must NOT appear.
      expect(stdout).not.toContain('Likely files to modify');
      expect(stdout.toLowerCase()).not.toContain('modify the cli adapter');
      expect(stdout.toLowerCase()).not.toContain('modify the send method');
    } finally {
      if (wasDisabled !== undefined) process.env.SHRK_DISABLE_AUTO_AI = wasDisabled;
    }
  });

  test('--task-type override forces the chosen preamble', async () => {
    const wasDisabled = process.env.SHRK_DISABLE_AUTO_AI;
    delete process.env.SHRK_DISABLE_AUTO_AI;
    try {
      // Concrete-sounding task, normally implementation; force it into architecture mode.
      const { value, stdout, stderr } = await captureStdio(() =>
        smartContextCommand.run(
          makeArgs(
            ['add', 'a', 'new', 'doctor', 'check'],
            [
              ['cwd', fixtureRoot],
              ['focused', true],
              ['plan', true],
              ['dry-run', true],
              ['task-type', 'architecture'],
              ['no-instructions', true],
              ['no-refresh-index', true],
            ],
          ),
        ),
      );
      expect(value).toBe(0);
      expect(stderr).toContain('task type: architecture');
      expect(stdout).toContain('candidateArchitectures');
    } finally {
      if (wasDisabled !== undefined) process.env.SHRK_DISABLE_AUTO_AI = wasDisabled;
    }
  });

  test('--focused --dry-run emits a tight prompt with TASK at top and no CLAUDE.md dump', async () => {
    const wasDisabled = process.env.SHRK_DISABLE_AUTO_AI;
    delete process.env.SHRK_DISABLE_AUTO_AI;
    try {
      const { value, stdout } = await captureStdio(() =>
        smartContextCommand.run(
          makeArgs(['authenticate', 'a', 'user'], [
            ['cwd', fixtureRoot],
            ['focused', true],
            ['plan', true],
            ['dry-run', true],
            ['no-instructions', true],
            ['no-refresh-index', true],
          ]),
        ),
      );
      expect(value).toBe(0);
      // TASK heading appears at the top of the system context.
      expect(stdout).toMatch(/# TASK\nauthenticate a user/);
      // Code snippets are surfaced (not file paths alone).
      expect(stdout).toContain('export interface ILogin');
      // The verbose CLAUDE.md dump is NOT included — we passed --no-instructions.
      expect(stdout).not.toContain('Nx-style monorepo');
    } finally {
      if (wasDisabled !== undefined) process.env.SHRK_DISABLE_AUTO_AI = wasDisabled;
    }
  });
});

describe('shrk smart-context — multi-pass enhancement pipeline (brief mode)', () => {
  test('--plus runs draft → critique → refine → polish against Ollama and uses the polished output as the brief content', async () => {
    process.env.AI_PROVIDER = 'ollama';
    process.env.OLLAMA_HOST = 'http://localhost:11434';
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'shrk-pipeline-brief-'));
    try {
      writeFileSync(
        join(fixtureRoot, 'package.json'),
        JSON.stringify({ name: 'tmp', version: '0.0.0' }),
        'utf8',
      );
      let call = 0;
      const sequence = ['DRAFT-BODY', 'GAP: missing tests', 'REFINED-BODY', 'POLISHED-BODY'];
      globalThis.fetch = (async (input: unknown) => {
        if (String(input).includes('/api/tags')) {
          // The pipeline path doesn't preflight (only ai-plan does),
          // but be safe if the implementation grows one.
          return new Response(JSON.stringify({ models: [{ name: 'llama3.1' }] }), { status: 200 });
        }
        const idx = Math.min(call, sequence.length - 1);
        call += 1;
        return new Response(
          JSON.stringify({
            model: 'llama3.1',
            message: { role: 'assistant', content: sequence[idx] },
            done: true,
            done_reason: 'stop',
            prompt_eval_count: 5,
            eval_count: 5,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch;

      const { value, stdout } = await captureStdio(() =>
        smartContextCommand.run(
          makeArgs(['add', 'a', 'new', 'doctor', 'check'], [
            ['cwd', fixtureRoot],
            ['json', true],
            ['no-instructions', true],
            ['plus', true],
          ]),
        ),
      );
      expect(value).toBe(0);
      const parsed = JSON.parse(stdout) as {
        mode: string;
        content: string;
        enhancement?: {
          enabled: true;
          stages: Array<{ kind: string; degraded: boolean }>;
          deterministicFallback: boolean;
        };
      };
      expect(parsed.mode).toBe('brief');
      // Polished output (not draft, not critique) ends up as the brief body.
      expect(parsed.content).toContain('POLISHED-BODY');
      expect(parsed.enhancement?.enabled).toBe(true);
      expect(parsed.enhancement?.deterministicFallback).toBe(false);
      expect(parsed.enhancement?.stages.map((s) => s.kind)).toEqual([
        'draft', 'critique', 'refine', 'polish',
      ]);
      // 4 LLM round-trips (one per stage).
      expect(call).toBe(4);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('default (no --plus) runs the fast draft → polish pipeline (2 LLM calls)', async () => {
    process.env.AI_PROVIDER = 'ollama';
    process.env.OLLAMA_HOST = 'http://localhost:11434';
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'shrk-pipeline-fast-'));
    try {
      writeFileSync(
        join(fixtureRoot, 'package.json'),
        JSON.stringify({ name: 'tmp', version: '0.0.0' }),
        'utf8',
      );
      let call = 0;
      const sequence = ['DRAFT-BODY', 'POLISHED-BODY'];
      globalThis.fetch = (async (input: unknown) => {
        if (String(input).includes('/api/tags')) {
          return new Response(JSON.stringify({ models: [{ name: 'llama3.1' }] }), { status: 200 });
        }
        const idx = Math.min(call, sequence.length - 1);
        call += 1;
        return new Response(
          JSON.stringify({
            model: 'llama3.1',
            message: { role: 'assistant', content: sequence[idx] },
            done: true,
            done_reason: 'stop',
            prompt_eval_count: 5,
            eval_count: 5,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch;

      const { value, stdout } = await captureStdio(() =>
        smartContextCommand.run(
          makeArgs(['add', 'a', 'new', 'doctor', 'check'], [
            ['cwd', fixtureRoot],
            ['json', true],
            ['no-instructions', true],
          ]),
        ),
      );
      expect(value).toBe(0);
      const parsed = JSON.parse(stdout) as {
        content: string;
        enhancement?: { stages: Array<{ kind: string }>; deterministicFallback: boolean };
      };
      expect(parsed.content).toContain('POLISHED-BODY');
      expect(parsed.enhancement?.stages.map((s) => s.kind)).toEqual(['draft', 'polish']);
      // Only 2 LLM round-trips by default — the fast path.
      expect(call).toBe(2);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('--no-enhance keeps single-shot behaviour (one LLM call, no enhancement telemetry)', async () => {
    process.env.AI_PROVIDER = 'ollama';
    process.env.OLLAMA_HOST = 'http://localhost:11434';
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'shrk-pipeline-noenh-'));
    try {
      writeFileSync(
        join(fixtureRoot, 'package.json'),
        JSON.stringify({ name: 'tmp', version: '0.0.0' }),
        'utf8',
      );
      let call = 0;
      globalThis.fetch = (async (input: unknown) => {
        if (String(input).includes('/api/tags')) {
          return new Response(JSON.stringify({ models: [{ name: 'llama3.1' }] }), { status: 200 });
        }
        call += 1;
        return new Response(
          JSON.stringify({
            model: 'llama3.1',
            message: { role: 'assistant', content: 'single-shot-body' },
            done: true,
            done_reason: 'stop',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch;

      const { value, stdout } = await captureStdio(() =>
        smartContextCommand.run(
          makeArgs(['add', 'a', 'check'], [
            ['cwd', fixtureRoot],
            ['json', true],
            ['no-instructions', true],
            ['no-enhance', true],
          ]),
        ),
      );
      expect(value).toBe(0);
      const parsed = JSON.parse(stdout) as { content: string; enhancement?: unknown };
      expect(parsed.content).toContain('single-shot-body');
      expect(parsed.enhancement).toBeUndefined();
      expect(call).toBe(1);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('--plus --enhance-passes 2 caps the pipeline at draft + critique', async () => {
    process.env.AI_PROVIDER = 'ollama';
    process.env.OLLAMA_HOST = 'http://localhost:11434';
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'shrk-pipeline-cap-'));
    try {
      writeFileSync(
        join(fixtureRoot, 'package.json'),
        JSON.stringify({ name: 'tmp', version: '0.0.0' }),
        'utf8',
      );
      let call = 0;
      globalThis.fetch = (async (input: unknown) => {
        if (String(input).includes('/api/tags')) {
          return new Response(JSON.stringify({ models: [{ name: 'llama3.1' }] }), { status: 200 });
        }
        call += 1;
        return new Response(
          JSON.stringify({
            model: 'llama3.1',
            message: { role: 'assistant', content: call === 1 ? 'DRAFT' : 'CRITIQUE' },
            done: true,
            done_reason: 'stop',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch;

      const { value, stdout } = await captureStdio(() =>
        smartContextCommand.run(
          makeArgs(['add', 'a', 'cap-test'], [
            ['cwd', fixtureRoot],
            ['json', true],
            ['no-instructions', true],
            ['plus', true],
            ['enhance-passes', '2'],
          ]),
        ),
      );
      expect(value).toBe(0);
      const parsed = JSON.parse(stdout) as {
        enhancement?: { stages: Array<{ kind: string }> };
      };
      expect(parsed.enhancement?.stages.map((s) => s.kind)).toEqual(['draft', 'critique']);
      expect(call).toBe(2);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});

// Suppress unused-import warning under aggressive linters — these are imported
// for type-resolution of the helper-only assertions above.
void existsSync;
void readFileSync;
