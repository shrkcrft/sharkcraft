/**
 * Render a pack/local helper's DECLARATIVE operations into a helper plan.
 *
 * `IPackHelperOperationInput` kinds existed only as a type — no code mapped
 * them to plan ops, so a valid pack helper could never be planned. This is the
 * one renderer; it never executes pack code (operations are data) and never
 * writes. Placeholders go through the shared `substitutePlaceholders`.
 */
import type { IHelperPlan, IHelperPlanOp } from './helper-registry.ts';
import type { IHelperView } from './helper-view.ts';
import { substitutePlaceholders } from './substitute-placeholders.ts';

const UNRESOLVED = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/;

/**
 * Build the plan for one catalog helper with `vars`. Declared defaults apply
 * first; a required variable with no value is a refusal (`ok: false`) naming
 * every missing one — never a plan with blank snippets.
 */
export function buildPackHelperPlan(
  helper: IHelperView,
  vars: Readonly<Record<string, string>>,
): { readonly ok: true; readonly plan: IHelperPlan } | { readonly ok: false; readonly missing: readonly string[]; readonly message: string } {
  const values: Record<string, string> = {};
  for (const v of helper.variables) if (v.defaultValue !== undefined) values[v.name] = v.defaultValue;
  Object.assign(values, vars);
  const missing = helper.variables.filter((v) => v.required && !values[v.name]).map((v) => v.name);
  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      message: `Helper "${helper.id}" requires ${missing.map((m) => `--var ${m}=<value>`).join(' ')}.`,
    };
  }
  const sub = (s: string | undefined): string => (s === undefined ? '' : substitutePlaceholders(s, values));
  const ops: IHelperPlanOp[] = [];
  const manualSteps: { kind: string; description: string }[] = [];
  const conflicts: string[] = [];
  const asChecklist = helper.outputKind === 'checklist';

  helper.operations.forEach((op, i) => {
    const at = `operations[${i}] (${op.kind})`;
    const targetPath = sub(op.targetPath);
    if (op.kind === 'manual-checklist') {
      for (const item of op.checklist ?? []) manualSteps.push({ kind: 'manual-checklist', description: sub(item) });
      return;
    }
    if (asChecklist) {
      manualSteps.push({ kind: op.kind, description: `${sub(op.description) || op.kind} — ${targetPath}` });
      return;
    }
    let planned: IHelperPlanOp;
    if (op.kind === 'append-line') {
      planned = { kind: 'append', targetPath, snippet: sub(op.snippet) };
    } else if (op.kind === 'insert-before') {
      planned = { kind: 'insert-before', targetPath, anchor: sub(op.anchor), snippet: sub(op.snippet) };
    } else if (op.kind === 'replace-line') {
      planned = { kind: 'replace', targetPath, fromPattern: sub(op.find), snippet: sub(op.replaceWith) };
    } else {
      // remove-line: a replace with an empty snippet.
      planned = { kind: 'replace', targetPath, fromPattern: sub(op.find), snippet: '' };
    }
    ops.push(planned);
    for (const [field, value] of Object.entries(planned)) {
      if (typeof value !== 'string') continue;
      const m = UNRESOLVED.exec(value);
      if (m) conflicts.push(`${at}.${field} still contains {{${m[1]}}} — no value was supplied for "${m[1]}"`);
    }
  });
  for (const item of helper.manualChecklist) manualSteps.push({ kind: 'checklist', description: sub(item) });

  return {
    ok: true,
    plan: {
      schema: 'sharkcraft.helper-plan/v1',
      helperId: helper.id,
      generatedAt: new Date().toISOString(),
      ops,
      conflicts,
      manualSteps,
      destructive: helper.destructive,
      requiresHumanReview: helper.requiresHumanReview,
    },
  };
}
