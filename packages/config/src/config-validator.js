export function validateConfig(config) {
    const issues = [];
    if (config.defaultMaxTokens !== undefined && config.defaultMaxTokens <= 0) {
        issues.push({
            field: 'defaultMaxTokens',
            message: 'defaultMaxTokens must be > 0',
            severity: 'error',
        });
    }
    for (const field of ['knowledgeFiles', 'ruleFiles', 'pathFiles', 'templateFiles', 'docsFiles']) {
        const v = config[field];
        if (v !== undefined && !Array.isArray(v)) {
            issues.push({ field, message: `${field} must be an array of strings`, severity: 'error' });
        }
    }
    if (config.projectName !== undefined && typeof config.projectName !== 'string') {
        issues.push({ field: 'projectName', message: 'projectName must be a string', severity: 'error' });
    }
    return { valid: issues.every((i) => i.severity !== 'error'), issues };
}
