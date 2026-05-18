export interface IPipelineInput {
  name: string;
  description?: string;
  required?: boolean;
  /** Optional default value (string). */
  default?: string;
  /** Restricted set of allowed values. */
  choices?: readonly string[];
}
