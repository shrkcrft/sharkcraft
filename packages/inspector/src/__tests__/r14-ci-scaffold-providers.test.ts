import { describe, expect, test } from 'bun:test';
import {
  defaultCiOutputPath,
  renderBitbucketCiWorkflow,
  renderCiWorkflow,
  renderGitlabCiWorkflow,
} from '../index.ts';

describe('r14 GitLab CI scaffold', () => {
  test('contains the three required stages', () => {
    const yaml = renderGitlabCiWorkflow({ withQuality: true });
    expect(yaml).toContain('stages:');
    expect(yaml).toContain('- sharkcraft_quality');
    expect(yaml).toContain('- sharkcraft_review');
    expect(yaml).toContain('- sharkcraft_reports');
    expect(yaml).toContain('sharkcraft:doctor:');
    expect(yaml).toContain('sharkcraft:quality:');
  });

  test('skipping a flag omits the corresponding job', () => {
    const yaml = renderGitlabCiWorkflow({ withQuality: false, withPolicy: true });
    expect(yaml.includes('sharkcraft:quality:')).toBe(false);
    expect(yaml.includes('sharkcraft:policy:')).toBe(true);
  });

  test('policy-snapshot-gate produces the snapshot script line', () => {
    const yaml = renderGitlabCiWorkflow({ withPolicy: true, withPolicySnapshotGate: true });
    expect(yaml).toContain('shrk policy snapshot --all --gate');
  });
});

describe('r14 Bitbucket CI scaffold', () => {
  test('declares pull-requests and a custom sharkcraft-governance pipeline', () => {
    const yaml = renderBitbucketCiWorkflow({ withQuality: true, withBundleReplay: true });
    expect(yaml).toContain('pull-requests:');
    expect(yaml).toContain('custom:');
    expect(yaml).toContain('sharkcraft-governance:');
    expect(yaml).toContain('&sharkcraft-doctor');
    expect(yaml).toContain('*sharkcraft-doctor');
  });

  test('skipping a flag omits the corresponding step reference', () => {
    const yaml = renderBitbucketCiWorkflow({ withPolicy: false, withImpact: true });
    expect(yaml.includes('&sharkcraft-policy')).toBe(false);
    expect(yaml).toContain('&sharkcraft-impact');
  });
});

describe('r14 CI helpers', () => {
  test('defaultCiOutputPath returns the canonical file path per provider', () => {
    expect(defaultCiOutputPath('github-actions')).toBe('.github/workflows/sharkcraft.yml');
    expect(defaultCiOutputPath('gitlab')).toBe('.gitlab-ci.yml');
    expect(defaultCiOutputPath('bitbucket')).toBe('bitbucket-pipelines.yml');
  });

  test('renderCiWorkflow dispatches by provider', () => {
    expect(renderCiWorkflow('gitlab', { withQuality: true })).toContain('stages:');
    expect(renderCiWorkflow('bitbucket', { withQuality: true })).toContain('pull-requests:');
    expect(renderCiWorkflow('github-actions', { withQuality: true })).toContain('jobs:');
  });
});
