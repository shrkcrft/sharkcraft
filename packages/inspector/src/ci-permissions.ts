import { existsSync, readFileSync } from 'node:fs';

/**
 * CI workflow permissions audit.
 *
 * Reads a workflow YAML and produces a structured assessment of:
 *  - which write scopes the workflow requests,
 *  - whether the workflow posts comments,
 *  - whether it uses external actions or container images,
 *  - whether it uploads artifacts,
 *  - a least-privilege recommendation.
 *
 * The audit is intentionally regex-based — no YAML parser, no network
 * resolution. The goal is "deterministic explanation of what this file
 * implies", not full schema validation.
 */
export const CI_PERMISSIONS_AUDIT_SCHEMA = 'sharkcraft.ci-permissions-audit/v1';

export type CiProviderForAudit = 'github-actions' | 'gitlab' | 'bitbucket' | 'azure' | 'jenkins';

export interface ICiPermissionsFinding {
  code:
    | 'permissions-block-missing'
    | 'permissions-write-requested'
    | 'comment-posting-detected'
    | 'token-usage'
    | 'external-action'
    | 'external-image'
    | 'artifact-upload'
    | 'shell-step';
  severity: 'info' | 'warning' | 'error';
  message: string;
  /** Lines (1-indexed) in the workflow where the finding was triggered. */
  lines: readonly number[];
  /** Optional remediation hint. */
  suggestion?: string;
}

export interface ICiPermissionsAudit {
  schema: typeof CI_PERMISSIONS_AUDIT_SCHEMA;
  provider: CiProviderForAudit;
  workflowFile: string;
  exists: boolean;
  /** Top-level summary booleans for quick consumption. */
  postsComments: boolean;
  requestsWritePermissions: boolean;
  usesTokens: boolean;
  externalActions: readonly string[];
  externalImages: readonly string[];
  uploadsArtifacts: boolean;
  findings: readonly ICiPermissionsFinding[];
  /** Recommended least-privilege block (provider-specific). */
  recommendation: string;
  /** Free-form notes for the human reviewer. */
  notes: readonly string[];
}

const PROVIDER_HINT_FILES: Record<CiProviderForAudit, RegExp> = {
  'github-actions': /\.github\/workflows\/[^/]+\.ya?ml$/i,
  gitlab: /\.gitlab-ci\.ya?ml$|\.gitlab\/[^/]+\.ya?ml$/i,
  bitbucket: /bitbucket-pipelines\.ya?ml$/i,
  azure: /azure-pipelines\.ya?ml$|azure-pipelines.*\.ya?ml$/i,
  jenkins: /Jenkinsfile$/,
};

function detectProvider(file: string, override: CiProviderForAudit | null): CiProviderForAudit {
  if (override) return override;
  for (const [p, re] of Object.entries(PROVIDER_HINT_FILES) as [CiProviderForAudit, RegExp][]) {
    if (re.test(file)) return p;
  }
  return 'github-actions';
}

interface IPatternHit {
  line: number;
  match: string;
}

function findLines(body: string, re: RegExp): IPatternHit[] {
  const hits: IPatternHit[] = [];
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = re.exec(lines[i]!);
    if (m) hits.push({ line: i + 1, match: m[0] });
  }
  return hits;
}

function findAllExternalActions(body: string): string[] {
  const found = new Set<string>();
  // `- uses: actions/checkout@v4` or `uses: org/action@hash`
  for (const hit of findLines(body, /uses:\s*([\w\-]+\/[\w\-./]+@[\w.\-]+)/)) {
    const m = /uses:\s*([^\s]+)/.exec(hit.match);
    if (m && m[1]) found.add(m[1]);
  }
  return [...found].sort();
}

function findAllExternalImages(body: string): string[] {
  const found = new Set<string>();
  // GitHub Actions: `container: image: foo/bar:tag` or `services: image:`
  for (const hit of findLines(body, /image:\s*([\w\-./]+(:\S+)?)/)) {
    const m = /image:\s*(\S+)/.exec(hit.match);
    if (m && m[1]) found.add(m[1]);
  }
  return [...found].sort();
}

function detectGithubAudit(body: string, file: string): ICiPermissionsAudit {
  const findings: ICiPermissionsFinding[] = [];
  const notes: string[] = [];

  // permissions block?
  const permsLines = findLines(body, /^\s*permissions:/);
  const writePerm = findLines(body, /^\s*(?:contents|pull-requests|issues|deployments|actions):\s*write\b/);
  if (permsLines.length === 0) {
    findings.push({
      code: 'permissions-block-missing',
      severity: 'info',
      message: 'No top-level `permissions:` block — workflow inherits the repository default. Pinning least-privilege explicitly is safer.',
      lines: [],
      suggestion: 'Add a `permissions:` block scoped to `contents: read`.',
    });
  }
  if (writePerm.length > 0) {
    findings.push({
      code: 'permissions-write-requested',
      severity: 'warning',
      message: `Workflow requests write scopes on ${writePerm.length} line(s). Confirm each is required.`,
      lines: writePerm.map((h) => h.line),
      suggestion: 'Remove unused write scopes; only enable them on the specific job that needs them.',
    });
  }
  // Comment posting hints — `gh pr comment`, `actions/github-script@`, `peter-evans/create-or-update-comment`.
  const commentHits = [
    ...findLines(body, /\bgh\s+pr\s+(comment|review)/),
    ...findLines(body, /actions\/github-script@/),
    ...findLines(body, /peter-evans\/create-or-update-comment/),
    ...findLines(body, /thollander\/actions-comment-pull-request/),
  ];
  const postsComments = commentHits.length > 0;
  if (postsComments) {
    findings.push({
      code: 'comment-posting-detected',
      severity: 'warning',
      message: 'Workflow posts PR comments. This requires `pull-requests: write` and a token with that scope.',
      lines: commentHits.map((h) => h.line),
      suggestion: 'Either keep the comment-posting step disabled (recommended for demos) or scope `pull-requests: write` to just that job.',
    });
  }
  const tokenHits = findLines(body, /\$\{\{\s*secrets\.(GITHUB_TOKEN|GH_TOKEN)\s*\}\}/);
  if (tokenHits.length > 0) {
    findings.push({
      code: 'token-usage',
      severity: 'info',
      message: 'Workflow uses GITHUB_TOKEN / GH_TOKEN. Make sure the permissions block scopes match the operations.',
      lines: tokenHits.map((h) => h.line),
    });
  }
  const externalActions = findAllExternalActions(body);
  const externalImages = findAllExternalImages(body);
  if (externalActions.length > 0) {
    findings.push({
      code: 'external-action',
      severity: 'info',
      message: `Uses ${externalActions.length} external action(s).`,
      lines: [],
      suggestion: 'Pin actions to a specific commit SHA when possible to mitigate supply-chain risk.',
    });
  }
  if (externalImages.length > 0) {
    findings.push({
      code: 'external-image',
      severity: 'info',
      message: `Uses ${externalImages.length} external container image(s).`,
      lines: [],
      suggestion: 'Pin image digests in supply-chain-sensitive workflows.',
    });
  }
  const uploadsArtifacts = findLines(body, /actions\/upload-artifact@/).length > 0;
  if (uploadsArtifacts) {
    findings.push({
      code: 'artifact-upload',
      severity: 'info',
      message: 'Workflow uploads artifacts via actions/upload-artifact.',
      lines: [],
    });
  }
  // Recommendation
  const recommendation = postsComments
    ? `permissions:\n  contents: read\n  pull-requests: write   # required by the comment-posting step\n`
    : `permissions:\n  contents: read   # least-privilege default for the SharkCraft review surface\n`;
  if (!postsComments) {
    notes.push('No comment-posting step detected — `pull-requests: write` is NOT required for this workflow.');
  } else {
    notes.push('Comment-posting step detected — scope `pull-requests: write` to just the job that needs it.');
  }
  return {
    schema: CI_PERMISSIONS_AUDIT_SCHEMA,
    provider: 'github-actions',
    workflowFile: file,
    exists: true,
    postsComments,
    requestsWritePermissions: writePerm.length > 0,
    usesTokens: tokenHits.length > 0,
    externalActions,
    externalImages,
    uploadsArtifacts,
    findings,
    recommendation,
    notes,
  };
}

function detectGitlabAudit(body: string, file: string): ICiPermissionsAudit {
  const findings: ICiPermissionsFinding[] = [];
  const notes: string[] = [];
  const commentHits = [
    ...findLines(body, /merge_requests\/\$CI_MERGE_REQUEST_IID\/notes/),
    ...findLines(body, /\bPRIVATE-TOKEN\b/),
  ];
  const postsComments = commentHits.length > 0;
  if (postsComments) {
    findings.push({
      code: 'comment-posting-detected',
      severity: 'warning',
      message: 'Pipeline posts MR comments via the GitLab API.',
      lines: commentHits.map((h) => h.line),
      suggestion: 'Use a PRIVATE-TOKEN with scope api or write_repository — keep the value in a masked CI/CD variable, not the file.',
    });
  }
  const tokenHits = findLines(body, /\$CI_JOB_TOKEN|\$PRIVATE_TOKEN|\$REVIEW_TOKEN/);
  if (tokenHits.length > 0) {
    findings.push({
      code: 'token-usage',
      severity: 'info',
      message: 'Pipeline uses a CI token / PRIVATE-TOKEN. Scope it to the minimum needed.',
      lines: tokenHits.map((h) => h.line),
    });
  }
  const externalImages = findAllExternalImages(body);
  if (externalImages.length > 0) {
    findings.push({
      code: 'external-image',
      severity: 'info',
      message: `Uses ${externalImages.length} container image(s).`,
      lines: [],
    });
  }
  const uploadsArtifacts = findLines(body, /artifacts:/).length > 0;
  if (uploadsArtifacts) {
    findings.push({
      code: 'artifact-upload',
      severity: 'info',
      message: 'Pipeline declares `artifacts:` blocks.',
      lines: [],
    });
  }
  notes.push(
    postsComments
      ? 'Comment-posting step detected — use a CI/CD variable holding a token with `api` scope.'
      : 'No comment-posting step detected — the default $CI_JOB_TOKEN is read-only for repo metadata.',
  );
  const recommendation = postsComments
    ? '# Use a masked CI/CD variable named REVIEW_TOKEN with scope api on the project.\n# Avoid Project Access Tokens with owner scope — Reporter+api is enough for notes.'
    : '# No write permissions required; $CI_JOB_TOKEN is sufficient.';
  return {
    schema: CI_PERMISSIONS_AUDIT_SCHEMA,
    provider: 'gitlab',
    workflowFile: file,
    exists: true,
    postsComments,
    requestsWritePermissions: false,
    usesTokens: tokenHits.length > 0,
    externalActions: [],
    externalImages,
    uploadsArtifacts,
    findings,
    recommendation,
    notes,
  };
}

function detectBitbucketAudit(body: string, file: string): ICiPermissionsAudit {
  const findings: ICiPermissionsFinding[] = [];
  const notes: string[] = [];
  const commentHits = findLines(body, /pullrequests\/.*\/comments/i);
  const postsComments = commentHits.length > 0;
  if (postsComments) {
    findings.push({
      code: 'comment-posting-detected',
      severity: 'warning',
      message: 'Pipeline posts PR comments via the Bitbucket REST API.',
      lines: commentHits.map((h) => h.line),
      suggestion: 'Use a repository access token with PR write scope — stored as a Pipelines secured variable.',
    });
  }
  const tokenHits = findLines(body, /\$BITBUCKET_TOKEN|\$BITBUCKET_REPO_ACCESS_TOKEN/);
  if (tokenHits.length > 0) {
    findings.push({
      code: 'token-usage',
      severity: 'info',
      message: 'Pipeline uses a Bitbucket token. Scope it tightly.',
      lines: tokenHits.map((h) => h.line),
    });
  }
  const externalImages = findAllExternalImages(body);
  if (externalImages.length > 0) {
    findings.push({
      code: 'external-image',
      severity: 'info',
      message: `Uses ${externalImages.length} container image(s).`,
      lines: [],
    });
  }
  notes.push(postsComments ? 'Comment-posting step detected.' : 'No comment-posting step detected.');
  return {
    schema: CI_PERMISSIONS_AUDIT_SCHEMA,
    provider: 'bitbucket',
    workflowFile: file,
    exists: true,
    postsComments,
    requestsWritePermissions: false,
    usesTokens: tokenHits.length > 0,
    externalActions: [],
    externalImages,
    uploadsArtifacts: findLines(body, /^\s*artifacts:/m).length > 0,
    findings,
    recommendation: postsComments
      ? '# Create a Repository Access Token with `pullrequest:write` scope; store as a Pipelines secured variable.'
      : '# No write permissions required.',
    notes,
  };
}

function detectAzureAudit(body: string, file: string): ICiPermissionsAudit {
  const findings: ICiPermissionsFinding[] = [];
  const notes: string[] = [];
  const tokenHits = findLines(body, /\$\(System\.AccessToken\)|System\.AccessToken/);
  const usesTokens = tokenHits.length > 0;
  if (usesTokens) {
    findings.push({
      code: 'token-usage',
      severity: 'info',
      message: 'Pipeline uses $(System.AccessToken). Restrict scopes in Project Settings.',
      lines: tokenHits.map((h) => h.line),
    });
  }
  const uploadsArtifacts = findLines(body, /PublishPipelineArtifact|publish:|UploadPipelineArtifact|publishLocation/).length > 0;
  if (uploadsArtifacts) {
    findings.push({
      code: 'artifact-upload',
      severity: 'info',
      message: 'Pipeline publishes artifacts.',
      lines: [],
    });
  }
  notes.push('Restrict pipeline scope to read-only repo access; explicitly grant write only on the job that needs it.');
  return {
    schema: CI_PERMISSIONS_AUDIT_SCHEMA,
    provider: 'azure',
    workflowFile: file,
    exists: true,
    postsComments: false,
    requestsWritePermissions: false,
    usesTokens,
    externalActions: [],
    externalImages: findAllExternalImages(body),
    uploadsArtifacts,
    findings,
    recommendation: '# Use a project-level service connection limited to read scope, plus a dedicated write-scope token only for jobs that need it.',
    notes,
  };
}

function detectJenkinsAudit(body: string, file: string): ICiPermissionsAudit {
  const findings: ICiPermissionsFinding[] = [];
  const notes: string[] = [];
  const tokenHits = findLines(body, /credentials\(['"]([^'"]+)['"]\)|withCredentials/);
  if (tokenHits.length > 0) {
    findings.push({
      code: 'token-usage',
      severity: 'info',
      message: 'Pipeline uses Jenkins credentials. Make sure they\'re scoped to the right folder/job.',
      lines: tokenHits.map((h) => h.line),
    });
  }
  const archiveHits = findLines(body, /archiveArtifacts|publishHTML|publishArtifacts/);
  const uploadsArtifacts = archiveHits.length > 0;
  if (uploadsArtifacts) {
    findings.push({
      code: 'artifact-upload',
      severity: 'info',
      message: 'Pipeline archives artifacts.',
      lines: archiveHits.map((h) => h.line),
    });
  }
  notes.push('No write to source repo is required by the SharkCraft review surface.');
  return {
    schema: CI_PERMISSIONS_AUDIT_SCHEMA,
    provider: 'jenkins',
    workflowFile: file,
    exists: true,
    postsComments: false,
    requestsWritePermissions: false,
    usesTokens: tokenHits.length > 0,
    externalActions: [],
    externalImages: findAllExternalImages(body),
    uploadsArtifacts,
    findings,
    recommendation: '# Use a Jenkins credential scoped to the folder; never store tokens in the Jenkinsfile itself.',
    notes,
  };
}

export interface IAuditCiWorkflowInput {
  /** Absolute path to the workflow file. */
  file: string;
  /** Override the detected provider (useful when the filename is non-standard). */
  provider?: CiProviderForAudit | null;
}

export function auditCiWorkflow(input: IAuditCiWorkflowInput): ICiPermissionsAudit {
  const file = input.file;
  if (!existsSync(file)) {
    return {
      schema: CI_PERMISSIONS_AUDIT_SCHEMA,
      provider: detectProvider(file, input.provider ?? null),
      workflowFile: file,
      exists: false,
      postsComments: false,
      requestsWritePermissions: false,
      usesTokens: false,
      externalActions: [],
      externalImages: [],
      uploadsArtifacts: false,
      findings: [
        {
          code: 'shell-step',
          severity: 'error',
          message: `Workflow file not found: ${file}`,
          lines: [],
        },
      ],
      recommendation: '',
      notes: [],
    };
  }
  let body = '';
  try {
    body = readFileSync(file, 'utf8');
  } catch (e) {
    return {
      schema: CI_PERMISSIONS_AUDIT_SCHEMA,
      provider: detectProvider(file, input.provider ?? null),
      workflowFile: file,
      exists: true,
      postsComments: false,
      requestsWritePermissions: false,
      usesTokens: false,
      externalActions: [],
      externalImages: [],
      uploadsArtifacts: false,
      findings: [
        {
          code: 'shell-step',
          severity: 'error',
          message: `Failed to read workflow: ${(e as Error).message}`,
          lines: [],
        },
      ],
      recommendation: '',
      notes: [],
    };
  }
  const provider = detectProvider(file, input.provider ?? null);
  switch (provider) {
    case 'gitlab':
      return detectGitlabAudit(body, file);
    case 'bitbucket':
      return detectBitbucketAudit(body, file);
    case 'azure':
      return detectAzureAudit(body, file);
    case 'jenkins':
      return detectJenkinsAudit(body, file);
    case 'github-actions':
    default:
      return detectGithubAudit(body, file);
  }
}
