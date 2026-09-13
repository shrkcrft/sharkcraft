/**
 * The closed vocabulary of work a template deliberately does NOT perform.
 *
 * Two sibling templates used to differ on whether they emitted build config or
 * patched the workspace path map, and nothing machine-readable said so — a
 * generator whose output did not build read as a generator bug instead of a
 * documented remainder. `ITemplateDefinition.notScaffolded` / `manualSteps`
 * name the remainder with these values; template lint checks the shape, and
 * `gen` / `templates preview` / `templates get` print it.
 */
export enum TemplateRemainder {
  BuildConfig = 'build-config',
  PathAlias = 'path-alias',
  WorkspaceRegistration = 'workspace-registration',
  Tests = 'tests',
  Docs = 'docs',
  Other = 'other',
}

/** Every remainder value, for validation and error messages. */
export const TEMPLATE_REMAINDERS: readonly string[] = Object.freeze(Object.values(TemplateRemainder));

export function isTemplateRemainder(value: unknown): value is TemplateRemainder {
  return typeof value === 'string' && TEMPLATE_REMAINDERS.includes(value);
}

/**
 * The remainder as structured fields — the ONE machine shape: `templates get
 * --json` and MCP `get_template` both spread it (round 11 review R11-GAP-7:
 * MCP carried neither field, so an agent never learned what a template leaves
 * undone). Always present, `[]` when undeclared.
 */
export function templateRemainderFields(template: {
  readonly notScaffolded?: readonly string[];
  readonly manualSteps?: readonly { readonly description: string; readonly covers?: readonly string[] }[];
}): {
  readonly notScaffolded: readonly string[];
  readonly manualSteps: readonly { readonly description: string; readonly covers?: readonly string[] }[];
} {
  return { notScaffolded: template.notScaffolded ?? [], manualSteps: template.manualSteps ?? [] };
}

/**
 * {@link templateRemainderFields} with the empty fields left out — the compact
 * form a task packet's template rows carry (`task --json`, MCP
 * `get_task_packet`), so an undeclared remainder adds no bytes.
 */
export function templateRemainderSummary(template: {
  readonly notScaffolded?: readonly string[];
  readonly manualSteps?: readonly { readonly description: string; readonly covers?: readonly string[] }[];
}): {
  readonly notScaffolded?: readonly string[];
  readonly manualSteps?: readonly { readonly description: string; readonly covers?: readonly string[] }[];
} {
  return {
    ...(template.notScaffolded && template.notScaffolded.length > 0 ? { notScaffolded: template.notScaffolded } : {}),
    ...(template.manualSteps && template.manualSteps.length > 0 ? { manualSteps: template.manualSteps } : {}),
  };
}

/**
 * The printable remainder block for a template — the ONE wording every surface
 * (gen, templates preview/get) prints after `postGenerationNotes`. Empty when
 * the template declares neither field.
 */
export function templateRemainderLines(template: {
  readonly notScaffolded?: readonly string[];
  readonly manualSteps?: readonly { readonly description: string; readonly covers?: readonly string[] }[];
}): readonly string[] {
  const lines: string[] = [];
  if (template.notScaffolded && template.notScaffolded.length > 0) {
    lines.push(`Not scaffolded by this template: ${template.notScaffolded.join(', ')}`);
  }
  if (template.manualSteps && template.manualSteps.length > 0) {
    lines.push('Manual steps:');
    for (const step of template.manualSteps) {
      const covers = step.covers && step.covers.length > 0 ? ` (covers: ${step.covers.join(', ')})` : '';
      lines.push(`  • ${step.description}${covers}`);
    }
  }
  return lines;
}
