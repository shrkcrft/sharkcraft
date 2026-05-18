/**
 * Render a `spec.md` scaffold from grounded inputs.
 *
 * The engine does NOT write the prose. The scaffold leaves
 * intent / motivation / acceptanceCriteria / risks deliberately
 * empty (with placeholder text the human / agent fills in). The
 * grounding fields (relevantRules / relevantKnowledge /
 * relevantPaths / proposedTemplates / verificationCommands) are
 * pre-populated from the recommender outputs the caller provides.
 *
 * Output is the markdown text of `spec.md`. Pure function; no IO.
 */

import { SPEC_SCHEMA_V1, SpecStatus } from './spec-model.ts';

export interface IRenderSpecMdInput {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly issue?: string | null;
  readonly relevantRules: readonly string[];
  readonly relevantKnowledge: readonly string[];
  readonly relevantPaths: readonly string[];
  readonly affectedPackages: readonly string[];
  readonly proposedTemplates: ReadonlyArray<{
    readonly templateId: string;
    readonly variables: Readonly<Record<string, string>>;
    readonly note?: string;
  }>;
  readonly verificationCommandIds: readonly string[];
}

export function renderSpecMd(input: IRenderSpecMdInput): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push(`schema: ${SPEC_SCHEMA_V1}`);
  lines.push(`id: ${input.id}`);
  lines.push(`slug: ${input.slug}`);
  lines.push(`title: ${quoteIfNeeded(input.title)}`);
  lines.push(`status: ${SpecStatus.Draft}`);
  lines.push(`createdAt: ${input.createdAt}`);
  lines.push(`updatedAt: ${input.updatedAt}`);
  lines.push('');
  lines.push('intent: |');
  lines.push('  TODO: one-paragraph statement of what is being built.');
  lines.push('');
  lines.push('motivation: |');
  lines.push('  TODO: why now. The forcing function. Cross-link to issue if any.');
  lines.push('');
  lines.push('acceptanceCriteria:');
  lines.push('  - id: ac-1');
  lines.push('    text: TODO: replace with a concrete, testable acceptance criterion.');
  lines.push('    verifiedBy:');
  lines.push('      - tests');
  lines.push('');
  lines.push('affectedAreas:');
  lines.push('  files:');
  lines.push('  packages:');
  for (const p of input.affectedPackages) lines.push(`    - ${quoteIfNeeded(p)}`);
  lines.push('  layers:');
  lines.push('');
  lines.push('relevantRules:');
  for (const r of input.relevantRules) lines.push(`  - ${quoteIfNeeded(r)}`);
  lines.push('');
  lines.push('relevantKnowledge:');
  for (const k of input.relevantKnowledge) lines.push(`  - ${quoteIfNeeded(k)}`);
  lines.push('');
  lines.push('relevantPaths:');
  for (const p of input.relevantPaths) lines.push(`  - ${quoteIfNeeded(p)}`);
  lines.push('');
  lines.push('proposedTemplates:');
  for (const t of input.proposedTemplates) {
    lines.push(`  - templateId: ${quoteIfNeeded(t.templateId)}`);
    lines.push('    variables:');
    for (const [k, v] of Object.entries(t.variables)) {
      lines.push(`      ${k}: ${quoteIfNeeded(v)}`);
    }
    if (t.note !== undefined) {
      lines.push(`    note: ${quoteIfNeeded(t.note)}`);
    }
  }
  lines.push('');
  lines.push('risks:');
  lines.push('  - id: r-1');
  lines.push('    text: TODO: identify a real risk this change introduces.');
  lines.push('    mitigation: TODO: how the change mitigates it.');
  lines.push('');
  lines.push('outOfScope:');
  lines.push('  - TODO: enumerate explicit non-goals.');
  lines.push('');
  lines.push('externalLinks:');
  lines.push(`  issue: ${input.issue ? quoteIfNeeded(input.issue) : 'null'}`);
  lines.push('  pr: null');
  lines.push('');
  lines.push('boundariesCheck:');
  lines.push('  predicted:');
  lines.push('');
  lines.push('verificationCommands:');
  for (const id of input.verificationCommandIds) {
    lines.push(`  - id: ${quoteIfNeeded(id)}`);
  }
  lines.push('---');
  lines.push('');
  lines.push(`# ${input.title}`);
  lines.push('');
  lines.push(
    'Body is free-form markdown. Architecture sketches, decision notes, design hazards.',
  );
  lines.push(
    'Specs must stay short — force structure. Keep this section under the configured byte cap.',
  );
  lines.push('');
  return lines.join('\n');
}

function quoteIfNeeded(s: string): string {
  // Bare strings are safe iff they contain no `:`, `#`, leading `-`,
  // and only printable ASCII besides whitespace.
  if (s.length === 0) return '""';
  if (/[:#\n\r\t]/.test(s)) return JSON.stringify(s);
  if (s.startsWith('-') || s.startsWith('?') || s.startsWith('!')) return JSON.stringify(s);
  return s;
}
