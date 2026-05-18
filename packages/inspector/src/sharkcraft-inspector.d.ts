import { type IWorkspaceSummary } from '@shrkcrft/workspace';
import { type ISharkCraftConfig } from '@shrkcrft/config';
import { KnowledgeIndex, type IKnowledgeEntry, type IKnowledgeValidationIssue } from '@shrkcrft/knowledge';
import { RuleService } from '@shrkcrft/rules';
import { PathService } from '@shrkcrft/paths';
import { TemplateRegistry, type ITemplateDefinition } from '@shrkcrft/templates';
import { type IDoctorResult } from './doctor-result.ts';
export interface ISharkcraftInspection {
    projectRoot: string;
    workspace: IWorkspaceSummary;
    hasSharkcraftFolder: boolean;
    sharkcraftDir: string | null;
    config: ISharkCraftConfig | null;
    configFile: string | null;
    knowledgeEntries: IKnowledgeEntry[];
    templates: ITemplateDefinition[];
    warnings: string[];
    sourceFiles: string[];
    /** Structural validation issues (duplicate ids, missing fields, etc.). */
    validationIssues: IKnowledgeValidationIssue[];
    index: KnowledgeIndex;
    ruleService: RuleService;
    pathService: PathService;
    templateRegistry: TemplateRegistry;
}
export interface InspectOptions {
    cwd?: string;
}
export declare function inspectSharkcraft(options?: InspectOptions): Promise<ISharkcraftInspection>;
export declare function runDoctor(inspection: ISharkcraftInspection): IDoctorResult;
//# sourceMappingURL=sharkcraft-inspector.d.ts.map