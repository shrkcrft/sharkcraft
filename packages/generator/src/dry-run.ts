import { existsSync, readFileSync } from 'node:fs';
import { safeResolveTargetPath, type UnsafeTargetPathError } from '@shrkcrft/core';
import {
  renderTemplate,
  validateTemplateVariables,
  type ITemplateChange,
  type ITemplateDefinition,
} from '@shrkcrft/templates';
import type { IGenerationRequest } from './generation-request.ts';
import type { IGenerationPlan } from './generation-plan.ts';
import { OverwriteStrategy } from './overwrite-strategy.ts';
import { FileChangeType, type IFileChange } from './file-change.ts';
import { decideForExisting, summarizeConflicts } from './conflict-handler.ts';
import { buildNameVariables } from './naming-strategy.ts';
import {
  evaluatePlannedChange,
  type IPlannedChange,
  type IPlannedOperation,
} from './planned-change.ts';

export interface IDryRunResult {
  plan: IGenerationPlan;
  /** True if the plan can be safely written without conflicts. */
  safe: boolean;
}

export function planGeneration(
  template: ITemplateDefinition,
  request: IGenerationRequest,
): IDryRunResult {
  const warnings: string[] = [];
  const overwriteStrategy = request.overwriteStrategy ?? OverwriteStrategy.Never;

  const nameVars = request.name ? buildNameVariables(request.name) : {};
  const merged = { ...nameVars, ...request.variables };
  const validation = validateTemplateVariables(template.variables, merged);
  if (!validation.valid) {
    for (const issue of validation.issues) warnings.push(`${issue.variable}: ${issue.message}`);
    return {
      plan: {
        templateId: template.id,
        templateName: template.name,
        changes: [],
        totalFiles: 0,
        hasConflicts: false,
        warnings,
        postGenerationNotes: template.postGenerationNotes ?? [],
      },
      safe: false,
    };
  }

  const rendered = renderTemplate(template, validation.resolved);
  const changes: IFileChange[] = [];

  // Per-file content overlay so that MULTIPLE changes (or a files() create
  // followed by a changes() op) targeting the SAME file COMPOSE. Without
  // this every change is evaluated against the original on-disk bytes and
  // the writer's last same-file write clobbers the earlier ones. Keyed by
  // absolute path → the cumulative content after the prior change(s).
  const overlay = new Map<string, string>();

  // 1) Legacy CREATE-only files() output — unchanged behaviour.
  for (const file of rendered.files) {
    let safe: ReturnType<typeof safeResolveTargetPath>;
    try {
      safe = safeResolveTargetPath(file.targetPath, request.projectRoot);
    } catch (e) {
      const err = e as UnsafeTargetPathError;
      changes.push({
        type: FileChangeType.Conflict,
        absolutePath: err.rawPath,
        relativePath: err.rawPath,
        contents: file.content,
        reason: `Refused unsafe target path (${err.code}): ${err.message}`,
        sizeBytes: Buffer.byteLength(file.content, 'utf8'),
      });
      continue;
    }

    const absolutePath = safe.absolutePath;
    const relPath = safe.relativePath;

    if (existsSync(absolutePath)) {
      let existing = '';
      try {
        existing = readFileSync(absolutePath, 'utf8');
      } catch {
        // unreadable existing file — treat as conflict
      }
      const decision = decideForExisting(
        file.overwrite ? OverwriteStrategy.Overwrite : overwriteStrategy,
        existing,
        file.content,
      );
      const contents = decision.type === FileChangeType.Skip ? existing : file.content;
      changes.push({
        type: decision.type,
        absolutePath,
        relativePath: relPath,
        contents,
        reason: decision.reason,
        sizeBytes: Buffer.byteLength(file.content, 'utf8'),
      });
      overlay.set(absolutePath, contents);
    } else {
      changes.push({
        type: FileChangeType.Create,
        absolutePath,
        relativePath: relPath,
        contents: file.content,
        reason: 'New file (does not exist)',
        sizeBytes: Buffer.byteLength(file.content, 'utf8'),
      });
      overlay.set(absolutePath, file.content);
    }
  }

  // 2) v2 planned changes — evaluate against the live filesystem, threaded
  //    through the overlay so successive changes to one file compose.
  for (const tplChange of rendered.changes) {
    const evaluated = planOne(tplChange, request.projectRoot, overlay);
    changes.push(evaluated);
  }

  const { hasConflicts } = summarizeConflicts(changes);

  return {
    plan: {
      templateId: template.id,
      templateName: template.name,
      changes,
      totalFiles: changes.length,
      hasConflicts,
      warnings,
      postGenerationNotes: rendered.postGenerationNotes,
    },
    safe: !hasConflicts && changes.length > 0,
  };
}

function planOne(
  tplChange: ITemplateChange,
  projectRoot: string,
  overlay?: Map<string, string>,
): IFileChange {
  const op: IPlannedOperation = tplChange.operation;
  let safe: ReturnType<typeof safeResolveTargetPath>;
  try {
    safe = safeResolveTargetPath(tplChange.targetPath, projectRoot);
  } catch (e) {
    const err = e as UnsafeTargetPathError;
    const previewContent = previewContentForOperation(op);
    return {
      type: FileChangeType.Conflict,
      absolutePath: err.rawPath,
      relativePath: err.rawPath,
      contents: previewContent,
      reason: `Refused unsafe target path (${err.code}): ${err.message}`,
      sizeBytes: Buffer.byteLength(previewContent, 'utf8'),
      operation: op,
    };
  }
  const change: IPlannedChange = {
    targetPath: tplChange.targetPath,
    operation: op,
  };
  // Prefer the overlay (cumulative result of prior same-file changes) over
  // the on-disk bytes so successive ops on one file compose deterministically.
  const existing = overlay?.has(safe.absolutePath)
    ? (overlay.get(safe.absolutePath) ?? null)
    : existsSync(safe.absolutePath)
      ? readFileSafe(safe.absolutePath)
      : null;
  const result = evaluatePlannedChange({
    change,
    absolutePath: safe.absolutePath,
    relativePath: safe.relativePath,
    existing,
  });
  // Record the cumulative content (Skip/Conflict carry the unchanged bytes,
  // which is exactly what a later op on the same file should see).
  overlay?.set(safe.absolutePath, result.contents);
  return result;
}

function readFileSafe(absolutePath: string): string | null {
  try {
    return readFileSync(absolutePath, 'utf8');
  } catch {
    return null;
  }
}

function previewContentForOperation(op: IPlannedOperation): string {
  switch (op.kind) {
    case 'create':
      return op.content;
    case 'append':
    case 'insert-after':
    case 'insert-before':
      return op.snippet;
    case 'replace':
      return op.replaceWith;
    case 'export':
      return op.symbols && op.symbols.length > 0
        ? `export { ${op.symbols.join(', ')} } from '${op.from}';`
        : `export * from '${op.from}';`;
    case 'ensure-import': {
      const parts: string[] = [];
      if (op.defaultBinding) parts.push(op.defaultBinding);
      if (op.namespaceBinding) parts.push(`* as ${op.namespaceBinding}`);
      if (op.symbols && op.symbols.length > 0) parts.push(`{ ${op.symbols.join(', ')} }`);
      const keyword = op.typeOnly ? 'import type' : 'import';
      return parts.length > 0
        ? `${keyword} ${parts.join(', ')} from '${op.from}';`
        : `${keyword} '${op.from}';`;
    }
    case 'insert-enum-entry':
      return `${op.enumName}.${op.entryName} = '${op.entryValue}'`;
    case 'insert-object-entry':
      return `${op.objectName}.${op.entryKey}: ${op.entryValue}`;
    case 'insert-array-entry':
      return `${op.arrayName} ⟵ ${op.entryValue}`;
    case 'insert-before-closing-brace':
      return op.snippet;
    case 'insert-between-anchors':
      return op.snippet;
  }
}
