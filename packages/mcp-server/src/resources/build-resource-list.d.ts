import type { ISharkcraftInspection } from '@shrkcrft/inspector';
export interface IResourceListItem {
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
}
/**
 * Resources advertised by SharkCraft. Read-only by design — there is no
 * resource-write endpoint. AI agents use these to fetch background info
 * without invoking a tool call.
 */
export declare function buildResourceList(inspection: ISharkcraftInspection): IResourceListItem[];
//# sourceMappingURL=build-resource-list.d.ts.map