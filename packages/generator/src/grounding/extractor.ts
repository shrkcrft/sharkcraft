/**
 * `IPlanExtractor` contract.
 *
 * An extractor turns an external plan/spec file (markdown, JSON, …)
 * into an `IExtractedPlan` view for the shared validator. Extractors
 * are read-only — they never modify the source.
 */

import type { AppError, Result } from '@shrkcrft/core';
import type { IExtractedPlan } from './extracted-plan.ts';

/** Field-map: external key → canonical IExtractedPlan key. */
export type ExtractorFieldMap = Readonly<Record<string, string>>;

export interface IExtractorContext {
  readonly source: string;
  readonly fieldMap?: ExtractorFieldMap;
}

export interface IPlanExtractor {
  readonly id: string;
  readonly description: string;
  /** Quick check: does this extractor accept this file path? */
  readonly accepts: (path: string) => boolean;
  /** Parse the raw file content into the canonical view. */
  readonly extract: (raw: string, ctx: IExtractorContext) => Result<IExtractedPlan, AppError>;
}
