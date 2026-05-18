import { describe, expect, test } from 'bun:test';
import { defaultDemoWorkflowOutputPath, renderDemoWorkflow } from '../index.ts';

describe('r14 PR-review demo workflow', () => {
  test('GitHub Actions output references the review surface and uploads artifacts', () => {
    const w = renderDemoWorkflow('github-actions');
    expect(w.body).toContain('SharkCraft PR review');
    expect(w.body).toContain('shrk review packet --v3');
    expect(w.body).toContain('shrk impact --since origin/main');
    expect(w.body).toContain('shrk report site');
    expect(w.body).toContain('actions/upload-artifact@v4');
    expect(w.defaultOutputPath).toBe('.github/workflows/sharkcraft-pr-review.yml');
  });

  test('GitLab output uses the merge_request rule', () => {
    const w = renderDemoWorkflow('gitlab');
    expect(w.body).toContain('CI_PIPELINE_SOURCE == "merge_request_event"');
    expect(w.body).toContain('shrk review packet --v3');
    expect(w.body).toContain('artifacts:');
  });

  test('Bitbucket output declares pull-requests pipelines', () => {
    const w = renderDemoWorkflow('bitbucket');
    expect(w.body).toContain('pull-requests:');
    expect(w.body).toContain('shrk impact --since origin/$BITBUCKET_PR_DESTINATION_BRANCH');
  });

  test('default output paths differ per provider', () => {
    expect(defaultDemoWorkflowOutputPath('github-actions')).toContain('.github/workflows');
    expect(defaultDemoWorkflowOutputPath('gitlab')).toContain('.gitlab');
    expect(defaultDemoWorkflowOutputPath('bitbucket')).toContain('bitbucket-pipelines');
  });

  test('PR comment posting is commented out by default for every provider', () => {
    for (const p of ['github-actions', 'gitlab', 'bitbucket'] as const) {
      const body = renderDemoWorkflow(p).body;
      // The script never has an active "post to PR" step — only commented-out hints.
      const live = body.split('\n').filter((l) => /gh pr comment|sharkcraft:pr-comment:|BITBUCKET_TOKEN/.test(l)
        && !l.trimStart().startsWith('#')
        && !l.trimStart().startsWith('//'));
      expect(live.length).toBe(0);
    }
  });
});
