import type { IWorkspaceSummary } from '@shrkcrft/workspace';

export interface IProjectOverview {
  projectName: string;
  description?: string;
  packageManager: string;
  frameworks: string[];
  hasTypeScript: boolean;
  hasSharkcraftFolder: boolean;
  topLevelDirs: string[];
  knownScripts: string[];
}

export function buildProjectOverview(
  summary: IWorkspaceSummary,
  knowledgeProjectName?: string,
): IProjectOverview {
  return {
    projectName: knowledgeProjectName ?? summary.packageName ?? 'unknown-project',
    description: summary.description,
    packageManager: summary.packageManager.manager,
    frameworks: summary.frameworks.map((f) => f.name),
    hasTypeScript: summary.hasTypeScript,
    hasSharkcraftFolder: summary.hasSharkcraftFolder,
    topLevelDirs: summary.topLevelDirs,
    knownScripts: Object.keys(summary.scripts),
  };
}

export function renderOverviewText(overview: IProjectOverview): string {
  const lines: string[] = [];
  lines.push(`Project: ${overview.projectName}`);
  if (overview.description) lines.push(`Description: ${overview.description}`);
  lines.push(`Package manager: ${overview.packageManager}`);
  if (overview.frameworks.length) lines.push(`Frameworks: ${overview.frameworks.join(', ')}`);
  lines.push(`TypeScript: ${overview.hasTypeScript ? 'yes' : 'no'}`);
  lines.push(`SharkCraft folder: ${overview.hasSharkcraftFolder ? 'present' : 'missing'}`);
  if (overview.knownScripts.length) {
    lines.push(`Scripts: ${overview.knownScripts.slice(0, 12).join(', ')}`);
  }
  return lines.join('\n');
}
