export declare const URI_SCHEME = "sharkcraft";
export declare const OVERVIEW_URI = "sharkcraft://overview";
export declare const AGENT_INSTRUCTIONS_URI = "sharkcraft://agent-instructions";
export declare function knowledgeUri(id: string): string;
export declare function templateUri(id: string): string;
export declare function docUri(relativePath: string): string;
export interface ParsedResourceUri {
    scheme: string;
    kind: 'overview' | 'agent-instructions' | 'knowledge' | 'template' | 'docs' | 'unknown';
    id?: string;
    path?: string;
}
export declare function parseResourceUri(uri: string): ParsedResourceUri;
//# sourceMappingURL=resource-uris.d.ts.map