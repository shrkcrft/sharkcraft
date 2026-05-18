import type { ISharkcraftInspection } from '@shrkcrft/inspector';
export interface IResourceContent {
    uri: string;
    mimeType: string;
    text: string;
}
export interface IReadResourceResult {
    ok: true;
    contents: IResourceContent[];
}
export interface IReadResourceError {
    ok: false;
    error: string;
}
export declare function readResource(inspection: ISharkcraftInspection, uri: string): IReadResourceResult | IReadResourceError;
//# sourceMappingURL=read-resource.d.ts.map