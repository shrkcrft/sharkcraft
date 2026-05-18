export type {
  IDashboardApiEnvelope,
  IDashboardArtifactRef,
  IDashboardCommandHint,
  IDashboardSafetyTag,
  DashboardSafetyLevel,
  IDashboardOverviewResponse,
  IDashboardDoctorResponse,
  IDashboardQualityResponse,
  IDashboardSafetyResponse,
  IDashboardCommandsResponse,
  IDashboardPacksResponse,
  IDashboardPresetsResponse,
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
} from '@shrkcrft/dashboard-api';

export interface IDashboardApiError {
  message: string;
  code?: string;
  status?: number;
}
