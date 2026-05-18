import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { auditCiWorkflow } from '../ci-permissions.ts';

function fixture(content: string, name = 'workflow.yml'): string {
  const dir = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r15-ci-'));
  const file = nodePath.join(dir, name);
  mkdirSync(nodePath.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

describe('r15 CI permissions audit', () => {
  test('read-only GHA workflow recommends least-privilege', () => {
    const file = fixture(
      `name: SharkCraft\non:\n  pull_request:\njobs:\n  sharkcraft:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: bun run shrk doctor\n      - uses: actions/upload-artifact@v4\n`,
      '.github/workflow.yml',
    );
    const audit = auditCiWorkflow({ file, provider: 'github-actions' });
    expect(audit.exists).toBe(true);
    expect(audit.postsComments).toBe(false);
    expect(audit.requestsWritePermissions).toBe(false);
    expect(audit.uploadsArtifacts).toBe(true);
    expect(audit.recommendation).toContain('contents: read');
  });

  test('comment-posting GHA workflow warns about pull-requests:write', () => {
    const file = fixture(
      `name: SharkCraft\nperms: foo\npermissions:\n  contents: read\n  pull-requests: write\njobs:\n  sharkcraft:\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh pr comment $PR_NUMBER --body-file body.md\n`,
    );
    const audit = auditCiWorkflow({ file, provider: 'github-actions' });
    expect(audit.postsComments).toBe(true);
    expect(audit.requestsWritePermissions).toBe(true);
    expect(audit.findings.some((f) => f.code === 'comment-posting-detected' && f.severity === 'warning')).toBe(true);
    expect(audit.findings.some((f) => f.code === 'permissions-write-requested')).toBe(true);
  });

  test('GitLab pipeline detects MR notes posting', () => {
    const file = fixture(
      `sharkcraft:\n  script:\n    - curl --request POST --header "PRIVATE-TOKEN: $REVIEW_TOKEN" $CI_API_V4_URL/projects/$CI_PROJECT_ID/merge_requests/$CI_MERGE_REQUEST_IID/notes\n`,
      '.gitlab-ci.yml',
    );
    const audit = auditCiWorkflow({ file, provider: 'gitlab' });
    expect(audit.postsComments).toBe(true);
    expect(audit.usesTokens).toBe(true);
  });

  test('Bitbucket pipeline + Azure pipeline both audit successfully', () => {
    const bitbucket = auditCiWorkflow({
      file: fixture(
        `pipelines:\n  pull-requests:\n    "**":\n      - step:\n          script:\n            - bun run shrk doctor\n`,
        'bitbucket-pipelines.yml',
      ),
      provider: 'bitbucket',
    });
    expect(bitbucket.exists).toBe(true);
    const azure = auditCiWorkflow({
      file: fixture(
        `trigger:\n  - main\nsteps:\n  - script: $(System.AccessToken)\n  - publish: out\n`,
        'azure-pipelines.yml',
      ),
      provider: 'azure',
    });
    expect(azure.usesTokens).toBe(true);
  });

  test('missing workflow reports an error finding', () => {
    const audit = auditCiWorkflow({ file: '/no/such/path.yml', provider: 'github-actions' });
    expect(audit.exists).toBe(false);
    expect(audit.findings[0]!.severity).toBe('error');
  });
});
