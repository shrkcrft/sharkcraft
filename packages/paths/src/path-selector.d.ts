import type { IPathConvention } from './path-convention.ts';
export interface IPathSelection {
    convention: IPathConvention;
    reason: string;
    score: number;
}
export declare function selectBestPath(candidates: readonly IPathConvention[], task: string): IPathSelection | null;
//# sourceMappingURL=path-selector.d.ts.map