/**
 * `shrk spec list` data layer.
 *
 * Walks `.sharkcraft/specs/` and returns summaries that the CLI / MCP
 * tools render. Failure-soft: malformed specs surface as `error`
 * entries with an inline reason rather than aborting the whole list.
 */

import { existsSync, readFileSync } from 'node:fs';
import {
  deriveSpecJson,
  listSpecIds,
  splitSpecMd,
  specMdPath,
  specPlanPath,
  specVerificationPath,
  type ISpecJson,
  type SpecStatus,
} from '@shrkcrft/generator';

export const SPEC_LIST_SCHEMA = 'sharkcraft.spec-list/v1';

export interface ISpecListEntrySummary {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly status: SpecStatus | 'error';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly hasPlan: boolean;
  readonly hasVerification: boolean;
  readonly error?: string;
}

export interface ISpecListReport {
  readonly schema: typeof SPEC_LIST_SCHEMA;
  readonly projectRoot: string;
  readonly entries: readonly ISpecListEntrySummary[];
}

export function buildSpecList(projectRoot: string): ISpecListReport {
  const ids = listSpecIds(projectRoot);
  const entries: ISpecListEntrySummary[] = [];
  for (const id of ids) {
    entries.push(loadSummary(projectRoot, id));
  }
  return { schema: SPEC_LIST_SCHEMA, projectRoot, entries };
}

function loadSummary(projectRoot: string, id: string): ISpecListEntrySummary {
  const mdPath = specMdPath(projectRoot, id);
  if (!existsSync(mdPath)) {
    return {
      id,
      slug: '',
      title: '',
      status: 'error',
      createdAt: '',
      updatedAt: '',
      hasPlan: false,
      hasVerification: false,
      error: 'spec.md missing',
    };
  }
  let parsed: ISpecJson | null = null;
  let errorMessage: string | undefined;
  try {
    const raw = readFileSync(mdPath, 'utf8');
    const split = splitSpecMd(raw);
    if (!split.ok) {
      errorMessage = split.error.message;
    } else {
      const derived = deriveSpecJson(split.value);
      if (!derived.ok) errorMessage = derived.error.message;
      else parsed = derived.value;
    }
  } catch (e) {
    errorMessage = (e as Error).message;
  }
  const hasPlan = existsSync(specPlanPath(projectRoot, id));
  const hasVerification = existsSync(specVerificationPath(projectRoot, id));
  if (!parsed) {
    return {
      id,
      slug: '',
      title: '',
      status: 'error',
      createdAt: '',
      updatedAt: '',
      hasPlan,
      hasVerification,
      error: errorMessage,
    };
  }
  return {
    id: parsed.id,
    slug: parsed.slug,
    title: parsed.title,
    status: parsed.status,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    hasPlan,
    hasVerification,
  };
}
