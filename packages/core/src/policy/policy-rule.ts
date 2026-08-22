import type { IRuleSelfTest } from '../wiring/wiring-rule.ts';

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

/**
 * Which lexical zone of a file a rule's pattern may match in.
 *
 * `all` (default) is a plain text scan — every byte, including comments. The
 * other three narrow it: `code` kills the dominant false positive (a hit inside
 * a "we used to do this" comment), `strings` targets exactly what a
 * single-language linter cannot see (an inline template / embedded query), and
 * `comments` finds forbidden content in the prose itself (a leaked token, a
 * stale directive).
 *
 * Zoning is lexical, C/JS-family (`'`/`"`/`` ` `` strings, `//` and block
 * comments) — designed for the `ts` and `style` surfaces. It is not applied to
 * inline-template units, whose content is already a string body.
 */
export type PolicyScanZone = 'all' | 'code' | 'strings' | 'comments';

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
  /** Which lexical zone matches count in (default `all`). */
  readonly scan?: PolicyScanZone;
  /**
   * Project-relative globs whose findings are dropped. A legitimate exception
   * is first-class config, not a pattern the author has to grep around.
   */
  readonly exemptFiles?: readonly string[];
  /**
   * Inline suppression marker (a plain substring, e.g.
   * `policy-allow:no-nondeterminism`). A finding is dropped when the marker
   * appears on its line or the line immediately above it.
   */
  readonly exemptLines?: string;
  /**
   * Treat "this rule extracted nothing to check" as a FAILURE rather than a
   * loud skip. A rule that matches nothing is a bug in the rule, never a pass.
   *
   * DEFAULTS TO TRUE for `error`-severity rules (an error rule exists to block
   * a build; one matching zero subjects is broken). `warning`-severity rules
   * default to false, since a warning plane may legitimately cover an empty
   * set. Set explicitly to override either default.
   */
  readonly failOnEmpty?: boolean;
  /** Author-declared expectations checked by `shrk gates coverage`. */
  readonly selfTest?: IRuleSelfTest;
  /** Human message describing the violation. */
  readonly message: string;
  /** Optional remediation — e.g. the primitive/component to use instead. */
  readonly suggest?: string;
  /** `error` (default) fails the check; `warning` reports without failing. */
  readonly severity?: 'error' | 'warning';
}
