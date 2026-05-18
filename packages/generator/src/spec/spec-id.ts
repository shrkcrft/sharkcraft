/**
 * Spec id construction and conflict resolution.
 *
 * Spec ids are `<YYYY-MM-DD>-<slug>` where `<slug>` is kebab-case.
 * Conflicts (same-day, same-slug) resolve via numeric suffixes `-2`,
 * `-3`, etc. The id is the directory name under `.sharkcraft/specs/`,
 * so it must be safe for any filesystem and stable across spec edits.
 */

import { toKebabCase } from '@shrkcrft/core';

export interface IBuildSpecIdInput {
  /** Spec title or seed string. */
  readonly title: string;
  /** Optional explicit slug override (overrides title-derived slug). */
  readonly slug?: string;
  /**
   * Date string in YYYY-MM-DD form. Defaults to the current UTC date
   * if omitted.
   */
  readonly date?: string;
  /** Pre-existing spec ids (full ids, not slugs) for collision detection. */
  readonly existingIds?: readonly string[];
}

export interface IBuiltSpecId {
  readonly id: string;
  readonly slug: string;
  readonly date: string;
}

export function buildSpecId(input: IBuildSpecIdInput): IBuiltSpecId {
  const slug = normalizeSlug(input.slug ?? input.title);
  const date = input.date ?? todayIsoDate();
  const baseId = `${date}-${slug}`;
  const existing = new Set(input.existingIds ?? []);
  if (!existing.has(baseId)) return { id: baseId, slug, date };
  let n = 2;
  while (existing.has(`${baseId}-${n}`)) n++;
  return { id: `${baseId}-${n}`, slug, date };
}

export function normalizeSlug(input: string): string {
  const k = toKebabCase(input)
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (k.length === 0) return 'spec';
  if (!/^[a-z0-9]/.test(k)) return `s-${k}`;
  return k;
}

export function todayIsoDate(now: Date = new Date()): string {
  const y = now.getUTCFullYear().toString().padStart(4, '0');
  const m = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = now.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}
