import { describe, expect, test } from 'bun:test';
import {
  DASHBOARD_API_SCHEMA_ID,
  makeDashboardEnvelope,
  type IDashboardApiEnvelope,
  type IDashboardOverviewResponse,
  type IDashboardCapabilitiesResponse,
  type IDashboardHealthResponse,
  type IDashboardAdoptionResponse,
  type IDashboardSessionsResponse,
} from '../index.ts';

describe('@shrkcrft/dashboard-api envelope', () => {
  test('schema id is the v1 marker', () => {
    expect(DASHBOARD_API_SCHEMA_ID).toBe('sharkcraft.dashboard-api/v1');
  });

  test('envelope round-trips through JSON', () => {
    const env = makeDashboardEnvelope<IDashboardOverviewResponse>({
      projectRoot: '/proj',
      data: {
        readiness: { score: 87, verdict: 'good' },
        sharkcraftPresent: true,
        configPresent: true,
        summary: {
          rules: 12,
          paths: 8,
          templates: 5,
          pipelines: 2,
          presets: 3,
          packs: 1,
          scaffoldPatterns: 4,
          knowledgeEntries: 18,
        },
        topRecommendations: [],
        featureAvailability: { adoption: true },
      },
      commandHints: ['shrk doctor'],
      warnings: [],
    });
    const serialized = JSON.stringify(env);
    const parsed = JSON.parse(serialized) as IDashboardApiEnvelope<IDashboardOverviewResponse>;
    expect(parsed.schema).toBe(DASHBOARD_API_SCHEMA_ID);
    expect(parsed.data.readiness.score).toBe(87);
    expect(parsed.projectRoot).toBe('/proj');
  });

  test('does not leak functions into serialized output', () => {
    const env = makeDashboardEnvelope({
      projectRoot: '/proj',
      data: { fnAttempt: () => 1 } as unknown as Record<string, unknown>,
    });
    // Functions are not JSON; verify they get dropped on stringify.
    const serialized = JSON.stringify(env);
    expect(serialized.includes('=>')).toBe(false);
    expect(serialized.includes('function')).toBe(false);
  });
});

describe('@shrkcrft/dashboard-api response models', () => {
  test('major response models can be constructed', () => {
    const capabilities: IDashboardCapabilitiesResponse = {
      readOnly: true,
      supportsSessions: true,
      supportsQuality: true,
      supportsSafety: true,
      supportsAdoption: true,
      supportsScaffolds: true,
      supportsReports: true,
      supportsGraph: true,
      supportsReview: true,
      supportsPacks: true,
      supportsPresets: true,
      supportsPipelines: true,
      supportsMcpSummary: true,
      supportsLiveSessionEvents: true,
      writeEndpoints: [],
      dangerousActions: [],
      commandHints: [],
    };
    expect(capabilities.readOnly).toBe(true);
    expect(capabilities.writeEndpoints.length).toBe(0);

    const health: IDashboardHealthResponse = {
      ok: true,
      readOnly: true,
      apiVersion: '1',
      schemaId: DASHBOARD_API_SCHEMA_ID,
      uptimeSeconds: 0,
      capabilitiesUrl: '/api/capabilities',
    };
    expect(health.readOnly).toBe(true);

    const adoption: IDashboardAdoptionResponse = {
      available: false,
      nextCommands: [],
      artifacts: [],
    };
    expect(adoption.available).toBe(false);

    const sessions: IDashboardSessionsResponse = { available: true, sessions: [] };
    expect(sessions.sessions.length).toBe(0);
  });
});
