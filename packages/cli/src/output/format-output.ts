export function header(text: string): string {
  return `\n=== ${text} ===\n`;
}

export function bullet(text: string): string {
  return `  • ${text}`;
}

export function kv(key: string, value: string | number | boolean | undefined | null): string {
  const v = value === undefined || value === null ? '(none)' : String(value);
  return `  ${key.padEnd(18)} ${v}`;
}

export function asJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function table(rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return '';
  const widths: number[] = [];
  for (const row of rows) {
    for (let i = 0; i < row.length; i += 1) {
      widths[i] = Math.max(widths[i] ?? 0, (row[i] ?? '').length);
    }
  }
  return rows
    .map((row) => row.map((cell, i) => (cell ?? '').padEnd(widths[i] ?? 0)).join('  ').trimEnd())
    .join('\n');
}

export interface PrintOptions {
  json?: boolean;
}
