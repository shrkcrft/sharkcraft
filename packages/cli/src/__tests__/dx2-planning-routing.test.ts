/**
 * DX#2 — `shrk recommend` planning-intent routing.
 *
 * When the task string smells like planning (planning verb at the
 * start, or in the first 4 tokens), the recommender prepends
 * `shrk grounding "<task>"` as the top recommendation. Pure-text
 * classifier; no LLM.
 */
import { describe, expect, test } from 'bun:test';
import { looksLikePlanning } from '../commands/recommend.command.ts';

describe('DX#2 planning-intent classifier', () => {
  test('triggers on leading planning verbs', () => {
    expect(looksLikePlanning('plan billing module')).toBe(true);
    expect(looksLikePlanning('design the API surface')).toBe(true);
    expect(looksLikePlanning('review approach to authentication')).toBe(true);
    expect(looksLikePlanning('audit the current pipeline')).toBe(true);
    expect(looksLikePlanning('analyze test coverage')).toBe(true);
    expect(looksLikePlanning('propose a migration path')).toBe(true);
  });

  test('triggers on planning verb in slots 1–3', () => {
    expect(looksLikePlanning('help me plan a billing module')).toBe(true);
    expect(looksLikePlanning('I want to design the api')).toBe(true);
    expect(looksLikePlanning('we should review the migration')).toBe(true);
  });

  test('does NOT trigger on execution verbs', () => {
    expect(looksLikePlanning('add new endpoint')).toBe(false);
    expect(looksLikePlanning('fix typo in readme')).toBe(false);
    expect(looksLikePlanning('rename function')).toBe(false);
    expect(looksLikePlanning('refactor the billing module')).toBe(false);
  });

  test('does NOT trigger when planning verb appears late in the sentence', () => {
    expect(looksLikePlanning('add a feature that works according to the plan')).toBe(false);
    expect(looksLikePlanning('build the system as designed by the architect')).toBe(false);
  });

  test('returns false for empty strings', () => {
    expect(looksLikePlanning('')).toBe(false);
    expect(looksLikePlanning('   ')).toBe(false);
  });

  test('strips punctuation before classification', () => {
    expect(looksLikePlanning('Plan: billing module')).toBe(true);
    expect(looksLikePlanning('"design the api"')).toBe(true);
  });
});
