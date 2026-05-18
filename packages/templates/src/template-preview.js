import { validateTemplateVariables, } from "./template-variable.js";
import { renderTemplate } from "./template-renderer.js";
export function previewTemplate(template, values) {
    const validation = validateTemplateVariables(template.variables, values);
    if (!validation.valid) {
        return { template, validation, rendered: null };
    }
    const rendered = renderTemplate(template, validation.resolved);
    return { template, validation, rendered };
}
