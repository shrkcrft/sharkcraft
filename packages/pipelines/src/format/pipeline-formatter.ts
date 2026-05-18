import type { IPipelineDefinition } from '../model/pipeline-definition.ts';

export function formatPipelineCompact(p: IPipelineDefinition): string {
  const tags = (p.tags ?? []).length ? ` tags=[${(p.tags ?? []).join(', ')}]` : '';
  const stepWord = p.steps.length === 1 ? 'step' : 'steps';
  return `${p.id.padEnd(28)} ${p.steps.length} ${stepWord} — ${p.title}${tags}`;
}

export function formatPipelineFull(p: IPipelineDefinition): string {
  const lines: string[] = [];
  lines.push(`# Pipeline: ${p.title}`);
  lines.push(`id: ${p.id}`);
  if (p.tags?.length) lines.push(`tags: ${p.tags.join(', ')}`);
  if (p.scope?.length) lines.push(`scope: ${p.scope.join(', ')}`);
  if (p.appliesWhen?.length) lines.push(`appliesWhen: ${p.appliesWhen.join(', ')}`);
  lines.push('');
  lines.push(p.description);
  if (p.inputs?.length) {
    lines.push('');
    lines.push('## Inputs');
    for (const i of p.inputs) {
      const req = i.required ? ' (required)' : '';
      const def = i.default !== undefined ? ` = ${i.default}` : '';
      const choices = i.choices?.length ? ` choices=[${i.choices.join(', ')}]` : '';
      const desc = i.description ? ` — ${i.description}` : '';
      lines.push(`- ${i.name}${req}${def}${choices}${desc}`);
    }
  }
  lines.push('');
  lines.push('## Steps');
  for (let idx = 0; idx < p.steps.length; idx += 1) {
    const step = p.steps[idx]!;
    const req = step.required === false ? ' (optional)' : '';
    const review = step.humanReview ? ' — human review' : '';
    const when = step.enabledWhen ? ` — enabledWhen ${step.enabledWhen}` : '';
    lines.push(`${idx + 1}. [${step.type}] ${step.id}${req}${review}${when}`);
    if (step.description) lines.push(`     ${step.description}`);
    if (step.instruction) lines.push(`     instruction: ${step.instruction}`);
    if (step.mcpTools?.length) lines.push(`     mcpTools: ${step.mcpTools.join(', ')}`);
    if (step.cliCommands?.length) {
      for (const c of step.cliCommands) lines.push(`     $ ${c}`);
    }
    if (step.references?.length) lines.push(`     references: ${step.references.join(', ')}`);
  }
  if (p.notes?.length) {
    lines.push('');
    lines.push('## Notes');
    for (const n of p.notes) lines.push(`- ${n}`);
  }
  return lines.join('\n');
}
