/**
 * Apply dispatch trace.
 *
 * Builds an explanation of which dispatch path an apply / plan-review will
 * take for a given saved plan: which kind of plan it is (template, helper,
 * plugin-lifecycle, registration-hint, synthetic, unknown), which handler
 * module would run, how many file/folder ops are involved, and which
 * safety gates apply.
 *
 * Read-only. Never spawns the actual apply.
 */
import type { ISavedPlan, ISavedPlanFolderOp } from '@shrkcrft/generator';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const APPLY_DISPATCH_TRACE_SCHEMA = 'sharkcraft.apply-dispatch-trace/v1';

export enum DispatchKind {
  Template = 'template',
  Helper = 'helper',
  RegistrationHint = 'registration-hint',
  Synthetic = 'synthetic',
  Unknown = 'unknown',
}

export type DispatchSource =
  | 'registry/template'
  | 'registry/helper'
  | 'registry/registration-hint'
  | 'synthetic'
  | 'unknown';

export interface IDispatchFileOpCounts {
  readonly create: number;
  readonly update: number;
  readonly append: number;
  readonly insertBefore: number;
  readonly insertAfter: number;
  readonly replace: number;
  readonly exportLine: number;
  readonly skip: number;
  readonly conflict: number;
}

export interface IDispatchFolderOpCounts {
  readonly renameFolder: number;
  readonly deleteFolder: number;
}

export interface IDispatchSafetyGate {
  readonly id:
    | 'signature'
    | 'divergence'
    | 'folder-ops-allow-flag'
    | 'folder-ops-safety'
    | 'delete-folder-allow-flag'
    | 'contract-gate';
  readonly status: 'not-checked' | 'will-pass' | 'will-block' | 'requires-flag';
  readonly detail?: string;
}

export interface IApplyDispatchTrace {
  readonly schema: typeof APPLY_DISPATCH_TRACE_SCHEMA;
  readonly templateId: string;
  readonly dispatchKind: DispatchKind;
  readonly source: DispatchSource;
  /** Best-effort handler description (module + symbol). */
  readonly handler: string;
  /** Whether the plan uses a synthetic templateId (prefix `__`). */
  readonly synthetic: boolean;
  /** Total file changes carried by the saved plan's expectedChanges. */
  readonly totalFileOps: number;
  /** Total folder operations carried by the saved plan. */
  readonly totalFolderOps: number;
  readonly fileOpCounts: IDispatchFileOpCounts;
  readonly folderOpCounts: IDispatchFolderOpCounts;
  /** Plan-v2 operation kinds (PlannedOperation.kind). */
  readonly plannedOperationKinds: ReadonlyArray<string>;
  /** Signature status as it would be after `--verify-signature`. */
  readonly signatureStatus:
    | 'not-checked'
    | 'verified'
    | 'unsigned'
    | 'invalid';
  readonly signatureMessage?: string;
  /** Gates the apply CLI would evaluate before writing. */
  readonly safetyGates: ReadonlyArray<IDispatchSafetyGate>;
  /** Flags the operator must pass for the apply to succeed. */
  readonly requiredFlags: ReadonlyArray<string>;
  /** Final action the apply would take in the current state. */
  readonly finalAction: 'dry-run' | 'blocked' | 'would-apply';
  /** When `blocked`, the reason(s). */
  readonly blockReasons: ReadonlyArray<string>;
}

export interface IBuildDispatchTraceOptions {
  /** Saved plan to trace. */
  readonly plan: ISavedPlan;
  /** Workspace inspection — used to look up template/helper/profile. */
  readonly inspection: ISharkcraftInspection;
  /** Pass `true` when the operator intends to use --dry-run. */
  readonly dryRun?: boolean;
  /** Pass `true` when --allow-folder-ops will be set. */
  readonly allowFolderOps?: boolean;
  /** Pass `true` when --allow-delete-folder will be set. */
  readonly allowDeleteFolder?: boolean;
  /** Pass `true` when --verify-signature will be set. */
  readonly verifySignature?: boolean;
  /** Pass `true` when the plan diverges from the live template output. */
  readonly diverged?: boolean;
  /** Optional contract gate status — when supplied, included as a gate. */
  readonly contractGate?: 'pass' | 'fail' | 'not-applicable';
}

const TEMPLATE_PREFIX_HELPER = '__helper__';
const TEMPLATE_PREFIX_REGISTRATION_HINT = '__registration-hint__';

function classifyTemplate(templateId: string): {
  kind: DispatchKind;
  source: DispatchSource;
  handler: string;
} {
  if (templateId.startsWith(TEMPLATE_PREFIX_HELPER)) {
    return {
      kind: DispatchKind.Helper,
      source: 'registry/helper',
      handler:
        '@shrkcrft/inspector/helper-registry + @shrkcrft/generator/synthetic-plan.evaluateSavedPlanInPlace',
    };
  }
  if (templateId.startsWith(TEMPLATE_PREFIX_REGISTRATION_HINT)) {
    return {
      kind: DispatchKind.RegistrationHint,
      source: 'registry/registration-hint',
      handler:
        '@shrkcrft/inspector/registration-hint-registry + @shrkcrft/generator/synthetic-plan.evaluateSavedPlanInPlace',
    };
  }
  if (templateId.startsWith('__')) {
    return {
      kind: DispatchKind.Synthetic,
      source: 'synthetic',
      handler: '@shrkcrft/generator/synthetic-plan.evaluateSavedPlanInPlace',
    };
  }
  return {
    kind: DispatchKind.Template,
    source: 'registry/template',
    handler: '@shrkcrft/templates + @shrkcrft/generator/generator-engine.generate',
  };
}

function countFileOps(
  plan: ISavedPlan,
): { counts: IDispatchFileOpCounts; total: number; opKinds: ReadonlyArray<string> } {
  const counts = {
    create: 0,
    update: 0,
    append: 0,
    insertBefore: 0,
    insertAfter: 0,
    replace: 0,
    exportLine: 0,
    skip: 0,
    conflict: 0,
  } as { [k: string]: number };
  let total = 0;
  const opKinds = new Set<string>();
  for (const change of plan.expectedChanges ?? []) {
    total += 1;
    const opKind = (change as { operation?: { kind?: string } }).operation?.kind;
    if (opKind) opKinds.add(opKind);
    const type = (change as { type?: string }).type;
    switch (type) {
      case 'create':
        counts['create']! += 1;
        break;
      case 'update':
        counts['update']! += 1;
        break;
      case 'append':
        counts['append']! += 1;
        break;
      case 'insert-before':
        counts['insertBefore']! += 1;
        break;
      case 'insert-after':
        counts['insertAfter']! += 1;
        break;
      case 'replace':
        counts['replace']! += 1;
        break;
      case 'export':
        counts['exportLine']! += 1;
        break;
      case 'skip':
        counts['skip']! += 1;
        break;
      case 'conflict':
        counts['conflict']! += 1;
        break;
      default:
        // unknown — leave counts as-is
        break;
    }
  }
  return {
    counts: counts as unknown as IDispatchFileOpCounts,
    total,
    opKinds: [...opKinds].sort(),
  };
}

function countFolderOps(
  ops: ReadonlyArray<ISavedPlanFolderOp>,
): { counts: IDispatchFolderOpCounts; total: number } {
  let renameFolder = 0;
  let deleteFolder = 0;
  for (const op of ops) {
    if (op.kind === 'rename-folder') renameFolder += 1;
    else if (op.kind === 'delete-folder') deleteFolder += 1;
  }
  return { counts: { renameFolder, deleteFolder }, total: ops.length };
}

export function buildApplyDispatchTrace(
  options: IBuildDispatchTraceOptions,
): IApplyDispatchTrace {
  const { plan, inspection, dryRun, allowFolderOps, allowDeleteFolder, verifySignature, diverged } =
    options;
  const synthetic = plan.templateId.startsWith('__');
  const classification = classifyTemplate(plan.templateId);

  const fileOps = countFileOps(plan);
  const folderOps = countFolderOps(plan.folderOps ?? []);
  const folderOpCount = folderOps.total;
  const deleteCount = folderOps.counts.deleteFolder;

  // Signature inference: we don't actually verify here; we just describe
  // what `--verify-signature` would emit. The full status is reported by
  // the apply CLI at run time.
  const signatureStatus: IApplyDispatchTrace['signatureStatus'] = verifySignature
    ? plan.signature
      ? 'verified'
      : 'unsigned'
    : 'not-checked';

  const safetyGates: IDispatchSafetyGate[] = [];
  const requiredFlags: string[] = [];
  const blockReasons: string[] = [];

  // 1) Signature gate.
  if (verifySignature) {
    if (plan.signature) {
      safetyGates.push({ id: 'signature', status: 'will-pass' });
    } else {
      safetyGates.push({
        id: 'signature',
        status: 'will-block',
        detail: 'plan is unsigned; --verify-signature will refuse',
      });
      blockReasons.push('unsigned plan with --verify-signature');
    }
  } else {
    safetyGates.push({ id: 'signature', status: 'not-checked' });
  }

  // 2) Divergence gate.
  if (diverged) {
    safetyGates.push({
      id: 'divergence',
      status: 'requires-flag',
      detail: 'plan diverged; --allow-divergent required',
    });
    requiredFlags.push('--allow-divergent');
  } else {
    safetyGates.push({ id: 'divergence', status: 'will-pass' });
  }

  // 3) Folder-op gates.
  if (folderOpCount > 0) {
    if (!allowFolderOps) {
      safetyGates.push({
        id: 'folder-ops-allow-flag',
        status: 'requires-flag',
        detail: `${folderOpCount} folder op(s) need --allow-folder-ops`,
      });
      requiredFlags.push('--allow-folder-ops');
    } else {
      safetyGates.push({ id: 'folder-ops-allow-flag', status: 'will-pass' });
    }
    if (deleteCount > 0 && !allowDeleteFolder) {
      safetyGates.push({
        id: 'delete-folder-allow-flag',
        status: 'requires-flag',
        detail: `${deleteCount} delete-folder op(s) also need --allow-delete-folder`,
      });
      requiredFlags.push('--allow-delete-folder');
    } else if (deleteCount > 0) {
      safetyGates.push({ id: 'delete-folder-allow-flag', status: 'will-pass' });
    }
    // The actual unsafe-ops gate runs at apply time; we surface as
    // not-checked here so callers know there is more to verify.
    safetyGates.push({
      id: 'folder-ops-safety',
      status: 'not-checked',
      detail: 'unsafe-op detection requires reading live disk; runs at apply',
    });
  }

  // 4) Contract gate (optional).
  if (options.contractGate === 'fail') {
    safetyGates.push({
      id: 'contract-gate',
      status: 'will-block',
      detail: 'contract gate fails — needs approval',
    });
    blockReasons.push('contract gate failure');
  } else if (options.contractGate === 'pass') {
    safetyGates.push({ id: 'contract-gate', status: 'will-pass' });
  }

  let finalAction: IApplyDispatchTrace['finalAction'];
  if (dryRun) finalAction = 'dry-run';
  else if (blockReasons.length > 0) finalAction = 'blocked';
  else finalAction = 'would-apply';

  // For template plans, verify the template actually exists in the
  // registry. If it doesn't, mark as unknown so the trace is honest.
  let resolvedKind = classification.kind;
  let resolvedSource = classification.source;
  let resolvedHandler = classification.handler;
  if (classification.kind === DispatchKind.Template) {
    const template = inspection.templateRegistry?.get?.(plan.templateId);
    if (!template) {
      resolvedKind = DispatchKind.Unknown;
      resolvedSource = 'unknown';
      resolvedHandler = 'template missing from registry';
      blockReasons.push(`template "${plan.templateId}" not registered`);
      if (finalAction === 'would-apply') finalAction = 'blocked';
    }
  }

  const trace: IApplyDispatchTrace = {
    schema: APPLY_DISPATCH_TRACE_SCHEMA,
    templateId: plan.templateId,
    dispatchKind: resolvedKind,
    source: resolvedSource,
    handler: resolvedHandler,
    synthetic,
    totalFileOps: fileOps.total,
    totalFolderOps: folderOpCount,
    fileOpCounts: fileOps.counts,
    folderOpCounts: folderOps.counts,
    plannedOperationKinds: fileOps.opKinds,
    signatureStatus,
    ...(plan.signature?.signedAt ? {} : {}),
    safetyGates,
    requiredFlags,
    finalAction,
    blockReasons,
  };
  return trace;
}

export function renderApplyDispatchTraceText(trace: IApplyDispatchTrace): string {
  const lines: string[] = [];
  lines.push('=== Apply dispatch trace ===');
  lines.push(`  schema           ${trace.schema}`);
  lines.push(`  templateId       ${trace.templateId}`);
  lines.push(`  dispatchKind     ${trace.dispatchKind}${trace.synthetic ? ' (synthetic)' : ''}`);
  lines.push(`  source           ${trace.source}`);
  lines.push(`  handler          ${trace.handler}`);
  lines.push(`  fileOps          ${trace.totalFileOps}`);
  lines.push(`  folderOps        ${trace.totalFolderOps}`);
  if (trace.plannedOperationKinds.length > 0) {
    lines.push(`  plan operations  ${trace.plannedOperationKinds.join(', ')}`);
  }
  lines.push(`  signature        ${trace.signatureStatus}`);
  if (trace.requiredFlags.length > 0) {
    lines.push(`  requires         ${trace.requiredFlags.join(' ')}`);
  }
  lines.push(`  finalAction      ${trace.finalAction}`);
  if (trace.blockReasons.length > 0) {
    lines.push('  blockReasons:');
    for (const r of trace.blockReasons) lines.push(`    • ${r}`);
  }
  lines.push('  safety gates:');
  for (const g of trace.safetyGates) {
    lines.push(`    ${g.id.padEnd(28)} ${g.status}${g.detail ? '  (' + g.detail + ')' : ''}`);
  }
  return lines.join('\n') + '\n';
}
