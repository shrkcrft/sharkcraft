import type { IRegistrationQueryVerdict } from '@shrkcrft/boundaries';

/** What `settleRegistrationGraph` needs to settle one registration-graph absence query. */
export interface IRegistrationQuerySettleInput<T extends { readonly token: string }> {
  /** The verdict verb (`wiring unprovided` / `wiring orphans`). */
  readonly verb: string;
  readonly verdict: IRegistrationQueryVerdict<T>;
  /** The exit the findings propose (1 over an unprovided token; orphans never fail). */
  readonly proposed: number;
  /** The clean sentence — printed only when the settled exit is 0. */
  readonly clean: string;
  /** The query's own coverage subject (`unprovided` / `orphans`) — its row carries the findings. */
  readonly subject: string;
  /** How many idioms the graph was built from — the run's coverage. */
  readonly idioms: number;
}
