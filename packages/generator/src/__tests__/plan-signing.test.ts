import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  buildSavedPlan,
  canonicalizePlan,
  PLAN_SECRET_ENV,
  signPlan,
  verifyPlan,
  type IGenerationPlan,
} from '../index.ts';

const examplePlan: IGenerationPlan = {
  templateId: 'typescript.service',
  templateName: 'TS Service',
  changes: [],
  totalFiles: 0,
  hasConflicts: false,
  warnings: [],
  postGenerationNotes: [],
};

function builtPlan(): ReturnType<typeof buildSavedPlan> {
  return buildSavedPlan({
    templateId: 'typescript.service',
    variables: { className: 'UserProfileService' },
    projectRoot: '/abs',
    plan: examplePlan,
  });
}

describe('plan signing', () => {
  beforeEach(() => {
    process.env[PLAN_SECRET_ENV] = 'unit-test-secret';
  });
  afterEach(() => {
    delete process.env[PLAN_SECRET_ENV];
  });

  test('canonicalize excludes the signature field', () => {
    const a = builtPlan();
    const b = { ...a, signature: { algo: 'sha256' as const, hmac: 'deadbeef', signedAt: 'x' } };
    expect(canonicalizePlan(a)).toBe(canonicalizePlan(b));
  });

  test('signPlan + verifyPlan happy path', () => {
    const plan = builtPlan();
    const signed = signPlan(plan);
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    const v = verifyPlan(signed.value);
    expect(v.ok).toBe(true);
  });

  test('verify rejects tampered plan', () => {
    const plan = builtPlan();
    const signed = signPlan(plan);
    if (!signed.ok) throw new Error('precondition');
    const tampered = { ...signed.value, name: 'changed-name' };
    const v = verifyPlan(tampered);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.status).toBe('invalid-signature');
  });

  test('signPlan fails when no secret available', () => {
    delete process.env[PLAN_SECRET_ENV];
    const plan = builtPlan();
    const signed = signPlan(plan);
    expect(signed.ok).toBe(false);
  });

  test('verifyPlan returns missing-signature when plan was not signed', () => {
    const plan = builtPlan();
    const v = verifyPlan(plan);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.status).toBe('missing-signature');
  });

  test('verifyPlan returns missing-secret when env is unset', () => {
    const plan = builtPlan();
    const signed = signPlan(plan);
    if (!signed.ok) throw new Error('precondition');
    delete process.env[PLAN_SECRET_ENV];
    const v = verifyPlan(signed.value);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.status).toBe('missing-secret');
  });
});
