import { describe, expect, test } from 'bun:test';
import {
  defaultCiOutputPath,
  renderAzureCiWorkflow,
  renderJenkinsCiWorkflow,
} from '../ci-scaffold.ts';

describe('r15 Jenkins scaffold', () => {
  test('produces a declarative pipeline with the expected stages', () => {
    const body = renderJenkinsCiWorkflow({
      withQuality: true,
      withImpact: true,
      withReportSite: true,
    });
    expect(body).toContain('pipeline {');
    expect(body).toContain("stage('Install')");
    expect(body).toContain("stage('SharkCraft quality')");
    expect(body).toContain("stage('SharkCraft impact')");
    expect(body).toContain("stage('SharkCraft report site')");
    expect(body).toContain('archiveArtifacts');
  });

  test('omits stages when their flag is off', () => {
    const body = renderJenkinsCiWorkflow({ withQuality: true });
    expect(body.includes("stage('SharkCraft impact')")).toBe(false);
    expect(body.includes("stage('SharkCraft report site')")).toBe(false);
  });
});

describe('r15 Azure scaffold', () => {
  test('produces multi-stage YAML with the expected stages', () => {
    const body = renderAzureCiWorkflow({
      withQuality: true,
      withImpact: true,
      withReportSite: true,
    });
    expect(body).toContain('stages:');
    expect(body).toContain('SharkCraft_Install');
    expect(body).toContain('SharkCraft_Quality');
    expect(body).toContain('SharkCraft_Impact');
    expect(body).toContain('SharkCraft_ReportSite');
    expect(body).toContain('publish:');
  });

  test('skipping flags omits the matching stage', () => {
    const body = renderAzureCiWorkflow({ withQuality: true });
    expect(body.includes('SharkCraft_Impact')).toBe(false);
  });
});

describe('r15 default CI output paths', () => {
  test('jenkins → Jenkinsfile, azure → azure-pipelines.yml', () => {
    expect(defaultCiOutputPath('jenkins')).toBe('Jenkinsfile');
    expect(defaultCiOutputPath('azure')).toBe('azure-pipelines.yml');
  });
});
