import * as nodePath from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import {
  buildContradictionReport,
  buildGeneratedCodeReport,
  buildIngestAdoptionPlan,
  buildRepositoryKnowledgeModel,
  buildStabilityMap,
  IngestDepth,
  IngestSection,
  type IRepositoryKnowledgeModel,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

function nextHint(cmd: string): string {
  return `Next: \`${cmd}\` (CLI is the only write path).`;
}

function parseDepth(raw: unknown): IngestDepth {
  if (typeof raw !== 'string') return IngestDepth.Standard;
  const lower = raw.toLowerCase();
  for (const d of Object.values(IngestDepth)) if (d === lower) return d as IngestDepth;
  return IngestDepth.Standard;
}

function parseSections(raw: unknown): readonly IngestSection[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: IngestSection[] = [];
  for (const s of raw as unknown[]) {
    if (typeof s !== 'string') continue;
    for (const v of Object.values(IngestSection)) {
      if (v === s) out.push(v as IngestSection);
    }
  }
  return out.length > 0 ? out : undefined;
}

export const createRepositoryIngestionPlanTool: IToolDefinition = {
  name: 'create_repository_ingestion_plan',
  description: 'Build a SharkCraft repository knowledge model (read-only). Returns the model + a next-command hint. MCP never writes; pass --write-drafts to the CLI to materialise drafts under sharkcraft/ingestion/.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      depth: { type: 'string' },
      include: { type: 'array', items: { type: 'string' } },
      exclude: { type: 'array', items: { type: 'string' } },
      presets: { type: 'array', items: { type: 'string' } },
      task: { type: 'string' },
    },
  },
  async handler(input, ctx) {
    const model = await buildRepositoryKnowledgeModel({
      inspection: ctx.inspection,
      depth: parseDepth(input.depth),
      selectedSections: parseSections(input.include),
      excludedSections: parseSections(input.exclude),
      forcedPresetIds: Array.isArray(input.presets) ? (input.presets as string[]).filter((p) => typeof p === 'string') : undefined,
      ...(typeof input.task === 'string' ? { task: input.task } : {}),
    });
    return {
      text: nextHint('shrk ingest repository --write-drafts'),
      data: model,
    };
  },
};

export const getRepositoryKnowledgeModelTool: IToolDefinition = {
  name: 'get_repository_knowledge_model',
  description: 'Return the previously-saved repository knowledge model (`sharkcraft/ingestion/repository-knowledge-model.json`). Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler(_input, ctx) {
    const file = nodePath.join(ctx.cwd, 'sharkcraft', 'ingestion', 'repository-knowledge-model.json');
    if (!existsSync(file)) {
      return {
        isError: true,
        error: { code: 'not-found', message: 'No saved knowledge model. Run `shrk ingest repository --write-drafts` first.' },
      };
    }
    try {
      const body = JSON.parse(readFileSync(file, 'utf8')) as IRepositoryKnowledgeModel;
      return {
        text: nextHint('shrk ingest report --format markdown'),
        data: body,
      };
    } catch (err) {
      return {
        isError: true,
        error: { code: 'parse-failed', message: (err as Error).message },
      };
    }
  },
};

export const getRepositoryIngestionStatusTool: IToolDefinition = {
  name: 'get_repository_ingestion_status',
  description: 'Report whether ingest drafts/adoption files exist on disk. Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler(_input, ctx) {
    const base = nodePath.join(ctx.cwd, 'sharkcraft', 'ingestion');
    const modelExists = existsSync(nodePath.join(base, 'repository-knowledge-model.json'));
    const adoptionExists = existsSync(nodePath.join(base, 'adoption', 'ingest-adoption-state.json'));
    return {
      text: nextHint('shrk ingest status'),
      data: {
        ingestDirExists: existsSync(base),
        modelExists,
        adoptionExists,
      },
    };
  },
};

export const getRepositoryIngestionReportTool: IToolDefinition = {
  name: 'get_repository_ingestion_report',
  description: 'Return a markdown summary of the saved repository knowledge model. Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    const file = nodePath.join(ctx.cwd, 'sharkcraft', 'ingestion', 'REPOSITORY_KNOWLEDGE_MODEL.md');
    if (!existsSync(file)) {
      return {
        isError: true,
        error: { code: 'not-found', message: 'No saved report — run `shrk ingest repository --write-drafts` first.' },
      };
    }
    return {
      text: nextHint('shrk ingest report --format markdown'),
      data: { markdown: readFileSync(file, 'utf8') },
    };
  },
};

export const getContradictionReportTool: IToolDefinition = {
  name: 'get_contradiction_report',
  description: 'Detect documentation/code contradictions (missing paths, deprecated CLI usage, missing commands). Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    const report = buildContradictionReport({ inspection: ctx.inspection });
    return {
      text: nextHint('shrk contradictions --format markdown'),
      data: report,
    };
  },
};

export const getGeneratedCodeReportTool: IToolDefinition = {
  name: 'get_generated_code_report',
  description: 'Classify generated vs hand-written files; surface protect/policy recommendations. Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    const report = buildGeneratedCodeReport({ inspection: ctx.inspection });
    return {
      text: nextHint('shrk generated report --format markdown'),
      data: report,
    };
  },
};

export const getStabilityMapTool: IToolDefinition = {
  name: 'get_stability_map',
  description: 'Classify repo areas as stable/experimental/deprecated/legacy/generated/internal/public-api/high-risk. Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    const generated = buildGeneratedCodeReport({ inspection: ctx.inspection });
    const map = buildStabilityMap({
      inspection: ctx.inspection,
      generatedRoots: generated.generatedRoots.map((r) => r.path),
    });
    return {
      text: nextHint('shrk stability map --format markdown'),
      data: map,
    };
  },
};

export const getIngestAdoptionPreviewTool: IToolDefinition = {
  name: 'get_ingest_adoption_preview',
  description: 'Preview the ingest-adoption plan (safe-append / manual-review / low-confidence / already-covered / generated-protected). Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    const model = await buildRepositoryKnowledgeModel({ inspection: ctx.inspection });
    const plan = buildIngestAdoptionPlan({ model });
    return {
      text: nextHint('shrk ingest adopt --write-patch'),
      data: plan,
    };
  },
};
