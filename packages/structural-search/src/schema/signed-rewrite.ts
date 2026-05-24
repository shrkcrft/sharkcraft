import type { IRewritePlan } from './rewrite.ts';

export const SIGNED_REWRITE_SCHEMA = 'sharkcraft.structural-rewrite-plan-signed/v1' as const;

export interface ISignedRewriteProvenance {
  /** ISO timestamp of the signing event. */
  signedAt: string;
  /** Tool that signed the plan (`shrk search-structural` by default). */
  signedBy: string;
  /** SharkCraft / structural-search schema version of the inner plan. */
  planSchema: string;
}

export interface ISignedRewritePlan {
  schema: typeof SIGNED_REWRITE_SCHEMA;
  /** HMAC-SHA256 of the canonical-JSON inner plan + provenance, hex. */
  hmac: string;
  /** Algorithm identifier; always `sha256` for v1. */
  algo: 'sha256';
  provenance: ISignedRewriteProvenance;
  plan: IRewritePlan;
}
