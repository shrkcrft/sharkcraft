/**
 * Policy-lint rules — the "template/markup/style/ts" plane.
 *
 * Some violations compile AOT-green because they live on surfaces the type
 * checker and structural search can't see: raw markup in `.html` files and
 * inline `template:` strings, stylesheet content, and a handful of
 * AOT-invisible TS shapes. `shrk policy-lint` runs deterministic, data-defined
 * pattern rules over exactly those surfaces.
 *
 * The engine is generic — no framework or project specifics. A project supplies
 * the rules as data via `sharkcraft.config.ts` `policyRules[]` (or a pack); each
 * rule names a surface, a regex, and a human message (optionally a suggested
 * replacement primitive). No AI.
 */

/** The content surface a rule scans. */
export type PolicySurface =
  /** `.html` files PLUS inline `template:` strings extracted from source files. */
  | 'template'
  /** Stylesheet files (`.css`/`.scss`/`.sass`/`.less`/`.styl`). */
  | 'style'
  /** Source files — for AOT-invisible shapes a project wants to forbid. */
  | 'ts';

export interface IPolicyRule {
  /** Stable id, surfaced in findings and selectable with `--only`. */
  readonly id: string;
  /** What the rule guards / why it matters. */
  readonly description?: string;
  /** Which surface to scan. */
  readonly surface: PolicySurface;
  /**
   * Project-relative globs. When omitted, a surface-appropriate default is used
   * (`**\/*.html` + inline templates for `template`, common stylesheet
   * extensions for `style`, `**\/*.ts`/`.tsx` for `ts`).
   */
  readonly files?: readonly string[];
  /**
   * Regex source matched against the surface content. Capture group 1, when
   * present, is reported as the offending token; otherwise the whole match is.
   */
  readonly pattern: string;
  /** Extra regex flags combined with the always-on `g` (e.g. `i`, `m`, `s`). */
  readonly flags?: string;
  /** Human message describing the violation. */
  readonly message: string;
  /** Optional remediation — e.g. the primitive/component to use instead. */
  readonly suggest?: string;
  /** `error` (default) fails the check; `warning` reports without failing. */
  readonly severity?: 'error' | 'warning';
}
