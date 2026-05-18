import type { IToolDefinition } from '../server/tool-definition.ts';

export const getReportSitePreviewTool: IToolDefinition = {
  name: 'get_report_site_preview',
  description:
    'Return a structured preview of the report site (page list + populated flags). No filesystem writes. Read-only.',
  inputSchema: { type: 'object', properties: { bundleId: { type: 'string' } } },
  handler(input) {
    const bundleId = typeof input['bundleId'] === 'string' ? (input['bundleId'] as string) : undefined;
    const pages = [
      { id: 'overview', file: 'index.html', alwaysPopulated: true },
      { id: 'quality', file: 'quality.html', alwaysPopulated: true },
      { id: 'bundles', file: 'bundles.html', alwaysPopulated: true },
      { id: 'review', file: 'review.html', alwaysPopulated: Boolean(bundleId) },
      { id: 'coverage', file: 'coverage.html', alwaysPopulated: true },
      { id: 'drift', file: 'drift.html', alwaysPopulated: true },
      { id: 'policies', file: 'policies.html', alwaysPopulated: true },
    ];
    return {
      data: {
        schema: 'sharkcraft.report-site-preview/v1',
        pages,
        notes: bundleId
          ? []
          : [
              'review.html is a placeholder unless you pass --bundle or --review when building the site.',
            ],
      },
    };
  },
};
