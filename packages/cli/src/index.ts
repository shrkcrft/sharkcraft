export * from './command-registry.ts';
export { initCommand } from './commands/init.command.ts';
export { inspectCommand } from './commands/inspect.command.ts';
export { doctorCommand } from './commands/doctor.command.ts';
export {
  knowledgeListCommand,
  knowledgeGetCommand,
  knowledgeSearchCommand,
} from './commands/knowledge.command.ts';
export {
  rulesListCommand,
  rulesGetCommand,
  rulesRelevantCommand,
} from './commands/rules.command.ts';
export {
  pathsListCommand,
  pathsGetCommand,
  pathsSearchCommand,
  pathsBestCommand,
} from './commands/paths.command.ts';
export {
  templatesListCommand,
  templatesGetCommand,
  templatesSearchCommand,
  templatesPreviewCommand,
} from './commands/templates.command.ts';
export { contextCommand } from './commands/context.command.ts';
export { genCommand } from './commands/gen.command.ts';
export { applyCommand } from './commands/apply.command.ts';
export { askCommand } from './commands/ask.command.ts';
export { exportCommand } from './commands/export.command.ts';
export { importCommand } from './commands/import.command.ts';
export { mcpCommand } from './commands/mcp.command.ts';
export {
  packsListCommand,
  packsGetCommand,
  packsInspectCommand,
  packsDoctorCommand,
  packsSignCommand,
  packsVerifyCommand,
} from './commands/packs.command.ts';
export {
  pipelinesListCommand,
  pipelinesGetCommand,
  pipelinesContextCommand,
  pipelinesPlanCommand,
  pipelinesScriptCommand,
  pipelinesNextCommand,
} from './commands/pipelines.command.ts';
export {
  schemasListCommand,
  schemasGetCommand,
  schemasWriteCommand,
} from './commands/schemas.command.ts';
export { versionCommand } from './commands/version.command.ts';
export { makeHelpCommand } from './commands/help.command.ts';
export { buildRegistry, runCli } from './main.ts';
