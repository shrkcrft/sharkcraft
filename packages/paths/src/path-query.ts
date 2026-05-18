export interface IPathQuery {
  task?: string;
  scope?: readonly string[];
  tags?: readonly string[];
  appliesWhen?: readonly string[];
  query?: string;
  limit?: number;
}
