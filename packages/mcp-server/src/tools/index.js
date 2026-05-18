import { getProjectOverviewTool } from "./get-project-overview.tool.js";
import { inspectWorkspaceTool } from "./inspect-workspace.tool.js";
import { listKnowledgeTool } from "./list-knowledge.tool.js";
import { getKnowledgeTool } from "./get-knowledge.tool.js";
import { searchKnowledgeTool } from "./search-knowledge.tool.js";
import { getRelevantContextTool } from "./get-relevant-context.tool.js";
import { listRulesTool } from "./list-rules.tool.js";
import { getRuleTool } from "./get-rule.tool.js";
import { getRelevantRulesTool } from "./get-relevant-rules.tool.js";
import { listPathConventionsTool } from "./list-path-conventions.tool.js";
import { getPathConventionTool } from "./get-path-convention.tool.js";
import { searchPathConventionsTool } from "./search-path-conventions.tool.js";
import { listTemplatesTool } from "./list-templates.tool.js";
import { getTemplateTool } from "./get-template.tool.js";
import { searchTemplatesTool } from "./search-templates.tool.js";
import { createGenerationPlanTool } from "./create-generation-plan.tool.js";
import { renderTemplatePreviewTool } from "./render-template-preview.tool.js";
import { inspectSharkcraftSetupTool } from "./inspect-sharkcraft-setup.tool.js";
import { getAgentInstructionsTool } from "./get-agent-instructions.tool.js";
import { getRepositoryCommandsTool } from "./get-repository-commands.tool.js";
import { getCurrentTasksTool } from "./get-current-tasks.tool.js";
import { getArchitectureConstraintsTool } from "./get-architecture-constraints.tool.js";
import { getTestingGuidelinesTool } from "./get-testing-guidelines.tool.js";
import { getSecurityGuidelinesTool } from "./get-security-guidelines.tool.js";
import { explainGenerationTargetTool } from "./explain-generation-target.tool.js";
export const ALL_TOOLS = Object.freeze([
    getProjectOverviewTool,
    inspectWorkspaceTool,
    listKnowledgeTool,
    getKnowledgeTool,
    searchKnowledgeTool,
    getRelevantContextTool,
    listRulesTool,
    getRuleTool,
    getRelevantRulesTool,
    listPathConventionsTool,
    getPathConventionTool,
    searchPathConventionsTool,
    listTemplatesTool,
    getTemplateTool,
    searchTemplatesTool,
    createGenerationPlanTool,
    renderTemplatePreviewTool,
    inspectSharkcraftSetupTool,
    getAgentInstructionsTool,
    getRepositoryCommandsTool,
    getCurrentTasksTool,
    getArchitectureConstraintsTool,
    getTestingGuidelinesTool,
    getSecurityGuidelinesTool,
    explainGenerationTargetTool,
]);
