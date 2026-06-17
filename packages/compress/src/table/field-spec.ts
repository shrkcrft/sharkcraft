/**
 * One column of a compacted table — its name plus coarse type/nullability
 * hints lifted out of the rows so they aren't repeated per row.
 */
export interface IFieldSpec {
  /** Column (object key) name. */
  name: string;
  /** Coarse type hint: `bool` | `int` | `float` | `str` | `json` | `null`. */
  type: string;
  /** True when at least one source object omits the key or has it null. */
  nullable: boolean;
}
