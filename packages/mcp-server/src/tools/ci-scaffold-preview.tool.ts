import {
  defaultCiOutputPath,
  renderBitbucketCiWorkflow,
  renderBundleReplayWorkflow,
  renderGitlabCiWorkflow,
  renderQualityCiWorkflow,
  type BundleReplaySchedule,
  type CiProvider,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

const VALID_PROVIDERS = new Set<CiProvider>(['github-actions', 'gitlab', 'bitbucket']);

export const getCiScaffoldPreviewTool: IToolDefinition = {
  name: 'get_ci_scaffold_preview',
  description:
    'Render the CI workflow YAML for the SharkCraft CI scaffold without writing anything. Supports GitHub Actions, GitLab, and Bitbucket. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', enum: ['quality', 'bundle-replay'] },
      provider: { type: 'string', enum: ['github-actions', 'gitlab', 'bitbucket'] },
      withQuality: { type: 'boolean' },
      withPolicy: { type: 'boolean' },
      withPolicySnapshotGate: { type: 'boolean' },
      withImpact: { type: 'boolean' },
      withReview: { type: 'boolean' },
      withReportSite: { type: 'boolean' },
      withBundleReplay: { type: 'boolean' },
      withNodeCompat: { type: 'boolean' },
      schedule: { type: 'string', enum: ['weekly', 'daily', 'manual'] },
    },
    additionalProperties: false,
  },
  handler(input) {
    const target = typeof input['target'] === 'string' ? (input['target'] as string) : 'quality';
    if (target === 'bundle-replay') {
      const schedule =
        typeof input['schedule'] === 'string' && ['weekly', 'daily', 'manual'].includes(input['schedule'] as string)
          ? (input['schedule'] as BundleReplaySchedule)
          : 'weekly';
      const body = renderBundleReplayWorkflow({
        schedule,
        ...(input['withReportSite'] ? { withReportSite: true } : {}),
      });
      return { data: { target: 'bundle-replay', body } };
    }
    const providerRaw = (typeof input['provider'] === 'string' ? input['provider'] : 'github-actions') as CiProvider;
    const provider: CiProvider = VALID_PROVIDERS.has(providerRaw) ? providerRaw : 'github-actions';
    const opts = {
      ...(input['withQuality'] ? { withQuality: true } : {}),
      ...(input['withPolicy'] ? { withPolicy: true } : {}),
      ...(input['withPolicySnapshotGate'] ? { withPolicySnapshotGate: true } : {}),
      ...(input['withImpact'] ? { withImpact: true } : {}),
      ...(input['withReview'] ? { withReview: true } : {}),
      ...(input['withReportSite'] ? { withReportSite: true } : {}),
      ...(input['withBundleReplay'] ? { withBundleReplay: true } : {}),
      ...(input['withNodeCompat'] ? { withNodeCompat: true } : {}),
    };
    let body: string;
    if (provider === 'gitlab') body = renderGitlabCiWorkflow(opts);
    else if (provider === 'bitbucket') body = renderBitbucketCiWorkflow(opts);
    else body = renderQualityCiWorkflow(opts);
    return {
      data: {
        target: 'quality',
        provider,
        defaultOutputPath: defaultCiOutputPath(provider),
        body,
      },
    };
  },
};
