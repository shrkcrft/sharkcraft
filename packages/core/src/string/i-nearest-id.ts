/** One candidate a "did you mean" query might have meant — `nearestIds`' result row. */
export interface INearestId {
  readonly id: string;
  readonly distance: number;
}
