import { readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  ApplyExitCategory,
  AssetKind,
  AssetProvenanceOperation,
  AssetProvenanceSource,
  buildApplyDispatchTrace,
  buildApplyGateResult,
  computeDevNextAction,
  DevSessionPhase,
  DevSessionPlanStatus,
  DevSessionSignatureStatus,
  detectSessionFromPlanPath,
  inspectSharkcraft,
  recomputePhase,
  recordAppliedPlan,
  recordProvenance,
  recordReportFile,
  recordValidation,
  renderApplyDispatchTraceText,
  scanDevSession,
  setDevNextAction,
  setDevSessionPhase,
  upsertDevPlanEntry,
  writeDevSessionState,
  type IApplyContractGateFailure,
  type IApplyDispatchTrace,
  type IDevSessionState,
} from '@shrkcrft/inspector';
import { applyAssetPreview } from '../asset-preview/apply-asset-preview.ts';
import {
  ApplyBatchPlanError,
  parseApplyBatchPlan,
  runApplyBatch,
} from '../task-next/apply-batch-runner.ts';
import {
  applyFolderOps,
  checkFolderOpSafety,
  diffPlanChanges,
  diffPlanFolderOps,
  evaluateSavedPlanInPlace,
  FileChangeType,
  FolderOpSafety,
  generate,
  isSyntheticTemplateId,
  OverwriteStrategy,
  readPlanFromFile,
  verifyPlan,
  writeSyntheticPlan,
  type IFolderOpInput,
  type ISavedPlanFolderOp,
} from '@shrkcrft/generator';
import {
  flagBool,
  flagList,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';
import { printError } from '../output/print-error.ts';
import { runValidationLoop } from '../validation/run-validation-loop.ts';

const CHANGE_LABEL: Record<FileChangeType, string> = {
  [FileChangeType.Create]: 'CREATE',
  [FileChangeType.Update]: 'UPDATE',
  [FileChangeType.Skip]: 'SKIP  ',
  [FileChangeType.Conflict]: 'CONFL ',
  [FileChangeType.Append]: 'APPEND',
  [FileChangeType.InsertAfter]: 'INSAFT',
  [FileChangeType.InsertBefore]: 'INSBEF',
  [FileChangeType.Replace]: 'REPL  ',
  [FileChangeType.Export]: 'EXPORT',
  [FileChangeType.RenameFolder]: 'RMFLDR',
  [FileChangeType.DeleteFolder]: 'DELFLD',
};

/**
 * `shrk apply --asset-preview <draft.ts> --target <file>`.
 *
 * Takes a draft (typically under `.sharkcraft/authoring/`) produced by
 * the authoring CLI (`knowledge add`, `rules scaffold`, etc.) and inserts
 * it into the canonical asset file. Dry-run by default; `--write` to
 * persist. Records provenance, surfaces signature status, prints
 * validation commands.
 */
async function runAssetPreviewApply(args: ParsedArgs, draftPath: string): Promise<number> {
  const target = flagString(args, 'target');
  if (!target) {
    process.stderr.write(
      'apply --asset-preview <draft.ts> requires --target <file>.\n',
    );
    return 2;
  }
  const wantJson = flagBool(args, 'json');
  const cwd = resolveCwd(args);
  const write = flagBool(args, 'write');
  const allowUnknownTarget = flagBool(args, 'allow-unknown-target');
  const reason = flagString(args, 'reason') ?? undefined;

  const result = applyAssetPreview({
    cwd,
    draftPath,
    targetPath: target,
    write,
    allowUnknownTarget,
  });

  if (!result.ok) {
    if (wantJson) {
      process.stdout.write(asJson({ schema: 'sharkcraft.asset-preview/v1', ...result }));
    } else {
      process.stderr.write(`Refused: ${result.refusal}\n`);
    }
    return 1;
  }

  // Record provenance when we actually wrote (or always for previews? Per
  // spec: "record provenance" on apply paths; dry-run is preview, not apply).
  if (result.wrote) {
    try {
      recordProvenance({
        projectRoot: cwd,
        entry: {
          operation: AssetProvenanceOperation.Apply,
          assetKind: result.targetKind === 'unknown' ? 'unknown' : (result.targetKind as AssetKind),
          assetId: nodePath.basename(result.draftAbs).replace(/\.draft\.ts$/, ''),
          targetFile: nodePath.relative(cwd, result.targetAbs),
          source: process.env['SHARKCRAFT_AGENT'] ? AssetProvenanceSource.Agent : AssetProvenanceSource.Cli,
          previewPath: nodePath.relative(cwd, result.draftAbs),
          ...(reason ? { reason } : {}),
        },
      });
    } catch (e) {
      // Provenance failures are advisory — do not block the apply.
      process.stderr.write(
        `(warning) failed to record provenance: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  if (wantJson) {
    process.stdout.write(
      asJson({
        schema: 'sharkcraft.asset-preview/v1',
        ...result,
      }),
    );
    return 0;
  }

  process.stdout.write(header(`apply --asset-preview${result.wrote ? '' : ' (dry-run)'}`));
  process.stdout.write(`  draft:       ${nodePath.relative(cwd, result.draftAbs)}\n`);
  process.stdout.write(`  target:      ${nodePath.relative(cwd, result.targetAbs)}\n`);
  process.stdout.write(`  target kind: ${result.targetKind}\n`);
  process.stdout.write(`  diff:        +${result.diff?.added ?? 0} / -${result.diff?.removed ?? 0} lines\n`);
  process.stdout.write(`  wrote:       ${result.wrote ? 'yes' : 'no (pass --write to persist)'}\n`);
  if (result.diff) {
    process.stdout.write('\n--- diff preview ---\n');
    process.stdout.write(result.diff.preview);
    process.stdout.write('\n--------------------\n');
  }
  process.stdout.write('\nNext (after review):\n');
  if (result.wrote) {
    if (result.targetKind === 'knowledge' || result.targetKind === 'rules' || result.targetKind === 'templates') {
      process.stdout.write(`  $ shrk packs signature-status   # pack assets may have changed\n`);
    }
    for (const v of result.validationCommands) {
      process.stdout.write(`  $ ${v}\n`);
    }
  } else {
    process.stdout.write(`  $ shrk apply --asset-preview ${nodePath.relative(cwd, result.draftAbs)} --target ${nodePath.relative(cwd, result.targetAbs)} --write\n`);
  }
  return 0;
}

/**
 * `shrk apply --batch <plan.json>` thin CLI wrapper around the pure
 * batch runner. Reads the plan, validates it, then dispatches each step
 * via subprocess. The runner records the batchId in environment so each
 * step's provenance can be grouped (callers may inspect
 * SHARKCRAFT_BATCH_ID in their provenance writers, which is a no-op
 * today — provenance grouping comes for free since the report carries
 * the batchId).
 */
async function runApplyBatchFromCli(args: ParsedArgs, batchPath: string): Promise<number> {
  const wantJson = flagBool(args, 'json');
  const cwd = resolveCwd(args);
  const allowDivergent = flagBool(args, 'allow-divergent');
  const dryRun = flagBool(args, 'dry-run');
  let raw: string;
  try {
    raw = readFileSync(nodePath.resolve(cwd, batchPath), 'utf8');
  } catch (e) {
    process.stderr.write(`Failed to read batch plan: ${(e as Error).message}\n`);
    return 1;
  }
  let plan;
  try {
    plan = parseApplyBatchPlan(raw);
  } catch (e) {
    if (e instanceof ApplyBatchPlanError) {
      if (wantJson) {
        process.stdout.write(asJson({ ok: false, refusal: e.message }) + '\n');
      } else {
        process.stderr.write(`Refused: ${e.message}\n`);
      }
      return 2;
    }
    throw e;
  }
  // Use the current process's argv[1] as the shrk binary — this preserves
  // the bun-direct invocation pattern used in dev and the symlinked
  // `shrk` in the user's PATH.
  const shrkBin = process.argv[1] ?? 'shrk';
  const report = runApplyBatch({
    plan,
    allowDivergent,
    dryRun,
    cwd,
    shrkBin,
  });
  if (wantJson) {
    process.stdout.write(asJson(report) + '\n');
    return report.success ? 0 : 1;
  }
  process.stdout.write(header(`apply --batch (${plan.steps.length} step(s))`));
  process.stdout.write(`  batchId:        ${report.batchId}\n`);
  process.stdout.write(`  allowDivergent: ${report.allowDivergent ? 'yes' : 'no'}\n`);
  process.stdout.write(`  dryRun:         ${dryRun ? 'yes' : 'no'}\n\n`);
  for (const s of report.steps) {
    process.stdout.write(
      `  step ${s.stepIndex}  ${s.kind.padEnd(18)}  ${s.outcome.padEnd(8)} (exit=${s.exitCode})\n`,
    );
  }
  if (report.stopped) {
    process.stdout.write(
      '\nStopped on first refusal. Pass --allow-divergent to skip refused steps and continue.\n',
    );
  }
  return report.success ? 0 : 1;
}

export const applyCommand: ICommandHandler = {
  name: 'apply',
  description:
    'Apply a previously-saved generation plan (sharkcraft.plan/v1 JSON). The CLI is the only write path; MCP never writes. Plans that live under .sharkcraft/sessions/<id>/plans/ automatically update the session metadata (signature + divergence + applied + validation).',
  usage:
    'shrk [--cwd <dir>] apply <plan.json> [--session <id>] [--force] [--allow-divergent] [--verify-signature] [--require-signature] [--no-verify-signature] [--dry-run] [--validate] [--report] [--json] [--trace] [--explain-dispatch] | shrk apply --asset-preview <draft.ts> --target <file> [--write] [--allow-unknown-target] [--reason <text>] | shrk apply --batch <plan.json> [--allow-divergent] [--dry-run] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    // Asset-preview flow: paste-with-review for authoring drafts.
    // Distinct from the plan-based apply path: takes a TS draft and a
    // target asset file, shows a diff, optionally writes.
    const assetPreview = flagString(args, 'asset-preview');
    if (assetPreview) {
      return await runAssetPreviewApply(args, assetPreview);
    }

    // Batch fix-chain runner. Reads a structured JSON plan, runs
    // each step via the existing `shrk fix --<kind> --apply --json`
    // surface, groups provenance under a content-hash batchId.
    const batchPath = flagString(args, 'batch');
    if (batchPath) {
      return await runApplyBatchFromCli(args, batchPath);
    }

    const planArg = args.positional[0];
    if (!planArg) {
      process.stderr.write('Usage: shrk apply <plan.json>\n');
      return 2;
    }

    const planPath = nodePath.resolve(planArg);
    const planResult = readPlanFromFile(planPath);
    if (!planResult.ok) {
      printError(planResult.error);
      return 1;
    }
    const saved = planResult.value;

    const force = flagBool(args, 'force');
    const allowDivergent = flagBool(args, 'allow-divergent');
    const wantJson = flagBool(args, 'json');
    const dryRun = flagBool(args, 'dry-run');
    const verifySig = flagBool(args, 'verify-signature') || flagBool(args, 'require-signature');
    const requireSig = flagBool(args, 'require-signature');
    const explicitSession = flagString(args, 'session');
    // Folder-op safety gates (default off).
    const allowFolderOps = flagBool(args, 'allow-folder-ops');
    const allowDeleteFolder = flagBool(args, 'allow-delete-folder');
    // Dispatch trace (read-only output, no behaviour change).
    const wantTrace = flagBool(args, 'trace') || flagBool(args, 'explain-dispatch');
    const explainOnly = flagBool(args, 'explain-dispatch');

    let signatureStatus: DevSessionSignatureStatus = DevSessionSignatureStatus.NotChecked;
    let signatureMessage: string | undefined;
    // A plan that CARRIES a signature self-enforces verification: the signature
    // is the producer's tamper-evidence declaration, so a signed plan must not
    // apply unverified just because the caller forgot --verify-signature
    // (contract: "Apply requires --verify-signature for signed plans"). A
    // tampered/invalid signature then refuses below. `--no-verify-signature` is
    // the explicit escape hatch for sign-here / apply-there-without-the-secret.
    const isSigned = Boolean(saved.signature);
    const skipSig = flagBool(args, 'no-verify-signature') && !verifySig;
    if (verifySig || (isSigned && !skipSig)) {
      const result = verifyPlan(saved);
      if (result.ok === true) {
        signatureStatus = DevSessionSignatureStatus.Verified;
        if (!wantJson) process.stdout.write(`Signature: verified ✓\n`);
      } else if (result.status === 'missing-signature' && !requireSig) {
        signatureStatus = DevSessionSignatureStatus.Unsigned;
        signatureMessage = result.message;
        if (!wantJson) {
          process.stdout.write(
            `Signature: not present (plan is unsigned). Pass --require-signature to refuse.\n`,
          );
        }
      } else {
        if (wantJson) {
          const gateResult = buildApplyGateResult({
            exitCategory: ApplyExitCategory.BlockedSignature,
            signatureStatus: { status: result.status, message: result.message },
            suggestedNextCommand: 'shrk gen --sign  # then re-run apply',
          });
          process.stdout.write(asJson({ signatureStatus: result.status, message: result.message, gateResult }) + '\n');
        } else {
          process.stderr.write(`Signature check failed (${result.status}): ${result.message}\n`);
        }
        return 1;
      }
    }

    // The plan's projectRoot is authoritative for the apply, but the user
    // can pass --cwd to override (for moved repos / new clone locations).
    // resolveCwd defaults to process.cwd(); only override the plan when the
    // user explicitly set --cwd.
    const explicitCwd =
      typeof args.flags.get('cwd') === 'string' || args.globalCwd !== undefined;
    const projectRoot = explicitCwd ? resolveCwd(args) : saved.projectRoot;

    // Detect whether the plan lives under .sharkcraft/sessions/<id>/plans/. The
    // --session flag overrides the path-based detection; both produce the same
    // metadata writes below.
    let sessionId: string | null = null;
    let sessionPlanFile: string | null = null;
    const detected = detectSessionFromPlanPath(planPath, projectRoot);
    if (explicitSession) {
      sessionId = explicitSession;
      sessionPlanFile = detected?.planFile ?? nodePath.basename(planPath);
    } else if (detected) {
      sessionId = detected.sessionId;
      sessionPlanFile = detected.planFile;
    }

    if (!wantJson) {
      process.stdout.write(header(`Applying plan: ${saved.templateId}`));
      process.stdout.write(`  source           ${planPath}\n`);
      process.stdout.write(`  project root     ${projectRoot}\n`);
      if (sessionId) process.stdout.write(`  session          ${sessionId}\n`);
      if (saved.name) process.stdout.write(`  name             ${saved.name}\n`);
      if (Object.keys(saved.variables).length) {
        process.stdout.write(
          `  variables        ${Object.entries(saved.variables)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')}\n`,
        );
      }
      process.stdout.write(`  saved at         ${saved.createdAt}\n\n`);
    }

    const inspection = await inspectSharkcraft({ cwd: projectRoot });

    // Build dispatch trace early so --explain-dispatch can short-circuit
    // before any contract / template lookup. Trace describes the path the
    // apply *would* take given the current flags.
    let dispatchTrace: IApplyDispatchTrace | null = null;
    if (wantTrace) {
      dispatchTrace = buildApplyDispatchTrace({
        plan: saved,
        inspection,
        dryRun,
        allowFolderOps,
        allowDeleteFolder,
        verifySignature: verifySig,
        diverged: false,
      });
      if (explainOnly) {
        if (wantJson) {
          process.stdout.write(asJson({ dispatchTrace }) + '\n');
        } else {
          process.stdout.write(renderApplyDispatchTraceText(dispatchTrace));
        }
        return 0;
      }
      if (!wantJson) {
        process.stdout.write(renderApplyDispatchTraceText(dispatchTrace));
        process.stdout.write('\n');
      }
    }

    // Opt-in contract gate. When --contract is supplied, the plan must
    // pass `shrk contract check` before apply will write anything. Without
    // --contract the apply behaviour is unchanged (no implicit gate).
    const contractFlag = flagString(args, 'contract');
    if (contractFlag) {
      const { checkAgentContract, renderContractCheckText } = await import('@shrkcrft/inspector');
      const absContract = nodePath.isAbsolute(contractFlag)
        ? contractFlag
        : nodePath.resolve(projectRoot, contractFlag);
      let contract;
      try {
        contract = JSON.parse(readFileSync(absContract, 'utf8'));
      } catch (e) {
        process.stderr.write(`Failed to read contract: ${(e as Error).message}\n`);
        return 1;
      }
      const approvalFlag = flagString(args, 'approval');
      const approvalPath = approvalFlag
        ? nodePath.isAbsolute(approvalFlag)
          ? approvalFlag
          : nodePath.resolve(projectRoot, approvalFlag)
        : undefined;
      const gate = await checkAgentContract(inspection, contract, {
        planPath,
        ...(approvalPath ? { approvalPath } : {}),
      });
      if (!gate.pass) {
        if (wantJson) {
          const failures: IApplyContractGateFailure[] = gate.gates
            .filter((g) => g.status === 'fail' || g.status === 'requires-approval')
            .map((g) => {
              const out: IApplyContractGateFailure = { id: g.id, status: g.status };
              if (g.detail !== undefined) out.detail = g.detail;
              return out;
            });
          const gateResult = buildApplyGateResult({
            exitCategory: ApplyExitCategory.BlockedContractGate,
            contractGateFailures: failures,
            suggestedNextCommand: `shrk contract approve ${nodePath.relative(projectRoot, absContract)} --by <you> --reason "<why>" --expires-in 2d --output <approval.json>`,
          });
          process.stdout.write(asJson({ contractGate: gate, gateResult }) + '\n');
        } else {
          process.stdout.write(renderContractCheckText(gate));
          process.stderr.write(`\nContract gate BLOCKED apply. Resolve the blocking gates or run with an --approval.\n`);
        }
        return 1;
      }
      if (!wantJson) {
        process.stdout.write(`Contract gate: PASS (${gate.contractHash.slice(0, 12)}…)\n`);
      }
    }

    const synthetic = isSyntheticTemplateId(saved.templateId);
    const template = synthetic ? null : inspection.templateRegistry.get(saved.templateId);
    if (!synthetic && !template) {
      process.stderr.write(
        `Template "${saved.templateId}" is no longer registered in ${projectRoot}.\n`,
      );
      return 1;
    }

    // Regenerate the plan fresh against current templates + project state.
    // Synthetic plans (templateId prefixed with `__`) evaluate their saved
    // operations against the current file system instead of running a
    // template renderer — there is no template to look up.
    let livePlan;
    if (synthetic) {
      livePlan = evaluateSavedPlanInPlace(saved, projectRoot);
    } else {
      const result = generate(template!, {
        templateId: saved.templateId,
        name: saved.name,
        variables: saved.variables,
        projectRoot,
        overwriteStrategy: force ? OverwriteStrategy.Overwrite : OverwriteStrategy.Never,
        write: false,
      });
      if (!result.ok) {
        printError(result.error);
        return 1;
      }
      livePlan = result.value.plan;
    }

    const diff = diffPlanChanges(saved, livePlan);
    if (diff.length > 0 && !allowDivergent && !force) {
      if (!wantJson) {
        process.stdout.write('Plan diverged from the saved version:\n');
        for (const d of diff) {
          process.stdout.write(`  ${d.kind.padEnd(13)} ${d.relativePath}`);
          if (d.detail) process.stdout.write(`  (${d.detail})`);
          process.stdout.write('\n');
        }
        process.stdout.write(
          '\nRefusing to apply. Re-run with --allow-divergent to apply the live plan, or regenerate the plan first.\n',
        );
      } else {
        const gateResult = buildApplyGateResult({
          exitCategory: ApplyExitCategory.BlockedDivergence,
          suggestedNextCommand: 'shrk apply --allow-divergent  # accept live plan',
        });
        process.stdout.write(asJson({ diverged: true, diff, gateResult }) + '\n');
      }
      // Refused divergence: session.json untouched per spec.
      return 1;
    }

    if (livePlan.hasConflicts) {
      const conflicts = livePlan.changes
        .filter((c) => c.type === FileChangeType.Conflict)
        .map((c) => c.relativePath);
      if (!wantJson) {
        process.stdout.write('Live plan has conflicts. Apply refused.\n');
        for (const change of livePlan.changes) {
          if (change.type === FileChangeType.Conflict) {
            process.stdout.write(
              `  ${CHANGE_LABEL[change.type]} ${change.relativePath} — ${change.reason}\n`,
            );
          }
        }
      } else {
        const gateResult = buildApplyGateResult({
          exitCategory: ApplyExitCategory.BlockedConflict,
          notes: conflicts.map((c) => `Conflict: ${c}`),
          suggestedNextCommand: 'shrk plan simulate <plan.json> --include-boundaries  # inspect conflicts',
        });
        process.stdout.write(asJson({ conflicts: true, conflictFiles: conflicts, plan: livePlan, gateResult }) + '\n');
      }
      // Conflicts: session.json untouched per spec.
      return 1;
    }

    // ─── Folder-op preflight ─────────────────────────────────────────────
    // Folder ops carried by saved plans must pass *all* checks before any
    // file or folder mutation happens. If a folder op is unsafe or the
    // allow flag is missing, refuse the whole apply (mixed file+folder).
    const plannedFolderOps: readonly ISavedPlanFolderOp[] = saved.folderOps ?? [];
    // Live folder ops: today we don't regenerate them from a template. We
    // use the saved set; divergence detection treats `saved.folderOps` ==
    // `livePlan.folderOps` for v1 wiring. Plugin-lifecycle plans (Part 2)
    // continue to carry their structured folderOps verbatim.
    const liveFolderOps: readonly ISavedPlanFolderOp[] = plannedFolderOps;
    const folderOpDiff = diffPlanFolderOps(saved, liveFolderOps);
    if (folderOpDiff.length > 0 && !allowDivergent && !force) {
      if (!wantJson) {
        process.stdout.write('Folder-op set diverged from the saved version:\n');
        for (const d of folderOpDiff) {
          process.stdout.write(`  ${d.kind.padEnd(13)} ${d.relativePath}`);
          if (d.detail) process.stdout.write(`  (${d.detail})`);
          process.stdout.write('\n');
        }
        process.stdout.write(
          '\nRefusing to apply. Re-run with --allow-divergent to accept the live folder-op set, or regenerate the plan first.\n',
        );
      } else {
        const gateResult = buildApplyGateResult({
          exitCategory: ApplyExitCategory.BlockedDivergence,
          suggestedNextCommand: 'shrk apply --allow-divergent  # accept live plan',
        });
        process.stdout.write(asJson({ diverged: true, folderOpDiff, gateResult }) + '\n');
      }
      return 1;
    }
    interface IFolderOpPreflight {
      op: ISavedPlanFolderOp;
      safety: FolderOpSafety;
      reason?: string;
    }
    const folderPreflight: IFolderOpPreflight[] = [];
    for (const op of plannedFolderOps) {
      const sopts: { allowDeleteFolder?: boolean } = {};
      if (allowDeleteFolder) sopts.allowDeleteFolder = true;
      const s = checkFolderOpSafety(projectRoot, op.targetPath, op.kind, sopts);
      const entry: IFolderOpPreflight = { op, safety: s.safety };
      if (s.reason !== undefined) entry.reason = s.reason;
      folderPreflight.push(entry);
    }
    const unsafeOps = folderPreflight.filter((f) => f.safety !== FolderOpSafety.Safe);
    const needsAllowFlag = plannedFolderOps.length > 0 && !allowFolderOps;
    if (unsafeOps.length > 0 || needsAllowFlag) {
      const exit = unsafeOps.length > 0
        ? ApplyExitCategory.BlockedFolderOpUnsafe
        : ApplyExitCategory.BlockedFolderOpAllowFlag;
      const suggested = unsafeOps.length > 0
        ? 'Resolve unsafe folder ops before re-running apply.'
        : 'shrk apply ... --allow-folder-ops  # enable folder ops';
      if (!wantJson) {
        if (unsafeOps.length > 0) {
          process.stdout.write('Folder ops are unsafe — refusing the entire plan:\n');
          for (const u of unsafeOps) {
            process.stdout.write(
              `  ${u.op.kind.toUpperCase()} ${u.op.targetPath}${
                u.op.newPath ? ` → ${u.op.newPath}` : ''
              } — ${u.reason ?? u.safety}\n`,
            );
          }
        } else {
          process.stdout.write(
            'Plan contains folder operations — refusing (pass --allow-folder-ops to enable):\n',
          );
          for (const f of folderPreflight) {
            process.stdout.write(
              `  ${f.op.kind.toUpperCase()} ${f.op.targetPath}${
                f.op.newPath ? ` → ${f.op.newPath}` : ''
              }\n`,
            );
          }
        }
      } else {
        const gateResult = buildApplyGateResult({
          exitCategory: exit,
          suggestedNextCommand: suggested,
          notes: folderPreflight.map(
            (f) => `${f.op.kind}:${f.op.targetPath} = ${f.safety}${f.reason ? ' (' + f.reason + ')' : ''}`,
          ),
        });
        process.stdout.write(
          asJson({
            folderOps: folderPreflight.map((f) => ({
              kind: f.op.kind,
              targetPath: f.op.targetPath,
              ...(f.op.newPath ? { newPath: f.op.newPath } : {}),
              safety: f.safety,
              ...(f.reason ? { reason: f.reason } : {}),
            })),
            gateResult,
          }) + '\n',
        );
      }
      return 1;
    }
    // Additional gate: any delete-folder requires --allow-delete-folder (the
    // safety check above only flagged when allowDeleteFolder was false).
    const deleteOps = plannedFolderOps.filter((o) => o.kind === 'delete-folder');
    if (deleteOps.length > 0 && !allowDeleteFolder) {
      if (!wantJson) {
        process.stdout.write(
          'Plan contains delete-folder ops — refusing (pass --allow-delete-folder in addition to --allow-folder-ops):\n',
        );
        for (const op of deleteOps) {
          process.stdout.write(`  DELETE-FOLDER ${op.targetPath}\n`);
        }
      } else {
        const gateResult = buildApplyGateResult({
          exitCategory: ApplyExitCategory.BlockedFolderOpAllowFlag,
          suggestedNextCommand:
            'shrk apply ... --allow-folder-ops --allow-delete-folder',
          notes: deleteOps.map((o) => `delete-folder:${o.targetPath} requires --allow-delete-folder`),
        });
        process.stdout.write(
          asJson({
            folderOps: deleteOps.map((o) => ({
              kind: o.kind,
              targetPath: o.targetPath,
              requires: '--allow-delete-folder',
            })),
            gateResult,
          }) + '\n',
        );
      }
      return 1;
    }
    // ──────────────────────────────────────────────────────────────────────────

    // Dry-run: report what would happen and bail before writing. Per spec,
    // dry-run must NOT mark the plan applied in session.json.
    if (dryRun) {
      if (wantJson) {
        process.stdout.write(
          asJson({
            applied: false,
            dryRun: true,
            planSummary: { changes: livePlan.changes.length },
            divergencesAccepted: diff.length > 0,
            folderOps: plannedFolderOps.map((o) => ({
              kind: o.kind,
              targetPath: o.targetPath,
              ...(o.newPath ? { newPath: o.newPath } : {}),
            })),
            session: sessionId ? { id: sessionId, planFile: sessionPlanFile } : null,
          }) + '\n',
        );
      } else {
        process.stdout.write('Dry-run only — no files written.\n');
        for (const change of livePlan.changes) {
          process.stdout.write(
            `${CHANGE_LABEL[change.type] ?? change.type.toUpperCase().padEnd(6)} ${change.relativePath}\n`,
          );
        }
        for (const op of plannedFolderOps) {
          const label = op.kind === 'rename-folder' ? CHANGE_LABEL[FileChangeType.RenameFolder] : CHANGE_LABEL[FileChangeType.DeleteFolder];
          process.stdout.write(
            `${label} ${op.targetPath}${op.newPath ? ` → ${op.newPath}` : ''}\n`,
          );
        }
      }
      return 0;
    }

    // Apply.
    let summary;
    let written;
    if (synthetic) {
      const sw = writeSyntheticPlan(livePlan);
      if (!sw.ok) {
        printError(sw.error);
        return 1;
      }
      summary = sw.value.summary;
      written = sw.value.written;
    } else {
      const writeResult = generate(template!, {
        templateId: saved.templateId,
        name: saved.name,
        variables: saved.variables,
        projectRoot,
        overwriteStrategy: force ? OverwriteStrategy.Overwrite : OverwriteStrategy.Never,
        write: true,
      });
      if (!writeResult.ok) {
        printError(writeResult.error);
        // Failed apply: session.json untouched per spec.
        return 1;
      }
      summary = writeResult.value.summary;
      written = writeResult.value.written;
    }

    // Execute folder ops after files. Safety has already been verified
    // and allow flags are present.
    const folderOpReport = plannedFolderOps.length > 0
      ? applyFolderOps(
          plannedFolderOps.map<IFolderOpInput>((o) => {
            const entry: IFolderOpInput = { kind: o.kind, targetPath: o.targetPath };
            if (o.newPath !== undefined) (entry as { newPath?: string }).newPath = o.newPath;
            return entry;
          }),
          {
            projectRoot,
            dryRun: false,
            ...(allowFolderOps ? { allowFolderOps: true } : {}),
            ...(allowDeleteFolder ? { allowDeleteFolder: true } : {}),
          },
        )
      : null;
    if (folderOpReport && folderOpReport.rejected.length > 0) {
      if (!wantJson) {
        process.stdout.write('Some folder ops failed during apply:\n');
        for (const r of folderOpReport.rejected) {
          process.stdout.write(
            `  ${r.op.kind.toUpperCase()} ${r.op.targetPath}${
              r.op.newPath ? ` → ${r.op.newPath}` : ''
            } — ${r.reason ?? 'unknown'}\n`,
          );
        }
      } else {
        const gateResult = buildApplyGateResult({
          exitCategory: ApplyExitCategory.BlockedFolderOpUnsafe,
          suggestedNextCommand: 'Inspect rejected folder ops and re-run apply.',
        });
        process.stdout.write(asJson({ folderOpReport, gateResult }) + '\n');
      }
      return 1;
    }

    // ─── Session-aware bookkeeping ────────────────────────────────────────────
    // The CLI is the only write path; if this plan lives in a session, mark it
    // applied with full provenance: changed files, signature, divergence.
    let updatedNextAction: string | null = null;
    if (sessionId && sessionPlanFile) {
      const updated = updateSessionAfterApply({
        cwd: projectRoot,
        sessionId,
        planFile: sessionPlanFile,
        changedFiles: written.map((w) => w.relativePath),
        signatureStatus,
        divergenceAccepted: diff.length > 0,
      });
      updatedNextAction = updated?.nextAction ?? null;
    }

    if (wantJson && !flagBool(args, 'validate')) {
      process.stdout.write(
        asJson({
          applied: true,
          summary,
          written: written.map((w) => w.relativePath),
          divergencesAccepted: diff.length > 0,
          signatureStatus,
          ...(signatureMessage ? { signatureMessage } : {}),
          ...(folderOpReport
            ? {
                folderOps: folderOpReport.applied.map((r) => ({
                  kind: r.op.kind,
                  targetPath: r.op.targetPath,
                  ...(r.op.newPath ? { newPath: r.op.newPath } : {}),
                  applied: r.applied,
                })),
              }
            : {}),
          ...(dispatchTrace ? { dispatchTrace } : {}),
          session: sessionId
            ? { id: sessionId, planFile: sessionPlanFile, nextAction: updatedNextAction }
            : null,
        }) + '\n',
      );
      return 0;
    }
    if (!wantJson) {
      for (const change of written) {
        process.stdout.write(
          `${CHANGE_LABEL[change.type]} ${change.relativePath} (${change.sizeBytes} bytes)\n`,
        );
      }
      if (folderOpReport) {
        for (const r of folderOpReport.applied) {
          const label = r.op.kind === 'rename-folder' ? CHANGE_LABEL[FileChangeType.RenameFolder] : CHANGE_LABEL[FileChangeType.DeleteFolder];
          process.stdout.write(
            `${label} ${r.op.targetPath}${r.op.newPath ? ` → ${r.op.newPath}` : ''}\n`,
          );
        }
      }
      process.stdout.write(
        `\nApplied. written=${summary.written}, skipped=${summary.skipped}, conflicts=${summary.conflicts}${
          folderOpReport ? `, folderOps=${folderOpReport.applied.length}` : ''
        }\n`,
      );
      if (sessionId) {
        process.stdout.write(`Session ${sessionId}: plan ${sessionPlanFile} marked applied.\n`);
        if (updatedNextAction) {
          process.stdout.write(`Next: ${updatedNextAction}\n`);
        }
      }
    }

    if (flagBool(args, 'validate')) {
      const validateStrict = flagBool(args, 'validate-strict') || flagBool(args, 'strict');
      const cmd = flagString(args, 'command');
      const verificationIds = flagList(args, 'verification');
      const allVerifications = flagBool(args, 'all-verifications');
      const allowPackCommands = flagBool(args, 'allow-pack-commands');
      const startedAt = new Date().toISOString();
      const reportFileName = `apply-${startedAt.replace(/[:.]/g, '-')}.json`;
      // Session-aware: write the validation report under the session's
      // reports/ directory when this plan belongs to a session; otherwise
      // fall back to the project-level .sharkcraft/reports/.
      const reportDir = sessionId
        ? nodePath.join(projectRoot, '.sharkcraft', 'sessions', sessionId, 'reports')
        : flagBool(args, 'report')
          ? nodePath.join(projectRoot, '.sharkcraft', 'reports')
          : null;
      const validation = await runValidationLoop({
        cwd: projectRoot,
        ...(cmd ? { explicitCommand: cmd } : {}),
        verificationIds,
        allVerifications,
        allowPackCommands,
        reportDir,
        reportFileName,
        onCommandStart: (label) => {
          if (!wantJson) process.stdout.write(`  → running: ${label}\n`);
        },
      });
      const finishedAt = new Date().toISOString();
      const failed =
        !validation.passed || (validateStrict && validation.warnings > 0);

      // Session-aware: append validation entry to session.json, link to the
      // applied plan, set phase to validated / validation_failed, recompute
      // nextAction.
      let validationNextAction: string | null = updatedNextAction;
      if (sessionId && sessionPlanFile) {
        const after = recordSessionValidation({
          cwd: projectRoot,
          sessionId,
          planFile: sessionPlanFile,
          startedAt,
          finishedAt,
          reportFile: reportFileName,
          passed: !failed,
          warnings: validation.warnings,
          commandsRun: validation.commandsRun.map((c) => {
            const entry: { command: string; passed: boolean; note?: string } = {
              command: c.command,
              passed: c.passed,
            };
            if (c.note !== undefined) entry.note = c.note;
            return entry;
          }),
          boundaryViolations: validation.boundaryViolations,
        });
        validationNextAction = after?.nextAction ?? updatedNextAction;
      }

      if (wantJson) {
        process.stdout.write(
          asJson({
            applied: true,
            summary,
            written: written.map((w) => w.relativePath),
            divergencesAccepted: diff.length > 0,
            signatureStatus,
            ...(signatureMessage ? { signatureMessage } : {}),
            validation: {
              passed: !failed,
              warnings: validation.warnings,
              boundaryViolations: validation.boundaryViolations,
              commandsRun: validation.commandsRun,
              commandsFailed: validation.commandsFailed,
              reportPath: validation.reportPath,
            },
            ...(dispatchTrace ? { dispatchTrace } : {}),
            session: sessionId
              ? {
                  id: sessionId,
                  planFile: sessionPlanFile,
                  nextAction: validationNextAction,
                }
              : null,
          }) + '\n',
        );
        return failed ? 1 : 0;
      }

      process.stdout.write(
        `\nValidation: ${validation.commandsRun.length} command(s), ${validation.commandsFailed.length} failed, ${validation.warnings} warning(s)\n`,
      );
      for (const c of validation.commandsRun) {
        process.stdout.write(
          `  ${c.passed ? 'OK   ' : 'FAIL '} ${c.command}${c.note ? '  (' + c.note + ')' : ''}\n`,
        );
      }
      if (validation.boundaryViolations > 0) {
        process.stdout.write(
          `  WARN  ${validation.boundaryViolations} boundary violation(s) detected\n`,
        );
      }
      if (validation.reportPath) {
        process.stdout.write(`  Report: ${validation.reportPath}\n`);
      }
      if (failed) {
        process.stdout.write('\nValidation: FAILED\n');
        return 1;
      }
      process.stdout.write('\nValidation: OK ✓\n');
    }
    return 0;
  },
};

interface IUpdateAfterApply {
  cwd: string;
  sessionId: string;
  planFile: string;
  changedFiles: readonly string[];
  signatureStatus: DevSessionSignatureStatus;
  divergenceAccepted: boolean;
}

function updateSessionAfterApply(input: IUpdateAfterApply): IDevSessionState | null {
  const load = scanDevSession(input.cwd, input.sessionId);
  if (!load || !load.state) return null;
  let state: IDevSessionState = load.state;
  const appliedAt = new Date().toISOString();
  state = recordAppliedPlan(state, {
    file: input.planFile,
    appliedAt,
    note: input.divergenceAccepted ? 'applied with divergence accepted' : 'applied via shrk apply',
    changedFiles: [...input.changedFiles],
    signatureStatus: input.signatureStatus,
    divergenceAccepted: input.divergenceAccepted,
    conflicts: [],
  });
  // Promote the matching plan entry to "applied" so dev status reflects it.
  const existing = load.state.plans.find((p) => p.file === input.planFile);
  if (existing) {
    state = upsertDevPlanEntry(state, {
      name: existing.name,
      templateId: existing.templateId,
      ...(existing.generatedName ? { generatedName: existing.generatedName } : {}),
      variables: { ...existing.variables },
      missingVariables: existing.missingVariables,
      status: DevSessionPlanStatus.Applied,
      file: existing.file,
      signed: existing.signed,
      ...(existing.reviewReportFile ? { reviewReportFile: existing.reviewReportFile } : {}),
      ...(existing.reviewReportMarkdownFile
        ? { reviewReportMarkdownFile: existing.reviewReportMarkdownFile }
        : {}),
    });
  }
  const scanAfter = scanDevSession(input.cwd, input.sessionId)!;
  const newPhase = recomputePhase(state, scanAfter);
  state = setDevSessionPhase(state, newPhase);
  const next = computeDevNextAction({ ...scanAfter, state });
  state = setDevNextAction(state, next.command);
  return writeDevSessionState(input.cwd, state);
}

interface IRecordValidationInput {
  cwd: string;
  sessionId: string;
  planFile: string;
  startedAt: string;
  finishedAt: string;
  reportFile: string;
  passed: boolean;
  warnings: number;
  commandsRun: readonly { command: string; passed: boolean; note?: string }[];
  boundaryViolations: number;
}

function recordSessionValidation(input: IRecordValidationInput): IDevSessionState | null {
  const load = scanDevSession(input.cwd, input.sessionId);
  if (!load || !load.state) return null;
  let state = recordValidation(load.state, {
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    reportFile: input.reportFile,
    passed: input.passed,
    warnings: input.warnings,
    commandsRun: input.commandsRun.map((c) => {
      const entry: { command: string; passed: boolean; note?: string } = {
        command: c.command,
        passed: c.passed,
      };
      if (c.note !== undefined) entry.note = c.note;
      return entry;
    }),
    boundaryViolations: input.boundaryViolations,
  });
  state = recordReportFile(state, `reports/${input.reportFile}`);
  const scanAfter = scanDevSession(input.cwd, input.sessionId)!;
  const newPhase = input.passed
    ? DevSessionPhase.Validated
    : DevSessionPhase.ValidationFailed;
  state = setDevSessionPhase(state, newPhase);
  const next = computeDevNextAction({ ...scanAfter, state });
  state = setDevNextAction(state, next.command);
  return writeDevSessionState(input.cwd, state);
}

