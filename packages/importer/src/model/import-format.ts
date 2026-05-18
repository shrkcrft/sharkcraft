export enum ImportFormat {
  AgentsMd = 'agents-md',
  ClaudeMd = 'claude-md',
  CursorRules = 'cursor-rules',
}

export function parseImportFormat(input: string): ImportFormat | undefined {
  switch (input) {
    case 'agents-md':
    case 'AGENTS.md':
      return ImportFormat.AgentsMd;
    case 'claude-md':
    case 'CLAUDE.md':
      return ImportFormat.ClaudeMd;
    case 'cursor-rules':
    case 'cursor':
      return ImportFormat.CursorRules;
    default:
      return undefined;
  }
}
