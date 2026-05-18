export interface IRuleQuery {
  task?: string;
  scope?: readonly string[];
  tags?: readonly string[];
  appliesWhen?: readonly string[];
  minPriority?: string;
  limit?: number;
}
