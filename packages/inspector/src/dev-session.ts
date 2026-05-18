import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as nodePath from 'node:path';
import type { ITaskPacket } from './task-packet.ts';

export const DEV_SESSION_SCHEMA = 'sharkcraft.dev-session/v1';

export enum DevSessionPhase {
  Started = 'started',
  Planned = 'planned',
  Reviewed = 'reviewed',
  Applied = 'applied',
  Validated = 'validated',
  ValidationFailed = 'validation_failed',
  Completed = 'completed',
}

export enum DevSessionSignatureStatus {
  Verified = 'verified',
  Unsigned = 'unsigned',
  Invalid = 'invalid',
  NotChecked = 'not-checked',
}

export enum DevSessionPlanStatus {
  Intent = 'intent',
  Saved = 'saved',
  Reviewed = 'reviewed',
  Applied = 'applied',
}

export interface IDevSessionPlanEntry {
  /** Stable id within the session (basename without extension). */
  name: string;
  templateId: string;
  /** Template-level name argument (kebab-case). */
  generatedName?: string;
  variables: Record<string, string>;
  missingVariables: readonly string[];
  status: DevSessionPlanStatus;
  /** File under plans/. Either `<name>.json` (saved) or `<name>.intent.md` (intent). */
  file: string;
  signed: boolean;
  createdAt: string;
  /** Plan-review report files under reports/, if review has been run. */
  reviewReportFile?: string;
  reviewReportMarkdownFile?: string;
}

export interface IDevSessionValidationEntry {
  startedAt: string;
  finishedAt: string;
  reportFile: string;
  passed: boolean;
  warnings: number;
  commandsRun: { command: string; passed: boolean; note?: string }[];
  boundaryViolations: number;
}

export interface IDevSessionAppliedPlan {
  /** Plan file relative to plans/. */
  file: string;
  appliedAt: string;
  note?: string;
  /** Files written during apply, relative to projectRoot. */
  changedFiles?: readonly string[];
  /** Whether the apply CLI verified the signature. */
  signatureStatus?: DevSessionSignatureStatus;
  /** Whether the live plan diverged from the saved plan. */
  divergenceAccepted?: boolean;
  /** Conflicts the live plan reported (should be empty on success). */
  conflicts?: readonly string[];
}

export interface IDevSessionState {
  schema: typeof DEV_SESSION_SCHEMA;
  id: string;
  task: string;
  createdAt: string;
  updatedAt: string;
  phase: DevSessionPhase;
  projectRoot: string;
  selectedPipeline: string | null;
  selectedTemplates: readonly string[];
  plans: readonly IDevSessionPlanEntry[];
  reports: readonly string[];
  validations: readonly IDevSessionValidationEntry[];
  appliedPlans: readonly IDevSessionAppliedPlan[];
  nextAction: string | null;
  warnings: readonly string[];
  /** Path (relative to session dir) of the agent brief, when generated. */
  briefFile?: string;
}

export function setDevSessionBriefFile(
  state: IDevSessionState,
  briefFile: string | null,
): IDevSessionState {
  if (state.briefFile === (briefFile ?? undefined)) return state;
  const next = { ...state, updatedAt: nowIso() };
  if (briefFile) next.briefFile = briefFile;
  else delete (next as { briefFile?: string }).briefFile;
  return next;
}

export interface IDevSessionLoad {
  id: string;
  dir: string;
  task: string;
  packet: ITaskPacket | null;
  /** Parsed session.json. `null` when the session was created by an older `shrk session start`. */
  state: IDevSessionState | null;
  /** Filesystem scan — independent of session.json so legacy sessions remain readable. */
  plansOnDisk: readonly string[];
  reportsOnDisk: readonly string[];
  intentFiles: readonly string[];
  /** `true` when session.json is missing — caller may want to display a "legacy session" note. */
  legacy: boolean;
}

export interface ICreateDevSessionInput {
  id: string;
  task: string;
  projectRoot: string;
  packet: ITaskPacket;
}

export function getSessionsRoot(cwd: string): string {
  return nodePath.join(cwd, '.sharkcraft', 'sessions');
}

export function getDevSessionDir(cwd: string, id: string): string {
  return nodePath.join(getSessionsRoot(cwd), id);
}

function readJsonIfExists<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function listDirSafe(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => {
        try {
          return statSync(nodePath.join(dir, f)).isFile();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createDevSessionState(input: ICreateDevSessionInput): IDevSessionState {
  const created = nowIso();
  const selectedPipeline = input.packet.recommendedPipelines[0]?.pipelineId ?? null;
  const selectedTemplates = input.packet.relevantTemplates
    .slice(0, 5)
    .map((t) => t.id);
  const nextAction = input.packet.suggestedGen
    ? `shrk dev plan ${input.id}`
    : `shrk dev continue ${input.id}`;
  return {
    schema: DEV_SESSION_SCHEMA,
    id: input.id,
    task: input.task,
    createdAt: created,
    updatedAt: created,
    phase: DevSessionPhase.Started,
    projectRoot: input.projectRoot,
    selectedPipeline,
    selectedTemplates,
    plans: [],
    reports: [],
    validations: [],
    appliedPlans: [],
    nextAction,
    warnings: [],
  };
}

export function writeDevSessionState(cwd: string, state: IDevSessionState): IDevSessionState {
  const dir = getDevSessionDir(cwd, state.id);
  mkdirSync(dir, { recursive: true });
  const next: IDevSessionState = { ...state, updatedAt: nowIso() };
  writeFileSync(
    nodePath.join(dir, 'session.json'),
    JSON.stringify(next, null, 2) + '\n',
    'utf8',
  );
  return next;
}

export function readDevSessionState(cwd: string, id: string): IDevSessionState | null {
  const file = nodePath.join(getDevSessionDir(cwd, id), 'session.json');
  const raw = readJsonIfExists<IDevSessionState>(file);
  if (!raw) return null;
  if (raw.schema !== DEV_SESSION_SCHEMA) return null;
  return raw;
}

export function scanDevSession(cwd: string, id: string): IDevSessionLoad | null {
  const dir = getDevSessionDir(cwd, id);
  if (!existsSync(dir)) return null;
  const taskFile = nodePath.join(dir, 'task.md');
  const packetFile = nodePath.join(dir, 'task-packet.json');
  const plansDir = nodePath.join(dir, 'plans');
  const reportsDir = nodePath.join(dir, 'reports');
  const task = existsSync(taskFile) ? readFileSync(taskFile, 'utf8').replace(/^# /, '').trim() : '';
  const packet = readJsonIfExists<ITaskPacket>(packetFile);
  const state = readDevSessionState(cwd, id);
  const allPlanFiles = listDirSafe(plansDir);
  const plansOnDisk = allPlanFiles.filter((f) => f.endsWith('.json'));
  const intentFiles = allPlanFiles.filter((f) => f.endsWith('.intent.md'));
  const reportsOnDisk = listDirSafe(reportsDir);
  return {
    id,
    dir,
    task,
    packet,
    state,
    plansOnDisk,
    reportsOnDisk,
    intentFiles,
    legacy: state === null,
  };
}

export function listDevSessions(cwd: string): string[] {
  const root = getSessionsRoot(cwd);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((d) => {
      try {
        return statSync(nodePath.join(root, d)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .reverse();
}

export interface IDevNextAction {
  /** Short human-facing phrase, e.g. "Generate plans". */
  action: string;
  /** Shell command the human should run next (may be a placeholder hint). */
  command: string;
  /** Why this is the recommended next step. */
  reason: string;
  /** Whether the recommendation requires human review (apply step). */
  requiresHumanApproval: boolean;
}

export function computeDevNextAction(load: IDevSessionLoad): IDevNextAction {
  const id = load.id;

  // Legacy session (no session.json) — direct the user to dev status to surface state.
  if (load.legacy && load.intentFiles.length === 0 && load.plansOnDisk.length === 0) {
    return {
      action: 'Generate plans',
      command: `shrk dev plan ${id}`,
      reason: 'No plans saved yet for this session.',
      requiresHumanApproval: false,
    };
  }

  const state = load.state;

  // 1. No plans at all — suggest dev plan.
  if (load.plansOnDisk.length === 0 && load.intentFiles.length === 0) {
    return {
      action: 'Generate plans',
      command: `shrk dev plan ${id}`,
      reason: 'No plans or intents in this session yet.',
      requiresHumanApproval: false,
    };
  }

  // 2. Only intents — variables are missing.
  if (load.plansOnDisk.length === 0 && load.intentFiles.length > 0) {
    const first = load.intentFiles[0]!;
    const templateId = first.replace(/\.intent\.md$/, '');
    return {
      action: 'Fill in missing variables and re-run dev plan',
      command: `shrk dev plan ${id} --template ${templateId} --var <name>=<value>`,
      reason: `Plan intent file ${first} needs required variables before it can be saved.`,
      requiresHumanApproval: false,
    };
  }

  // 3. Saved plans but no reviews — run dev plan to auto-review.
  const reviewedNames = new Set(
    load.reportsOnDisk
      .filter((r) => r.startsWith('plan-review-') && r.endsWith('.json'))
      .map((r) => r.replace(/^plan-review-/, '').replace(/\.json$/, '')),
  );
  const unreviewedPlans = load.plansOnDisk.filter((p) => {
    const name = p.replace(/\.json$/, '');
    return !reviewedNames.has(name);
  });
  if (unreviewedPlans.length > 0) {
    return {
      action: 'Review saved plans',
      command: `shrk dev plan ${id}`,
      reason: `${unreviewedPlans.length} saved plan(s) have not been reviewed yet.`,
      requiresHumanApproval: false,
    };
  }

  // 4. Plans reviewed, not applied — human must apply.
  const appliedNames = new Set(
    (state?.appliedPlans ?? []).map((a) => a.file.replace(/\.json$/, '')),
  );
  const unappliedPlans = load.plansOnDisk.filter((p) => !appliedNames.has(p.replace(/\.json$/, '')));
  if (unappliedPlans.length > 0) {
    const planFile = nodePath.join(load.dir, 'plans', unappliedPlans[0]!);
    return {
      action: 'Apply a reviewed plan (human approval required)',
      command: `shrk apply ${planFile} --verify-signature`,
      reason: 'All saved plans have been reviewed; apply is the human step that writes files.',
      requiresHumanApproval: true,
    };
  }

  // 5. Applied but not validated.
  const validations = state?.validations ?? [];
  if (state && state.appliedPlans.length > 0 && validations.length === 0) {
    return {
      action: 'Run validation',
      command: `shrk dev validate ${id}`,
      reason: 'Plans have been applied but validation has not been run yet.',
      requiresHumanApproval: false,
    };
  }

  // 6. Validated but no final report.
  const lastValidation = validations[validations.length - 1];
  if (lastValidation && lastValidation.passed && state?.phase !== DevSessionPhase.Completed) {
    return {
      action: 'Generate final report',
      command: `shrk dev report ${id}`,
      reason: 'Validation passed; produce the human-readable audit trail.',
      requiresHumanApproval: false,
    };
  }

  // 7. Completed.
  if (state?.phase === DevSessionPhase.Completed) {
    return {
      action: 'Session complete',
      command: `shrk session show ${id}`,
      reason: 'Final report has been generated.',
      requiresHumanApproval: false,
    };
  }

  // Fallback — keep nudging towards plan/review.
  return {
    action: 'Continue the development workflow',
    command: `shrk dev status ${id}`,
    reason: 'Session state did not match a known transition — inspect with dev status.',
    requiresHumanApproval: false,
  };
}

export interface IUpsertPlanInput {
  name: string;
  templateId: string;
  generatedName?: string;
  variables: Record<string, string>;
  missingVariables: readonly string[];
  status: DevSessionPlanStatus;
  file: string;
  signed: boolean;
  reviewReportFile?: string;
  reviewReportMarkdownFile?: string;
}

/**
 * Pure: returns a new state with the given plan upserted by name. Does NOT
 * touch disk — caller is responsible for `writeDevSessionState`.
 */
export function upsertDevPlanEntry(
  state: IDevSessionState,
  input: IUpsertPlanInput,
): IDevSessionState {
  const existing = state.plans.findIndex((p) => p.name === input.name);
  const createdAt = existing >= 0 ? state.plans[existing]!.createdAt : nowIso();
  const entry: IDevSessionPlanEntry = {
    name: input.name,
    templateId: input.templateId,
    variables: { ...input.variables },
    missingVariables: input.missingVariables,
    status: input.status,
    file: input.file,
    signed: input.signed,
    createdAt,
  };
  if (input.generatedName !== undefined) entry.generatedName = input.generatedName;
  if (input.reviewReportFile !== undefined) entry.reviewReportFile = input.reviewReportFile;
  if (input.reviewReportMarkdownFile !== undefined) {
    entry.reviewReportMarkdownFile = input.reviewReportMarkdownFile;
  }
  const plans =
    existing >= 0
      ? [...state.plans.slice(0, existing), entry, ...state.plans.slice(existing + 1)]
      : [...state.plans, entry];
  return { ...state, plans, updatedAt: nowIso() };
}

export function recordReportFile(state: IDevSessionState, reportRel: string): IDevSessionState {
  if (state.reports.includes(reportRel)) return state;
  return { ...state, reports: [...state.reports, reportRel], updatedAt: nowIso() };
}

export function recordValidation(
  state: IDevSessionState,
  validation: IDevSessionValidationEntry,
): IDevSessionState {
  return {
    ...state,
    validations: [...state.validations, validation],
    updatedAt: nowIso(),
  };
}

export function recordAppliedPlan(
  state: IDevSessionState,
  applied: IDevSessionAppliedPlan,
): IDevSessionState {
  if (state.appliedPlans.some((a) => a.file === applied.file)) return state;
  return {
    ...state,
    appliedPlans: [...state.appliedPlans, applied],
    updatedAt: nowIso(),
  };
}

export function setDevSessionPhase(
  state: IDevSessionState,
  phase: DevSessionPhase,
): IDevSessionState {
  if (state.phase === phase) return state;
  return { ...state, phase, updatedAt: nowIso() };
}

export function setDevNextAction(
  state: IDevSessionState,
  nextAction: string | null,
): IDevSessionState {
  if (state.nextAction === nextAction) return state;
  return { ...state, nextAction, updatedAt: nowIso() };
}

/**
 * Recompute phase from the current state + filesystem scan. Used after plan
 * generation and validation to keep `phase` in sync with reality.
 */
export function recomputePhase(state: IDevSessionState, load: IDevSessionLoad): DevSessionPhase {
  if (state.phase === DevSessionPhase.Completed) return DevSessionPhase.Completed;
  const lastValidation = state.validations[state.validations.length - 1];
  if (lastValidation && !lastValidation.passed) return DevSessionPhase.ValidationFailed;
  if (state.validations.some((v) => v.passed)) return DevSessionPhase.Validated;
  if (state.appliedPlans.length > 0) return DevSessionPhase.Applied;
  const reviewed = state.plans.filter((p) => p.status === DevSessionPlanStatus.Reviewed);
  if (reviewed.length > 0 && reviewed.length === state.plans.length && state.plans.length > 0) {
    return DevSessionPhase.Reviewed;
  }
  if (state.plans.some((p) => p.status === DevSessionPlanStatus.Saved || p.status === DevSessionPlanStatus.Reviewed)) {
    return DevSessionPhase.Planned;
  }
  if (load.plansOnDisk.length > 0 || load.intentFiles.length > 0) {
    return DevSessionPhase.Planned;
  }
  return DevSessionPhase.Started;
}

export interface IDetectedSessionPlan {
  sessionId: string;
  /** Plan file basename within plans/. */
  planFile: string;
}

/**
 * Returns { sessionId, planFile } when `planPath` lives under
 * <cwd>/.sharkcraft/sessions/<id>/plans/<file>. Returns null otherwise. Uses
 * normalized paths so trailing slashes, `..`, etc. cannot trick the detector.
 */
export function detectSessionFromPlanPath(
  planPath: string,
  cwd: string,
): IDetectedSessionPlan | null {
  const sessionsRoot = nodePath.resolve(getSessionsRoot(cwd));
  const abs = nodePath.resolve(planPath);
  const rel = nodePath.relative(sessionsRoot, abs);
  if (rel.startsWith('..') || nodePath.isAbsolute(rel)) return null;
  const parts = rel.split(nodePath.sep).filter(Boolean);
  if (parts.length !== 3) return null;
  if (parts[1] !== 'plans') return null;
  return { sessionId: parts[0]!, planFile: parts[2]! };
}

export interface IDevSessionListItem {
  id: string;
  phase: DevSessionPhase | null;
  task: string;
  createdAt: string | null;
  updatedAt: string | null;
  nextAction: string | null;
  legacy: boolean;
}

/** List sessions with their session.json metadata where available. */
export function listDevSessionsDetailed(cwd: string): IDevSessionListItem[] {
  const ids = listDevSessions(cwd);
  const items: IDevSessionListItem[] = [];
  for (const id of ids) {
    const load = scanDevSession(cwd, id);
    if (!load) continue;
    items.push({
      id,
      phase: load.state?.phase ?? null,
      task: load.task,
      createdAt: load.state?.createdAt ?? null,
      updatedAt: load.state?.updatedAt ?? null,
      nextAction: load.state?.nextAction ?? null,
      legacy: load.legacy,
    });
  }
  return items;
}

export function getSessionsArchiveRoot(cwd: string): string {
  return nodePath.join(cwd, '.sharkcraft', 'sessions-archive');
}

export interface IArchiveResult {
  archived: boolean;
  from: string;
  to: string;
  reason?: string;
}

/**
 * Move a session directory to .sharkcraft/sessions-archive/<id>. If a session
 * with the same id already exists in the archive, returns archived=false with
 * a reason rather than overwriting.
 */
export function archiveDevSession(cwd: string, id: string): IArchiveResult {
  const from = getDevSessionDir(cwd, id);
  const to = nodePath.join(getSessionsArchiveRoot(cwd), id);
  if (!existsSync(from)) {
    return { archived: false, from, to, reason: 'source missing' };
  }
  if (existsSync(to)) {
    return { archived: false, from, to, reason: 'archive entry already exists' };
  }
  mkdirSync(getSessionsArchiveRoot(cwd), { recursive: true });
  renameSync(from, to);
  return { archived: true, from, to };
}

/** Returns true when a session is considered "incomplete" — has plans/intents
 *  but is not yet at a terminal phase. Used as the safety net for `dev clean`. */
export function isDevSessionActive(load: IDevSessionLoad): boolean {
  if (load.state) {
    if (
      load.state.phase === DevSessionPhase.Completed ||
      load.state.phase === DevSessionPhase.Validated
    ) {
      return false;
    }
    if (load.state.plans.length > 0 || load.state.appliedPlans.length > 0) return true;
    return false;
  }
  // Legacy session — treat as active if there's anything on disk we shouldn't
  // delete without explicit opt-in.
  return load.plansOnDisk.length > 0 || load.intentFiles.length > 0;
}

export interface IDevCleanCandidate {
  id: string;
  ageMs: number;
  phase: DevSessionPhase | null;
  active: boolean;
  reason: string;
}

export interface IDevCleanInput {
  cwd: string;
  /** Sessions older than this in ms are candidates. */
  olderThanMs: number;
  includeActive?: boolean;
  /** Reference timestamp; defaults to Date.now(). */
  now?: number;
}

export function listDevCleanCandidates(input: IDevCleanInput): IDevCleanCandidate[] {
  const now = input.now ?? Date.now();
  const ids = listDevSessions(input.cwd);
  const out: IDevCleanCandidate[] = [];
  for (const id of ids) {
    const load = scanDevSession(input.cwd, id);
    if (!load) continue;
    const ref = load.state?.updatedAt ?? load.state?.createdAt;
    if (!ref) {
      // Legacy session without timestamps — fall back to directory mtime.
      try {
        const st = statSync(load.dir);
        const ageMs = now - st.mtimeMs;
        if (ageMs < input.olderThanMs) continue;
        const active = isDevSessionActive(load);
        if (active && !input.includeActive) {
          out.push({ id, ageMs, phase: null, active, reason: 'legacy active — skipped' });
          continue;
        }
        out.push({ id, ageMs, phase: null, active, reason: 'legacy session' });
      } catch {
        // ignore
      }
      continue;
    }
    const ageMs = now - new Date(ref).valueOf();
    if (ageMs < input.olderThanMs) continue;
    const active = isDevSessionActive(load);
    if (active && !input.includeActive) {
      out.push({
        id,
        ageMs,
        phase: load.state?.phase ?? null,
        active,
        reason: 'active session — skipped',
      });
      continue;
    }
    out.push({
      id,
      ageMs,
      phase: load.state?.phase ?? null,
      active,
      reason: 'eligible',
    });
  }
  return out;
}

export interface IDevDiffOutput {
  a: IDevDiffSide;
  b: IDevDiffSide;
  phase: { sameValue: string | null; changed: boolean };
  task: { sameValue: string | null; changed: boolean };
  selectedPipeline: { sameValue: string | null; changed: boolean };
  selectedTemplates: IDiffGroup;
  plans: IDiffGroup;
  appliedPlans: IDiffGroup;
  validations: { aCount: number; bCount: number };
  reports: IDiffGroup;
  nextAction: { sameValue: string | null; changed: boolean };
  topRules: IDiffGroup;
  topTemplates: IDiffGroup;
  forbiddenActions: IDiffGroup;
  verificationCommands: IDiffGroup;
  cliCommands: IDiffGroup;
  mcpTools: IDiffGroup;
}

interface IDevDiffSide {
  id: string;
  phase: DevSessionPhase | null;
  task: string;
  legacy: boolean;
}

interface IDiffGroup {
  onlyA: readonly string[];
  onlyB: readonly string[];
  both: readonly string[];
}

function diffStringSet(a: readonly string[], b: readonly string[]): IDiffGroup {
  const setA = new Set(a);
  const setB = new Set(b);
  const both: string[] = [];
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  for (const v of setA) (setB.has(v) ? both : onlyA).push(v);
  for (const v of setB) if (!setA.has(v)) onlyB.push(v);
  return { onlyA, onlyB, both };
}

function planNames(state: IDevSessionState | null): string[] {
  return state ? state.plans.map((p) => p.name) : [];
}

function appliedPlanNames(state: IDevSessionState | null): string[] {
  return state ? state.appliedPlans.map((a) => a.file) : [];
}

function packetIds(load: IDevSessionLoad, key: 'relevantTemplates' | 'relevantRules'): string[] {
  const list = load.packet?.[key] as readonly { id?: string }[] | undefined;
  if (!list) return [];
  return list.map((x) => x.id).filter((x): x is string => typeof x === 'string');
}

function packetStrings(
  load: IDevSessionLoad,
  key: 'forbiddenActions' | 'verificationCommands' | 'recommendedCliCommands' | 'recommendedMcpTools',
): string[] {
  const list = load.packet?.[key] as readonly string[] | undefined;
  if (!list) return [];
  return [...list];
}

/** Diff two loaded dev sessions on the fields the spec calls out. Pure: no IO. */
export function diffDevSessions(a: IDevSessionLoad, b: IDevSessionLoad): IDevDiffOutput {
  const aSide: IDevDiffSide = {
    id: a.id,
    phase: a.state?.phase ?? null,
    task: a.task,
    legacy: a.legacy,
  };
  const bSide: IDevDiffSide = {
    id: b.id,
    phase: b.state?.phase ?? null,
    task: b.task,
    legacy: b.legacy,
  };
  const phaseA = aSide.phase;
  const phaseB = bSide.phase;
  const pipelineA = a.state?.selectedPipeline ?? null;
  const pipelineB = b.state?.selectedPipeline ?? null;
  const nextA = a.state?.nextAction ?? null;
  const nextB = b.state?.nextAction ?? null;
  return {
    a: aSide,
    b: bSide,
    phase: { sameValue: phaseA === phaseB ? phaseA : null, changed: phaseA !== phaseB },
    task: { sameValue: a.task === b.task ? a.task : null, changed: a.task !== b.task },
    selectedPipeline: {
      sameValue: pipelineA === pipelineB ? pipelineA : null,
      changed: pipelineA !== pipelineB,
    },
    selectedTemplates: diffStringSet(
      a.state?.selectedTemplates ?? [],
      b.state?.selectedTemplates ?? [],
    ),
    plans: diffStringSet(planNames(a.state), planNames(b.state)),
    appliedPlans: diffStringSet(appliedPlanNames(a.state), appliedPlanNames(b.state)),
    validations: {
      aCount: a.state?.validations.length ?? 0,
      bCount: b.state?.validations.length ?? 0,
    },
    reports: diffStringSet(a.state?.reports ?? [], b.state?.reports ?? []),
    nextAction: { sameValue: nextA === nextB ? nextA : null, changed: nextA !== nextB },
    topRules: diffStringSet(packetIds(a, 'relevantRules'), packetIds(b, 'relevantRules')),
    topTemplates: diffStringSet(
      packetIds(a, 'relevantTemplates'),
      packetIds(b, 'relevantTemplates'),
    ),
    forbiddenActions: diffStringSet(
      packetStrings(a, 'forbiddenActions'),
      packetStrings(b, 'forbiddenActions'),
    ),
    verificationCommands: diffStringSet(
      packetStrings(a, 'verificationCommands'),
      packetStrings(b, 'verificationCommands'),
    ),
    cliCommands: diffStringSet(
      packetStrings(a, 'recommendedCliCommands'),
      packetStrings(b, 'recommendedCliCommands'),
    ),
    mcpTools: diffStringSet(
      packetStrings(a, 'recommendedMcpTools'),
      packetStrings(b, 'recommendedMcpTools'),
    ),
  };
}

/** Parse durations like "7d", "2w", "24h", "30m". Returns ms or null. */
export function parseDurationToMs(input: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i.exec(input.trim());
  if (!m) return null;
  const value = Number(m[1]!);
  const unit = m[2]!.toLowerCase();
  const factors: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  const f = factors[unit];
  if (f === undefined || !Number.isFinite(value)) return null;
  return value * f;
}
