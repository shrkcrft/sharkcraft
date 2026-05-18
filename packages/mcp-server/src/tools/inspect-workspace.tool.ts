import type { IToolDefinition } from '../server/tool-definition.ts';

export const inspectWorkspaceTool: IToolDefinition = {
  name: 'inspect_workspace',
  description: 'Returns structured workspace info: package manager, frameworks, scripts, top-level dirs, sharkcraft folder presence.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    const ws = ctx.inspection.workspace;
    const data = {
      projectRoot: ws.projectRoot,
      packageName: ws.packageName,
      packageVersion: ws.packageVersion,
      packageManager: ws.packageManager,
      frameworks: ws.frameworks,
      hasTypeScript: ws.hasTypeScript,
      scripts: ws.scripts,
      dependencies: Object.keys(ws.dependencies),
      devDependencies: Object.keys(ws.devDependencies),
      topLevelDirs: ws.topLevelDirs,
      hasSharkcraftFolder: ws.hasSharkcraftFolder,
      sharkcraftPath: ws.sharkcraftPath,
    };
    return { data };
  },
};
