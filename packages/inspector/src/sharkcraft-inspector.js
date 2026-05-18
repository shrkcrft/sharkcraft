import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { inspectWorkspace } from '@shrkcrft/workspace';
import { loadProjectConfig } from '@shrkcrft/config';
import { KnowledgeIndex, MarkdownKnowledgeLoader, TypeScriptKnowledgeLoader, validateKnowledgeEntries, } from '@shrkcrft/knowledge';
import { RuleService } from '@shrkcrft/rules';
import { PathService } from '@shrkcrft/paths';
import { TemplateRegistry, loadTemplatesFromFile } from '@shrkcrft/templates';
import { DoctorSeverity } from "./doctor-result.js";
export async function inspectSharkcraft(options = {}) {
    const cwd = options.cwd ?? process.cwd();
    const workspace = await inspectWorkspace({ startDir: cwd });
    const cfgResult = await loadProjectConfig(cwd);
    const cfg = cfgResult.ok ? cfgResult.value : null;
    const warnings = [];
    const sourceFiles = [];
    const knowledgeEntries = [];
    const templates = [];
    if (cfg) {
        const tsLoader = new TypeScriptKnowledgeLoader();
        const mdLoader = new MarkdownKnowledgeLoader();
        const collectFile = async (relPath) => {
            const full = nodePath.join(cfg.sharkcraftDir, relPath);
            if (!existsSync(full))
                return;
            if (tsLoader.canLoad(full)) {
                const r = await tsLoader.load(full);
                knowledgeEntries.push(...r.entries);
                warnings.push(...r.warnings);
                sourceFiles.push(...r.sourceFiles);
            }
            else if (mdLoader.canLoad(full)) {
                const r = await mdLoader.load(full);
                knowledgeEntries.push(...r.entries);
                warnings.push(...r.warnings);
                sourceFiles.push(...r.sourceFiles);
            }
        };
        const allFiles = [
            ...(cfg.config.knowledgeFiles ?? []),
            ...(cfg.config.ruleFiles ?? []),
            ...(cfg.config.pathFiles ?? []),
            ...(cfg.config.docsFiles ?? []),
        ];
        const seen = new Set();
        for (const f of allFiles) {
            if (seen.has(f))
                continue;
            seen.add(f);
            await collectFile(f);
        }
        for (const f of cfg.config.templateFiles ?? []) {
            const full = nodePath.join(cfg.sharkcraftDir, f);
            if (!existsSync(full))
                continue;
            const r = await loadTemplatesFromFile(full);
            templates.push(...r.templates);
            warnings.push(...r.warnings);
            sourceFiles.push(...r.sourceFiles);
        }
    }
    else if (cfgResult.ok === false) {
        warnings.push(cfgResult.error.message);
    }
    const validation = validateKnowledgeEntries(knowledgeEntries);
    const cleanEntries = validation.uniqueEntries;
    const index = new KnowledgeIndex(cleanEntries);
    const ruleService = new RuleService(cleanEntries);
    const pathService = new PathService(cleanEntries);
    const templateRegistry = new TemplateRegistry(templates);
    return {
        projectRoot: workspace.projectRoot,
        workspace,
        hasSharkcraftFolder: workspace.hasSharkcraftFolder,
        sharkcraftDir: cfg?.sharkcraftDir ?? workspace.sharkcraftPath ?? null,
        config: cfg?.config ?? null,
        configFile: cfg?.configFile ?? null,
        knowledgeEntries: cleanEntries,
        templates,
        warnings,
        sourceFiles,
        validationIssues: validation.issues,
        index,
        ruleService,
        pathService,
        templateRegistry,
    };
}
export function runDoctor(inspection) {
    const checks = [];
    if (!inspection.workspace.hasPackageJson) {
        checks.push({
            id: 'package-json',
            title: 'package.json present',
            severity: DoctorSeverity.Warning,
            message: 'No package.json detected — this may not be a Node-compatible project.',
            fix: 'Run "bun init" or create a package.json.',
        });
    }
    else {
        checks.push({
            id: 'package-json',
            title: 'package.json present',
            severity: DoctorSeverity.Ok,
            message: `${inspection.workspace.packageName ?? '(unnamed)'} @ ${inspection.workspace.packageVersion ?? '0.0.0'}`,
        });
    }
    if (!inspection.hasSharkcraftFolder) {
        checks.push({
            id: 'sharkcraft-folder',
            title: 'sharkcraft/ folder',
            severity: DoctorSeverity.Error,
            message: 'No sharkcraft/ folder found.',
            fix: 'Run `shrk init` to create one.',
        });
    }
    else {
        checks.push({
            id: 'sharkcraft-folder',
            title: 'sharkcraft/ folder',
            severity: DoctorSeverity.Ok,
            message: `Found at ${inspection.sharkcraftDir}`,
        });
    }
    if (!inspection.configFile) {
        checks.push({
            id: 'config',
            title: 'sharkcraft.config.ts',
            severity: DoctorSeverity.Warning,
            message: 'No config file detected — using defaults.',
            fix: 'Create sharkcraft/sharkcraft.config.ts to customize knowledge file paths.',
        });
    }
    else {
        checks.push({
            id: 'config',
            title: 'sharkcraft.config.ts',
            severity: DoctorSeverity.Ok,
            message: `Loaded from ${inspection.configFile}`,
        });
    }
    if (inspection.knowledgeEntries.length === 0) {
        checks.push({
            id: 'knowledge',
            title: 'knowledge entries',
            severity: DoctorSeverity.Warning,
            message: 'No knowledge entries loaded.',
            fix: 'Add entries to sharkcraft/knowledge.ts using defineKnowledgeEntry()',
        });
    }
    else {
        checks.push({
            id: 'knowledge',
            title: 'knowledge entries',
            severity: DoctorSeverity.Ok,
            message: `${inspection.knowledgeEntries.length} entries loaded.`,
        });
    }
    if (inspection.templates.length === 0) {
        checks.push({
            id: 'templates',
            title: 'templates',
            severity: DoctorSeverity.Info,
            message: 'No templates registered.',
            fix: 'Define templates via defineTemplate() in sharkcraft/templates.ts',
        });
    }
    else {
        checks.push({
            id: 'templates',
            title: 'templates',
            severity: DoctorSeverity.Ok,
            message: `${inspection.templates.length} templates registered.`,
        });
    }
    for (const w of inspection.warnings) {
        checks.push({
            id: `warning-${checks.length}`,
            title: 'Loader warning',
            severity: DoctorSeverity.Warning,
            message: w,
        });
    }
    for (const v of inspection.validationIssues) {
        checks.push({
            id: `validation-${v.code}-${v.entryId}`,
            title: `Knowledge validation (${v.code})`,
            severity: v.severity === 'error' ? DoctorSeverity.Error : DoctorSeverity.Warning,
            message: v.message,
            fix: v.source ? `Edit ${v.source}` : undefined,
        });
    }
    const summary = { ok: 0, info: 0, warnings: 0, errors: 0 };
    for (const c of checks) {
        if (c.severity === DoctorSeverity.Ok)
            summary.ok += 1;
        else if (c.severity === DoctorSeverity.Info)
            summary.info += 1;
        else if (c.severity === DoctorSeverity.Warning)
            summary.warnings += 1;
        else if (c.severity === DoctorSeverity.Error)
            summary.errors += 1;
    }
    return { passed: summary.errors === 0, checks, summary };
}
