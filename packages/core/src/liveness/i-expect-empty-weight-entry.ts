/**
 * One MARKED value of a boost map (search tuning `boostIds` and
 * `taskHints[i].boostIds`, round 13). The UNIT is the map key
 * (`knowledge:<id>`); the value carries the weight the boost applies once its
 * target exists, plus the assertion that it does not exist yet.
 *
 *   boostIds: { 'knowledge:fx.guide': 2, 'knowledge:fx.planned': { weight: 2, expectEmpty: true } }
 *
 * Exact shape, like {@link IExpectEmptyEntry}; `normalizeUnitMap` is the one
 * parser, and a loaded map holds plain numbers only.
 */
export interface IExpectEmptyWeightEntry {
  readonly weight: number;
  readonly expectEmpty: true;
  readonly reason?: string;
}
