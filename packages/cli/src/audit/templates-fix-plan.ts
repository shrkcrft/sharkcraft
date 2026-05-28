import type {
  AuditFindingSeverity,
  IAuditFinding,
  ILlmAuditFinding,
  ITemplateAuditEntry,
  ITemplateAuditReport,
} from './templates-audit.ts';

export type FixConfidence = 'high' | 'medium' | 'low';

export interface IFixInstruction {
  templateId: string;
  findingCategory: string;
  finding: string;
  severity: AuditFindingSeverity;
  intent: string;
  agentPrompt: string;
  confidence: FixConfidence;
  source: 'deterministic' | 'llm';
  /** Concrete suggestion attached by the LLM-enrichment pass when reachable. Advisory. */
  llmSuggestion?: string;
}

export interface ISkippedFinding {
  templateId: string;
  findingCategory: string;
  finding: string;
  reason: string;
}

export interface ITemplateFixPlan {
  fixPlanId: string;
  generatedAt: string;
  auditId: string;
  sourceFiles: readonly string[];
  fixes: readonly IFixInstruction[];
  skipped: readonly ISkippedFinding[];
  summary: {
    fixCount: number;
    highConfidence: number;
    mediumConfidence: number;
    lowConfidence: number;
    skipped: number;
  };
}

const TEMPLATES_FILE = 'sharkcraft/templates.ts';

export function buildFixPlan(report: ITemplateAuditReport): ITemplateFixPlan {
  const fixes: IFixInstruction[] = [];
  const skipped: ISkippedFinding[] = [];

  for (const entry of report.templates) {
    for (const f of entry.deterministicFindings) {
      const out = dispatchDeterministic(entry, f);
      if (out.kind === 'fix') fixes.push(out.fix);
      else skipped.push(out.skip);
    }
    for (const f of entry.llmFindings) {
      fixes.push(makeLlmFix(entry, f));
    }
  }

  const summary = {
    fixCount: fixes.length,
    highConfidence: fixes.filter((f) => f.confidence === 'high').length,
    mediumConfidence: fixes.filter((f) => f.confidence === 'medium').length,
    lowConfidence: fixes.filter((f) => f.confidence === 'low').length,
    skipped: skipped.length,
  };

  const generatedAt = new Date().toISOString();
  return {
    fixPlanId: `fix-${generatedAt.replace(/[:.]/g, '-')}`,
    generatedAt,
    auditId: report.auditId,
    sourceFiles: [TEMPLATES_FILE],
    fixes,
    skipped,
    summary,
  };
}

type DispatchResult = { kind: 'fix'; fix: IFixInstruction } | { kind: 'skip'; skip: ISkippedFinding };

function dispatchDeterministic(
  entry: ITemplateAuditEntry,
  f: IAuditFinding,
): DispatchResult {
  switch (f.category) {
    case 'unsafe-target':
      return {
        kind: 'skip',
        skip: {
          templateId: entry.templateId,
          findingCategory: f.category,
          finding: f.message,
          reason: 'security-sensitive — requires human review',
        },
      };
    case 'missing-name':
      return makeFix(entry, f, 'high',
        'Add a `name` field to this template.',
        [
          `Open ${TEMPLATES_FILE}. Find the template literal with id "${entry.templateId}".`,
          `Add a \`name: '<human-readable name>'\` field next to \`id\`.`,
          `The name should briefly describe what the template scaffolds (e.g. "CLI command (shrk subcommand)").`,
          `Do not change other fields. Verify the file still parses.`,
        ].join('\n'),
      );
    case 'missing-description':
      return makeFix(entry, f, 'high',
        'Add a `description` field to this template.',
        [
          `Open ${TEMPLATES_FILE}. Find the template literal with id "${entry.templateId}".`,
          `Add a \`description: '<one-sentence description>'\` field. The description appears in \`shrk templates list\` and should explain what the template generates.`,
          `Do not change other fields. Verify the file still parses.`,
        ].join('\n'),
      );
    case 'related-id-unresolved': {
      const id = extractQuoted(f.message);
      if (!id) {
        return makeFix(entry, f, 'medium',
          'Remove an unresolved related id (id could not be auto-extracted from the message).',
          [
            `Open ${TEMPLATES_FILE}. Find the template literal with id "${entry.templateId}".`,
            `The finding is: "${f.message}"`,
            `Remove the unresolved related id from the \`related\` array. Do not invent a replacement; if no real id applies, leave the array empty or omit the field.`,
            `Verify the file still parses.`,
          ].join('\n'),
        );
      }
      return makeFix(entry, f, 'high',
        `Remove "${id}" from the \`related\` array.`,
        [
          `Open ${TEMPLATES_FILE}. Find the template literal with id "${entry.templateId}".`,
          `In its \`related\` array, remove the string "${id}". Do not change any other entries.`,
          `Verify the file still parses and that "${id}" is not referenced elsewhere in the file.`,
        ].join('\n'),
      );
    }
    case 'undocumented-var': {
      const varName = extractQuoted(f.message);
      const where = varName ? `the variable named "${varName}"` : 'the variable referenced in the finding';
      return makeFix(entry, f, 'medium',
        varName
          ? `Add a description to variable "${varName}".`
          : 'Add a description to an undocumented variable.',
        [
          `Open ${TEMPLATES_FILE}. Find the template literal with id "${entry.templateId}".`,
          `Locate ${where} inside the \`variables\` array.`,
          `Add a \`description: '<short explanation>'\` field. The description should explain what the variable controls and where its value ends up in the generated output.`,
          `Verify the file still parses.`,
        ].join('\n'),
      );
    }
    case 'required-var-no-example': {
      const varName = extractQuoted(f.message);
      const where = varName ? `the variable named "${varName}"` : 'the required variable referenced in the finding';
      return makeFix(entry, f, 'medium',
        varName
          ? `Add an example value to required variable "${varName}".`
          : 'Add an example value to a required variable that lacks one.',
        [
          `Open ${TEMPLATES_FILE}. Find the template literal with id "${entry.templateId}".`,
          `Locate ${where} inside the \`variables\` array.`,
          `Add an \`examples: ['<sample value>']\` field. Choose a sample that's representative of real usage — readable by humans, valid against any \`pattern\` that may also be defined.`,
          `Verify the file still parses.`,
        ].join('\n'),
      );
    }
    case 'undeclared-var': {
      const varName = extractPlaceholder(f.message);
      const where = varName ? `\`{{${varName}}}\`` : 'the undeclared placeholder named in the finding';
      return makeFix(entry, f, 'medium',
        varName
          ? `Resolve undeclared placeholder ${where}.`
          : 'Resolve an undeclared placeholder in the template body.',
        [
          `Open ${TEMPLATES_FILE}. Find the template literal with id "${entry.templateId}".`,
          `The template body uses placeholder ${where} that isn't declared in \`variables[]\`.`,
          `Pick one:`,
          `  (a) Add a corresponding entry to \`variables[]\` (with \`name\`, \`required\`, and ideally a \`description\` + \`examples\`). This is right if the placeholder represents intended user input.`,
          `  (b) Remove the placeholder from the template body. This is right if it was a typo or leftover.`,
          `Choose based on what the surrounding body and template description imply. Verify the file still parses.`,
        ].join('\n'),
      );
    }
    case 'path-no-convention': {
      const samplePath = extractQuoted(f.message);
      return makeFix(entry, f, 'low',
        samplePath
          ? `Align template targetPath with path conventions (sample: "${samplePath}").`
          : 'Align template targetPath with path conventions.',
        [
          `The sample target path${samplePath ? ` "${samplePath}"` : ''} doesn't match any entry in \`sharkcraft/paths.ts\`.`,
          `Decide between two fixes:`,
          `  (a) Update the template's \`targetPath\` so its rendered output matches an existing path convention. Edit ${TEMPLATES_FILE}, find template "${entry.templateId}", and adjust its \`targetPath\` function/string.`,
          `  (b) Add a matching entry to \`sharkcraft/paths.ts\` if this template's output really does belong in a new location.`,
          `Prefer (a) unless the template represents a genuinely new file-shape for the project. Verify both files parse.`,
        ].join('\n'),
      );
    }
    default:
      return makeFix(entry, f, 'low',
        `Address finding "${f.category}".`,
        [
          `Open ${TEMPLATES_FILE}. Find the template literal with id "${entry.templateId}".`,
          `The audit reported: ${f.message}`,
          f.suggestion ? `Suggested fix from the inspector: ${f.suggestion}` : 'No specific suggestion was supplied — use judgment.',
          `Apply a minimal change that resolves the finding without touching unrelated fields. Verify the file still parses.`,
        ].filter(Boolean).join('\n'),
      );
  }
}

function makeFix(
  entry: ITemplateAuditEntry,
  f: IAuditFinding,
  confidence: FixConfidence,
  intent: string,
  agentPrompt: string,
): DispatchResult {
  return {
    kind: 'fix',
    fix: {
      templateId: entry.templateId,
      findingCategory: f.category,
      finding: f.message,
      severity: f.severity,
      intent,
      agentPrompt,
      confidence,
      source: 'deterministic',
    },
  };
}

function makeLlmFix(entry: ITemplateAuditEntry, f: ILlmAuditFinding): IFixInstruction {
  return {
    templateId: entry.templateId,
    findingCategory: f.category,
    finding: f.message,
    severity: f.severity,
    intent: `Review the LLM-flagged "${f.category}" finding and decide whether to act.`,
    agentPrompt: [
      `Open ${TEMPLATES_FILE}. Find the template literal with id "${entry.templateId}".`,
      `An LLM critique flagged (confidence ${f.confidence.toFixed(2)}): ${f.message}`,
      `LLM findings are advisory — verify against the template body and sibling templates before acting.`,
      `If you choose to act, keep the change minimal and scoped to the finding. If you don't, that's also a valid outcome — record the decision in your response.`,
    ].join('\n'),
    confidence: 'low',
    source: 'llm',
  };
}

function extractQuoted(message: string): string | null {
  const m = message.match(/"([^"]+)"/);
  return m ? m[1]! : null;
}

function extractPlaceholder(message: string): string | null {
  const m = message.match(/\{\{\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\}\}/);
  return m ? m[1]! : null;
}
