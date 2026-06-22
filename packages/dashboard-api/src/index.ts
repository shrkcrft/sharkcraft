/**
 * @shrkcrft/dashboard-api — versioned contract types for the SharkCraft
 * dashboard API. Types-only on purpose: a future React/Vite dashboard imports
 * these without pulling in any runtime weight.
 *
 * Wire schema id: `sharkcraft.dashboard-api/v1`.
 */
export { DASHBOARD_API_SCHEMA_ID, makeDashboardEnvelope } from './envelope.ts';
export type { IDashboardApiEnvelope, IDashboardApiSchemaId } from './envelope.ts';

export type {
  IDashboardArtifactRef,
  IDashboardCommandHint,
  IDashboardCount,
  IDashboardSafetyTag,
  IDashboardSection,
  DashboardSafetyLevel,
} from './common.ts';

export type {
  IDashboardOverviewResponse,
  IDashboardDoctorResponse,
  IDashboardQualityResponse,
  IDashboardSafetyResponse,
  IDashboardCommandsResponse,
  IDashboardPacksResponse,
  IDashboardPresetsResponse,
  IDashboardCompressionResponse,
  IDashboardPipelinesResponse,
  IDashboardSessionsResponse,
  IDashboardSessionDetailResponse,
  IDashboardArchitectureResponse,
  IDashboardBoundaryResponse,
  IDashboardDriftResponse,
  IDashboardCoverageResponse,
  IDashboardGraphResponse,
  IDashboardGraphNodeResponse,
  IDashboardGraphPathResponse,
  IDashboardOnboardingResponse,
  IDashboardAdoptionResponse,
  IDashboardReportsResponse,
  IDashboardReviewResponse,
  IDashboardScaffoldsResponse,
  IDashboardSchemasResponse,
  IDashboardMcpResponse,
  IDashboardHealthResponse,
  IDashboardCapabilitiesResponse,
  IDashboardErrorResponse,
  IDashboardStatsResponse,
  IDashboardStatsLanguage,
  IDashboardStatsTopFile,
  IDashboardCodeIntelligenceResponse,
  IDashboardGraphHub,
  IDashboardRoutesResponse,
  IDashboardRouteRow,
  IDashboardMigrationsResponse,
  IDashboardMigrationRow,
  IDashboardMigrationStep,
  IDashboardQualityGatesResponse,
  IDashboardQualityGate,
  IDashboardKnowledgeFacet,
  IDashboardKnowledgeSummary,
  IDashboardKnowledgeInsights,
  IDashboardKnowledgeListResponse,
  IDashboardKnowledgeSimilar,
  IDashboardKnowledgeSimilarResponse,
  IDashboardKnowledgeActionHints,
  IDashboardKnowledgeExample,
  IDashboardKnowledgeDetail,
  IDashboardKnowledgeNeighbor,
  IDashboardKnowledgeEntryResponse,
  IDashboardKnowledgeGraphResponse,
  IDashboardKnowledgeSource,
  IDashboardKnowledgeAskResponse,
} from './responses.ts';
