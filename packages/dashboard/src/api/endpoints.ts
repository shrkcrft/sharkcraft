import type {
  IDashboardAdoptionResponse,
  IDashboardArchitectureResponse,
  IDashboardBoundaryResponse,
  IDashboardCapabilitiesResponse,
  IDashboardCommandsResponse,
  IDashboardCompressionResponse,
  IDashboardCoverageResponse,
  IDashboardDoctorResponse,
  IDashboardDriftResponse,
  IDashboardGraphNodeResponse,
  IDashboardGraphPathResponse,
  IDashboardGraphResponse,
  IDashboardHealthResponse,
  IDashboardMcpResponse,
  IDashboardOnboardingResponse,
  IDashboardOverviewResponse,
  IDashboardPacksResponse,
  IDashboardPipelinesResponse,
  IDashboardPresetsResponse,
  IDashboardQualityResponse,
  IDashboardReportsResponse,
  IDashboardReviewResponse,
  IDashboardSafetyResponse,
  IDashboardScaffoldsResponse,
  IDashboardSchemasResponse,
  IDashboardSessionDetailResponse,
  IDashboardSessionsResponse,
  IDashboardStatsResponse,
  IDashboardCodeIntelligenceResponse,
  IDashboardRoutesResponse,
  IDashboardMigrationsResponse,
  IDashboardQualityGatesResponse,
  IDashboardKnowledgeListResponse,
  IDashboardKnowledgeEntryResponse,
  IDashboardKnowledgeGraphResponse,
  IDashboardKnowledgeAskResponse,
  IDashboardKnowledgeSimilarResponse,
} from './types.ts';
import { apiGet, type IRawApiResponse } from './client.ts';

export const getHealth = (signal?: AbortSignal): Promise<IRawApiResponse<IDashboardHealthResponse>> =>
  apiGet('/api/health', undefined, signal);
export const getCapabilities = (signal?: AbortSignal): Promise<IRawApiResponse<IDashboardCapabilitiesResponse>> =>
  apiGet('/api/capabilities', undefined, signal);
export const getOverview = (signal?: AbortSignal): Promise<IRawApiResponse<IDashboardOverviewResponse>> =>
  apiGet('/api/overview', undefined, signal);
export const getDoctor = (signal?: AbortSignal): Promise<IRawApiResponse<IDashboardDoctorResponse>> =>
  apiGet('/api/doctor', undefined, signal);
export const getQuality = (signal?: AbortSignal): Promise<IRawApiResponse<IDashboardQualityResponse>> =>
  apiGet('/api/quality', undefined, signal);
export const getSafety = (signal?: AbortSignal): Promise<IRawApiResponse<IDashboardSafetyResponse>> =>
  apiGet('/api/safety', undefined, signal);
export const getCommands = (signal?: AbortSignal): Promise<IRawApiResponse<IDashboardCommandsResponse>> =>
  apiGet('/api/commands', undefined, signal);
export const getPacks = (signal?: AbortSignal): Promise<IRawApiResponse<IDashboardPacksResponse>> =>
  apiGet('/api/packs', undefined, signal);
export const getCompression = (
  signal?: AbortSignal,
): Promise<IRawApiResponse<IDashboardCompressionResponse>> => apiGet('/api/compression', undefined, signal);
export const getPresets = (signal?: AbortSignal): Promise<IRawApiResponse<IDashboardPresetsResponse>> =>
  apiGet('/api/presets', undefined, signal);
export const getPipelines = (signal?: AbortSignal): Promise<IRawApiResponse<IDashboardPipelinesResponse>> =>
  apiGet('/api/pipelines', undefined, signal);
export const getSessions = (signal?: AbortSignal): Promise<IRawApiResponse<IDashboardSessionsResponse>> =>
  apiGet('/api/sessions', undefined, signal);
export const getSession = (
  id: string,
  signal?: AbortSignal,
): Promise<IRawApiResponse<IDashboardSessionDetailResponse>> =>
  apiGet(`/api/sessions/${encodeURIComponent(id)}`, undefined, signal);
export const getArchitecture = (signal?: AbortSignal): Promise<IRawApiResponse<IDashboardArchitectureResponse>> =>
  apiGet('/api/architecture', undefined, signal);
export const getBoundaries = (signal?: AbortSignal): Promise<IRawApiResponse<IDashboardBoundaryResponse>> =>
  apiGet('/api/architecture/boundaries', undefined, signal);
export const getDrift = (signal?: AbortSignal): Promise<IRawApiResponse<IDashboardDriftResponse>> =>
  apiGet('/api/architecture/drift', undefined, signal);
export const getCoverage = (signal?: AbortSignal): Promise<IRawApiResponse<IDashboardCoverageResponse>> =>
  apiGet('/api/architecture/coverage', undefined, signal);
export const getGraph = (signal?: AbortSignal): Promise<IRawApiResponse<IDashboardGraphResponse>> =>
  apiGet('/api/graph', undefined, signal);
export const getGraphNode = (
  id: string,
  signal?: AbortSignal,
): Promise<IRawApiResponse<IDashboardGraphNodeResponse>> =>
  apiGet(`/api/graph/node/${encodeURIComponent(id)}`, undefined, signal);
export const getGraphWhy = (
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<IRawApiResponse<IDashboardGraphPathResponse>> =>
  apiGet('/api/graph/why', { from, to }, signal);
export const getOnboarding = (signal?: AbortSignal): Promise<IRawApiResponse<IDashboardOnboardingResponse>> =>
  apiGet('/api/onboarding', undefined, signal);
export const getAdoption = (signal?: AbortSignal): Promise<IRawApiResponse<IDashboardAdoptionResponse>> =>
  apiGet('/api/onboarding/adoption', undefined, signal);
export const getReports = (signal?: AbortSignal): Promise<IRawApiResponse<IDashboardReportsResponse>> =>
  apiGet('/api/reports', undefined, signal);
export const getReview = (signal?: AbortSignal): Promise<IRawApiResponse<IDashboardReviewResponse>> =>
  apiGet('/api/review', undefined, signal);
export const getScaffolds = (signal?: AbortSignal): Promise<IRawApiResponse<IDashboardScaffoldsResponse>> =>
  apiGet('/api/scaffolds', undefined, signal);
export const getSchemas = (signal?: AbortSignal): Promise<IRawApiResponse<IDashboardSchemasResponse>> =>
  apiGet('/api/schemas', undefined, signal);
export const getMcp = (signal?: AbortSignal): Promise<IRawApiResponse<IDashboardMcpResponse>> =>
  apiGet('/api/mcp', undefined, signal);
export const getStats = (
  signal?: AbortSignal,
  opts?: { top?: number; language?: string },
): Promise<IRawApiResponse<IDashboardStatsResponse>> => {
  const params: Record<string, string> = {};
  if (opts?.top !== undefined) params['top'] = String(opts.top);
  if (opts?.language) params['language'] = opts.language;
  return apiGet('/api/stats', params, signal);
};
export const getCodeIntelligence = (
  signal?: AbortSignal,
): Promise<IRawApiResponse<IDashboardCodeIntelligenceResponse>> =>
  apiGet('/api/code-intelligence', undefined, signal);
export const getRoutes = (
  signal?: AbortSignal,
): Promise<IRawApiResponse<IDashboardRoutesResponse>> =>
  apiGet('/api/routes', undefined, signal);
export const getMigrations = (
  signal?: AbortSignal,
): Promise<IRawApiResponse<IDashboardMigrationsResponse>> =>
  apiGet('/api/migrations', undefined, signal);
export const getQualityGates = (
  signal?: AbortSignal,
): Promise<IRawApiResponse<IDashboardQualityGatesResponse>> =>
  apiGet('/api/quality-gates', undefined, signal);
export const getKnowledge = (
  signal?: AbortSignal,
): Promise<IRawApiResponse<IDashboardKnowledgeListResponse>> =>
  apiGet('/api/knowledge', undefined, signal);
export const getKnowledgeEntry = (
  id: string,
  signal?: AbortSignal,
): Promise<IRawApiResponse<IDashboardKnowledgeEntryResponse>> =>
  apiGet(`/api/knowledge/entry/${encodeURIComponent(id)}`, undefined, signal);
export const getKnowledgeGraph = (
  signal?: AbortSignal,
): Promise<IRawApiResponse<IDashboardKnowledgeGraphResponse>> =>
  apiGet('/api/knowledge/graph', undefined, signal);
export const getKnowledgeSimilar = (
  id: string,
  signal?: AbortSignal,
): Promise<IRawApiResponse<IDashboardKnowledgeSimilarResponse>> =>
  apiGet(`/api/knowledge/similar/${encodeURIComponent(id)}`, undefined, signal);
export const askKnowledge = (
  question: string,
  signal?: AbortSignal,
): Promise<IRawApiResponse<IDashboardKnowledgeAskResponse>> =>
  apiGet('/api/knowledge/ask', { q: question }, signal);
