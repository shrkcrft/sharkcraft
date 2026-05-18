import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  auditCiWorkflow,
  buildCiIntegrityReport,
  GateStatus,
  renderAzureCiWorkflow,
  renderBitbucketCiWorkflow,
  renderCiIntegrityHtml,
  renderCiIntegrityMarkdown,
  renderGitlabCiWorkflow,
  renderJenkinsCiWorkflow,
  type CiProviderForAudit,
  type ICiProviderScaffoldOptions,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  flagList,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';

/**
 * Detect which optional SharkCraft asset files exist under the given
 * sharkcraft/ folder. Used by `--quickstart` / `--preset auto` so we only
 * emit gates a small repo can actually run.
 */
interface IRepoAssetState {
  hasSharkcraftConfig: boolean;
  hasKnowledge: boolean;
  hasTemplates: boolean;
  hasPacks: boolean;
}

function detectRepoAssetState(cwd: string): IRepoAssetState {
  const dir = nodePath.join(cwd, 'sharkcraft');
  return {
    hasSharkcraftConfig: existsSync(nodePath.join(dir, 'sharkcraft.config.ts')),
    hasKnowledge: existsSync(nodePath.join(dir, 'knowledge.ts')),
    hasTemplates: existsSync(nodePath.join(dir, 'templates.ts')),
    hasPacks: existsSync(nodePath.join(dir, 'packs.ts')),
  };
}

interface IScaffoldInputs {
  withQuality: boolean;
  withReview: boolean;
  withBoundaries: boolean;
  withCoverage: boolean;
  withAgentTests: boolean;
  withDriftGate: boolean;
  withDrift: boolean;
  withBaseline: boolean;
  withPolicy: boolean;
  withOwners: boolean;
  withTestImpact: boolean;
  withDashboardE2e: boolean;
  withNodeCompat: boolean;
  withSafetyAudit: boolean;
  withCommandDoctor: boolean;
  withPackTests: boolean;
  withImpact: boolean;
  withReportSite: boolean;
  withBundleReplay: boolean;
  withPolicySnapshotGate: boolean;
  /** Knowledge stale-check gate (`shrk knowledge stale-check --ci`). */
  withKnowledgeCheck: boolean;
  /** Template drift gate (`shrk templates drift --ci`). */
  withTemplateDrift: boolean;
  /** Quickstart helpers (doctor / self-config doctor / packs signature). */
  withDoctor: boolean;
  withSelfConfigDoctor: boolean;
  withPackSignatureStatus: boolean;
  /** Boundary check uses `--changed-only` when true. */
  changedOnly: boolean;
  /** Emit a PR-comment step on github-actions (no other providers). */
  prComment: boolean;
  packPaths: readonly string[];
}

interface IStep {
  name: string;
  command: string;
  artifact: string;
}

function buildSteps(inputs: IScaffoldInputs): IStep[] {
  const steps: IStep[] = [];
  if (inputs.withDoctor) {
    steps.push({ name: 'SharkCraft doctor', command: 'bun run shrk doctor', artifact: 'doctor.log' });
  }
  if (inputs.withQuality) {
    const qa = inputs.withDriftGate ? 'quality --ci --require-drift-clean' : 'quality --ci';
    steps.push({ name: 'SharkCraft quality', command: `bun run shrk ${qa} > quality.json`, artifact: 'quality.json' });
  }
  if (inputs.withReview) {
    steps.push({ name: 'Build review packet', command: 'bun run shrk review --since origin/main --json > review-packet.json', artifact: 'review-packet.json' });
  }
  if (inputs.withBoundaries) {
    const boundaryFlags = inputs.changedOnly
      ? 'check boundaries --changed-only --json'
      : 'check boundaries --json';
    steps.push({ name: 'Boundary check', command: `bun run shrk ${boundaryFlags} > boundaries.json`, artifact: 'boundaries.json' });
  }
  if (inputs.withSelfConfigDoctor) {
    steps.push({ name: 'Self-config doctor', command: 'bun run shrk self-config doctor --json > self-config-doctor.json', artifact: 'self-config-doctor.json' });
  }
  if (inputs.withPackSignatureStatus) {
    steps.push({ name: 'Pack signature status', command: 'bun run shrk packs signature-status --json > pack-signature-status.json', artifact: 'pack-signature-status.json' });
  }
  if (inputs.withCoverage) {
    steps.push({ name: 'Coverage report', command: 'bun run shrk coverage --json > coverage.json', artifact: 'coverage.json' });
  }
  if (inputs.withAgentTests) {
    steps.push({ name: 'Agent contract tests', command: 'bun run shrk test agent --json > agent-tests.json', artifact: 'agent-tests.json' });
  }
  if (inputs.withDrift && !inputs.withDriftGate) {
    steps.push({ name: 'Drift report', command: 'bun run shrk drift --json > drift.json', artifact: 'drift.json' });
  }
  if (inputs.withBaseline) {
    steps.push({ name: 'Quality baseline compare', command: 'bun run shrk quality baseline-compare --fail-on-regression --json > baseline-compare.json', artifact: 'baseline-compare.json' });
  }
  if (inputs.withPolicy) {
    steps.push({ name: 'Policy check', command: 'bun run shrk policy check --json > policy.json', artifact: 'policy.json' });
  }
  if (inputs.withPolicySnapshotGate) {
    steps.push({
      name: 'Policy snapshot gate',
      command: 'bun run shrk policy snapshot --all --gate --json > policy-snapshots.json',
      artifact: 'policy-snapshots.json',
    });
  }
  if (inputs.withImpact) {
    steps.push({
      name: 'Impact since origin/main',
      command:
        'mkdir -p .sharkcraft/reports && bun run shrk impact --since origin/main --format json > .sharkcraft/reports/impact.json || true',
      artifact: '.sharkcraft/reports/impact.json',
    });
  }
  if (inputs.withBundleReplay) {
    steps.push({
      name: 'Bundle replay (all)',
      command: 'bun run shrk bundle replay --all --report --html || true',
      artifact: '.sharkcraft/reports/bundle-replay-all.md',
    });
  }
  if (inputs.withReportSite) {
    steps.push({
      name: 'Static report site',
      command: 'bun run shrk report site --output .sharkcraft/reports/site || true',
      artifact: '.sharkcraft/reports/site/index.html',
    });
  }
  if (inputs.withOwners) {
    steps.push({ name: 'Owners list', command: 'bun run shrk owners list --json > owners.json', artifact: 'owners.json' });
  }
  if (inputs.withTestImpact) {
    steps.push({ name: 'Test impact', command: 'bun run shrk tests impact --json > test-impact.json', artifact: 'test-impact.json' });
  }
  if (inputs.withDashboardE2e) {
    steps.push({ name: 'Dashboard E2E', command: 'bun run test:e2e:dashboard', artifact: 'dashboard-e2e.log' });
  }
  if (inputs.withSafetyAudit) {
    steps.push({ name: 'Safety audit', command: 'bun run shrk safety audit --json > safety-audit.json', artifact: 'safety-audit.json' });
  }
  if (inputs.withCommandDoctor) {
    steps.push({ name: 'Command doctor', command: 'bun run shrk commands doctor --json > commands-doctor.json', artifact: 'commands-doctor.json' });
  }
  if (inputs.withNodeCompat) {
    steps.push({ name: 'Node compatibility', command: 'bun run compat:node > node-compat.json', artifact: 'node-compat.json' });
  }
  if (inputs.withPackTests && inputs.packPaths.length > 0) {
    for (const p of inputs.packPaths) {
      const slug = p.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 32) || 'pack';
      steps.push({ name: `Pack test (${slug})`, command: `bun run shrk packs test ${p} --load --json > pack-test-${slug}.json`, artifact: `pack-test-${slug}.json` });
    }
  }
  // Integrity gates.
  if (inputs.withKnowledgeCheck) {
    steps.push({
      name: 'Knowledge stale-check (CI)',
      command:
        'mkdir -p .sharkcraft/reports && bun run shrk knowledge stale-check --ci --format json > .sharkcraft/reports/knowledge-stale.json',
      artifact: '.sharkcraft/reports/knowledge-stale.json',
    });
  }
  if (inputs.withTemplateDrift) {
    steps.push({
      name: 'Template drift (CI)',
      command:
        'mkdir -p .sharkcraft/reports && bun run shrk templates drift --ci --format json > .sharkcraft/reports/template-drift.json',
      artifact: '.sharkcraft/reports/template-drift.json',
    });
  }
  return steps;
}

function githubYaml(steps: IStep[], inputs?: IScaffoldInputs): string {
  const lines: string[] = [];
  lines.push('# .github/workflows/sharkcraft.yml');
  lines.push('name: SharkCraft');
  lines.push('on:');
  lines.push('  pull_request:');
  lines.push('    branches: [main]');
  lines.push('  push:');
  lines.push('    branches: [main]');
  if (inputs?.prComment) {
    lines.push('permissions:');
    lines.push('  contents: read');
    lines.push('  pull-requests: write');
  }
  lines.push('jobs:');
  lines.push('  sharkcraft:');
  lines.push('    runs-on: ubuntu-latest');
  lines.push('    steps:');
  lines.push('      - uses: actions/checkout@v4');
  lines.push('        with:');
  lines.push('          fetch-depth: 0');
  lines.push('      - uses: oven-sh/setup-bun@v1');
  lines.push('      - run: bun install');
  for (const s of steps) {
    lines.push(`      - name: ${s.name}`);
    // Small-repo quickstart should not fail builds on missing advanced
    // surfaces. Wrap each step in `|| true` for quickstart-style runs.
    const wrapped = inputs && (inputs as IScaffoldInputs).withDoctor && !s.command.includes('|| true')
      ? `${s.command} || true`
      : s.command;
    lines.push(`        run: ${wrapped}`);
  }
  for (const s of steps) {
    lines.push('      - uses: actions/upload-artifact@v4');
    lines.push('        if: always()');
    lines.push('        with:');
    lines.push(`          name: ${slug(s.name)}`);
    lines.push(`          path: ${s.artifact}`);
  }
  if (inputs?.prComment) {
    lines.push('      - name: Post SharkCraft summary comment');
    lines.push("        if: github.event_name == 'pull_request'");
    lines.push('        uses: actions/github-script@v7');
    lines.push('        with:');
    lines.push('          script: |');
    lines.push("            const body = '### SharkCraft checks completed\\n\\nSee the workflow artifacts for full reports.';");
    lines.push('            await github.rest.issues.createComment({');
    lines.push('              issue_number: context.issue.number,');
    lines.push('              owner: context.repo.owner,');
    lines.push('              repo: context.repo.repo,');
    lines.push('              body,');
    lines.push('            });');
  }
  if (steps.length === 0) {
    lines.push('      - run: echo "No SharkCraft checks selected — pass --quickstart for sensible defaults."');
  }
  return lines.join('\n') + '\n';
}

function gitlabYaml(steps: IStep[], inputs?: IScaffoldInputs): string {
  if (inputs) {
    // Use the richer staged scaffold from @shrkcrft/inspector.
    return renderGitlabCiWorkflow({
      withQuality: inputs.withQuality,
      withPolicy: inputs.withPolicy,
      withPolicySnapshotGate: inputs.withPolicySnapshotGate,
      withImpact: inputs.withImpact,
      withReview: inputs.withReview,
      withReportSite: inputs.withReportSite,
      withBundleReplay: inputs.withBundleReplay,
      withNodeCompat: inputs.withNodeCompat,
    });
  }
  const lines: string[] = [];
  lines.push('# .gitlab-ci.yml');
  lines.push('sharkcraft:');
  lines.push('  image: oven/bun:1.1');
  lines.push('  stage: test');
  lines.push('  script:');
  lines.push('    - bun install');
  for (const s of steps) {
    lines.push(`    - ${s.command}`);
  }
  if (steps.length > 0) {
    lines.push('  artifacts:');
    lines.push('    when: always');
    lines.push('    paths:');
    for (const s of steps) lines.push(`      - ${s.artifact}`);
  }
  return lines.join('\n') + '\n';
}

function circleciYaml(steps: IStep[]): string {
  const lines: string[] = [];
  lines.push('# .circleci/config.yml');
  lines.push("version: '2.1'");
  lines.push('jobs:');
  lines.push('  sharkcraft:');
  lines.push('    docker:');
  lines.push('      - image: oven/bun:1.1');
  lines.push('    steps:');
  lines.push('      - checkout');
  lines.push('      - run: bun install');
  for (const s of steps) {
    lines.push(`      - run:`);
    lines.push(`          name: ${s.name}`);
    lines.push(`          command: ${s.command}`);
  }
  for (const s of steps) {
    lines.push(`      - store_artifacts:`);
    lines.push(`          path: ${s.artifact}`);
  }
  lines.push('workflows:');
  lines.push('  sharkcraft:');
  lines.push('    jobs:');
  lines.push('      - sharkcraft');
  return lines.join('\n') + '\n';
}

function bitbucketYaml(steps: IStep[], inputs?: IScaffoldInputs): string {
  if (inputs) {
    return renderBitbucketCiWorkflow({
      withQuality: inputs.withQuality,
      withPolicy: inputs.withPolicy,
      withPolicySnapshotGate: inputs.withPolicySnapshotGate,
      withImpact: inputs.withImpact,
      withReview: inputs.withReview,
      withReportSite: inputs.withReportSite,
      withBundleReplay: inputs.withBundleReplay,
      withNodeCompat: inputs.withNodeCompat,
    });
  }
  const lines: string[] = [];
  lines.push('# bitbucket-pipelines.yml');
  lines.push('image: oven/bun:1.1');
  lines.push('pipelines:');
  lines.push('  default:');
  lines.push('    - step:');
  lines.push('        name: SharkCraft');
  lines.push('        script:');
  lines.push('          - bun install');
  for (const s of steps) lines.push(`          - ${s.command}`);
  if (steps.length > 0) {
    lines.push('        artifacts:');
    for (const s of steps) lines.push(`          - ${s.artifact}`);
  }
  return lines.join('\n') + '\n';
}

function azureYaml(steps: IStep[]): string {
  const lines: string[] = [];
  lines.push('# azure-pipelines.yml');
  lines.push('trigger:');
  lines.push('  - main');
  lines.push('pool:');
  lines.push('  vmImage: ubuntu-latest');
  lines.push('steps:');
  lines.push('  - script: curl -fsSL https://bun.sh/install | bash');
  lines.push('    displayName: Install Bun');
  lines.push('  - script: ~/.bun/bin/bun install');
  lines.push('    displayName: Install deps');
  for (const s of steps) {
    lines.push(`  - script: ~/.bun/bin/${s.command}`);
    lines.push(`    displayName: ${s.name}`);
  }
  for (const s of steps) {
    lines.push(`  - publish: ${s.artifact}`);
    lines.push(`    artifact: ${slug(s.name)}`);
    lines.push('    condition: always()');
  }
  return lines.join('\n') + '\n';
}

function jenkinsFile(_steps: IStep[], inputs?: IScaffoldInputs): string {
  if (!inputs) return '// (no inputs)\n';
  const opts: ICiProviderScaffoldOptions = {
    withQuality: inputs.withQuality,
    withPolicy: inputs.withPolicy,
    withPolicySnapshotGate: inputs.withPolicySnapshotGate,
    withImpact: inputs.withImpact,
    withReview: inputs.withReview,
    withReportSite: inputs.withReportSite,
    withBundleReplay: inputs.withBundleReplay,
    withNodeCompat: inputs.withNodeCompat,
  };
  return renderJenkinsCiWorkflow(opts);
}

function azureFromInputs(_steps: IStep[], inputs?: IScaffoldInputs): string {
  if (!inputs) return '# (no inputs)\n';
  const opts: ICiProviderScaffoldOptions = {
    withQuality: inputs.withQuality,
    withPolicy: inputs.withPolicy,
    withPolicySnapshotGate: inputs.withPolicySnapshotGate,
    withImpact: inputs.withImpact,
    withReview: inputs.withReview,
    withReportSite: inputs.withReportSite,
    withBundleReplay: inputs.withBundleReplay,
    withNodeCompat: inputs.withNodeCompat,
  };
  return renderAzureCiWorkflow(opts);
}

// `circleci`, `azure`, `azure-pipelines`, `jenkins` providers are not
// part of the visible scaffold surface. GHA is first-class; GitLab and
// Bitbucket remain as supported alternatives. The other providers are
// documented in `docs/ci-providers.md` only. Their `*Yaml` / `*File`
// builders stay importable for code that needs the rendered output
// (tests / pack consumers), but the CLI no longer routes to them.
const PROVIDERS: Record<
  string,
  { defaultPath: string; build: (steps: IStep[], inputs?: IScaffoldInputs) => string }
> = {
  'github-actions': { defaultPath: '.github/workflows/sharkcraft.yml', build: githubYaml },
  gitlab: { defaultPath: '.gitlab-ci.yml', build: gitlabYaml },
  bitbucket: { defaultPath: 'bitbucket-pipelines.yml', build: bitbucketYaml },
};

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Build a short explanation row for every gate the scaffolded
 * workflow will run. The `enabledBy` column lets a reviewer see
 * whether each gate was turned on by detection (quickstart sniffed
 * the relevant asset) or by an explicit flag. Each row also says
 * what the gate actually protects so the reader does not need to know
 * SharkCraft internals.
 */
interface IGateExplanation {
  gate: string;
  enabledBy: 'detected' | 'flag' | 'always';
  purpose: string;
}

function buildGateExplanations(
  inputs: IScaffoldInputs,
  state: IRepoAssetState,
): IGateExplanation[] {
  const rows: IGateExplanation[] = [];
  if (inputs.withDoctor) {
    rows.push({
      gate: 'shrk doctor',
      enabledBy: 'detected',
      purpose: 'Validate sharkcraft/ config + knowledge / rules / templates registries.',
    });
  }
  if (inputs.withBoundaries) {
    rows.push({
      gate: inputs.changedOnly ? 'check boundaries --changed-only' : 'check boundaries',
      enabledBy: inputs.changedOnly ? 'detected' : 'flag',
      purpose: 'Cross-layer / cross-package boundary enforcement (ESLint cannot express this).',
    });
  }
  if (inputs.withSelfConfigDoctor) {
    rows.push({
      gate: 'self-config doctor',
      enabledBy: state.hasSharkcraftConfig ? 'detected' : 'flag',
      purpose: 'Repo-shape sanity (action hints, verification commands, rule wiring).',
    });
  }
  if (inputs.withKnowledgeCheck) {
    rows.push({
      gate: 'knowledge stale-check',
      enabledBy: state.hasKnowledge ? 'detected' : 'flag',
      purpose: 'Surface knowledge entries that no longer match the code they reference.',
    });
  }
  if (inputs.withTemplateDrift) {
    rows.push({
      gate: 'templates drift',
      enabledBy: state.hasTemplates ? 'detected' : 'flag',
      purpose: 'Catch templates that have drifted from the constructs they generate.',
    });
  }
  if (inputs.withPackSignatureStatus) {
    rows.push({
      gate: 'packs signature-status',
      enabledBy: state.hasPacks ? 'detected' : 'flag',
      purpose: 'Surface unsigned / stale pack signatures before merge.',
    });
  }
  if (inputs.withQuality) {
    rows.push({
      gate: 'shrk quality',
      enabledBy: 'flag',
      purpose: 'Aggregated quality gate (doctor + boundaries + coverage + drift + packs).',
    });
  }
  if (inputs.withSafetyAudit) {
    rows.push({
      gate: 'safety audit',
      enabledBy: 'flag',
      purpose: 'MCP-write + sign-bypass + write-policy audit (no fake signing tolerated).',
    });
  }
  if (inputs.prComment) {
    rows.push({
      gate: 'PR summary comment',
      enabledBy: 'flag',
      purpose: 'Post a short status comment on the PR after the workflow completes.',
    });
  }
  return rows;
}

export const ciCommand: ICommandHandler = {
  name: 'ci',
  description: 'Scaffold CI configurations for SharkCraft (github-actions, gitlab, circleci, bitbucket, azure-pipelines, jenkins, azure). `shrk ci permissions` audits a workflow file. Supports --with-knowledge-check / --with-template-drift / --with-integrity.',
  usage:
    'shrk ci scaffold <provider> [--with-quality] [--with-review] [--with-boundaries] [--with-coverage] [--with-drift-gate] [--with-drift] [--with-baseline] [--with-policy] [--with-owners] [--with-test-impact] [--with-dashboard-e2e] [--with-node-compat] [--with-safety-audit] [--with-command-doctor] [--with-pack-tests --pack-paths <p1,p2>] [--with-knowledge-check] [--with-template-drift] [--with-integrity] [--output <path>] [--write] [--force] [--json]\n  shrk ci permissions <workflow-file> [--provider github-actions|gitlab|bitbucket|azure|jenkins] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const verb = args.positional[0];
    if (verb === 'permissions') {
      return runCiPermissions({ ...args, positional: args.positional.slice(1) });
    }
    if (verb === 'report') {
      return runCiReport({ ...args, positional: args.positional.slice(1) });
    }
    // `ci predict` / `ci would-fail` removed (advisory; no tests; not on spine).
    if (verb !== 'scaffold') {
      process.stderr.write('Usage: shrk ci scaffold <provider> [...flags]\n   or: shrk ci permissions <workflow-file>\n   or: shrk ci report [--reports-dir <dir>] [--format text|markdown|html|json] [--fail-on error|warning|none]\n');
      return 2;
    }
    const target = args.positional[1];
    if (!target || !PROVIDERS[target]) {
      process.stderr.write(
        `Unknown CI target "${target ?? ''}". Available: ${Object.keys(PROVIDERS).join(', ')}\n`,
      );
      return 2;
    }
    const cwd = resolveCwd(args);
    const packPathsList = flagList(args, 'pack-paths');
    const withIntegrity = flagBool(args, 'with-integrity');

    // Quickstart / preset auto / pr-checks all expand into the
    // sensible-default bundle, gated on what the small repo actually has.
    const wantQuickstart =
      flagBool(args, 'quickstart') ||
      flagBool(args, 'with-pr-checks') ||
      flagString(args, 'preset') === 'auto';
    const wantChangedOnly = flagBool(args, 'changed-only') || wantQuickstart;
    const wantPrComment = flagBool(args, 'pr-comment');

    // Snapshot which assets are present so we never enable a gate the repo
    // cannot run.
    const assetState = detectRepoAssetState(cwd);

    const quickstartOverrides = wantQuickstart
      ? {
          withDoctor: true,
          withBoundaries: true,
          withKnowledgeCheck: assetState.hasKnowledge,
          withTemplateDrift: assetState.hasTemplates,
          withSelfConfigDoctor: assetState.hasSharkcraftConfig,
          withPackSignatureStatus: assetState.hasPacks,
        }
      : {};

    const inputs: IScaffoldInputs = {
      withQuality: flagBool(args, 'with-quality'),
      withReview: flagBool(args, 'with-review'),
      withBoundaries: flagBool(args, 'with-boundaries') || (quickstartOverrides.withBoundaries ?? false),
      withCoverage: flagBool(args, 'with-coverage'),
      withAgentTests: flagBool(args, 'with-agent-tests'),
      withDriftGate: flagBool(args, 'with-drift-gate'),
      withDrift: flagBool(args, 'with-drift'),
      withBaseline: flagBool(args, 'with-baseline'),
      withPolicy: flagBool(args, 'with-policy'),
      withOwners: flagBool(args, 'with-owners'),
      withTestImpact: flagBool(args, 'with-test-impact'),
      withDashboardE2e: flagBool(args, 'with-dashboard-e2e'),
      withNodeCompat: flagBool(args, 'with-node-compat'),
      withSafetyAudit: flagBool(args, 'with-safety-audit'),
      withCommandDoctor: flagBool(args, 'with-command-doctor'),
      withPackTests: flagBool(args, 'with-pack-tests'),
      withImpact: flagBool(args, 'with-impact'),
      withReportSite: flagBool(args, 'with-report-site'),
      withBundleReplay: flagBool(args, 'with-bundle-replay'),
      withPolicySnapshotGate: flagBool(args, 'with-policy-snapshot-gate'),
      // Knowledge stale-check + template drift gates. `--with-integrity`
      // is the shortcut that enables both.
      withKnowledgeCheck:
        flagBool(args, 'with-knowledge-check') || withIntegrity || (quickstartOverrides.withKnowledgeCheck ?? false),
      withTemplateDrift:
        flagBool(args, 'with-template-drift') || withIntegrity || (quickstartOverrides.withTemplateDrift ?? false),
      // Quickstart helpers + boundary flag + pr-comment.
      withDoctor: flagBool(args, 'with-doctor') || (quickstartOverrides.withDoctor ?? false),
      withSelfConfigDoctor:
        flagBool(args, 'with-self-config-doctor') || (quickstartOverrides.withSelfConfigDoctor ?? false),
      withPackSignatureStatus:
        flagBool(args, 'with-pack-signature-status') || (quickstartOverrides.withPackSignatureStatus ?? false),
      changedOnly: wantChangedOnly,
      prComment: wantPrComment && target === 'github-actions',
      packPaths: packPathsList,
    };
    const steps = buildSteps(inputs);
    let body = PROVIDERS[target]!.build(steps, inputs);
    // --polyglot appends per-language jobs to the rendered
    // workflow. All providers are supported.
    if (flagBool(args, 'polyglot')) {
      const {
        renderPolyglotGitHubActionsJobs,
        renderPolyglotGitlabJobs,
        renderPolyglotBitbucketSteps,
        renderPolyglotAzureStages,
        renderPolyglotJenkinsStages,
      } = await import('@shrkcrft/inspector');
      if (target === 'github-actions') body += renderPolyglotGitHubActionsJobs(cwd);
      else if (target === 'gitlab') body += renderPolyglotGitlabJobs(cwd);
      else if (target === 'bitbucket') body += renderPolyglotBitbucketSteps(cwd);
      else if (target === 'azure') body += renderPolyglotAzureStages(cwd);
      else if (target === 'jenkins') body += renderPolyglotJenkinsStages(cwd);
      else body += `\n# (provider does not yet support polyglot job injection)\n`;
    }
    const outputRel = flagString(args, 'output') ?? PROVIDERS[target]!.defaultPath;
    const outputAbs = nodePath.isAbsolute(outputRel) ? outputRel : nodePath.resolve(cwd, outputRel);

    const wantWrite = flagBool(args, 'write');
    const force = flagBool(args, 'force');
    const wantJson = flagBool(args, 'json');

    if (!wantWrite) {
      if (wantJson) {
        process.stdout.write(
          asJson({
            mode: 'dry-run',
            target,
            output: outputAbs,
            bytes: body.length,
            body,
            // Surface why each step is in the workflow so reviewers can
            // see what came from detection vs. an explicit flag.
            gates: buildGateExplanations(inputs, assetState),
            nextCommand: `shrk ci scaffold ${target} ${flagBool(args, 'quickstart') ? '--quickstart ' : ''}--write`,
          }) + '\n',
        );
        return 0;
      }
      process.stdout.write(header(`CI scaffold (${target}) — dry-run`));
      process.stdout.write(kv('exact path', outputAbs) + '\n');
      process.stdout.write(kv('bytes', String(body.length)) + '\n');
      process.stdout.write(
        kv(
          'next command',
          `shrk ci scaffold ${target} ${flagBool(args, 'quickstart') ? '--quickstart ' : ''}--write`,
        ) + '\n\n',
      );
      process.stdout.write(body);
      // Gate explanation block. Lists every step the workflow runs,
      // whether it was enabled by detection or by an explicit flag, and
      // what each step protects. Small repos see exactly what their CI
      // will do without having to read the YAML.
      const gates = buildGateExplanations(inputs, assetState);
      if (gates.length) {
        process.stdout.write('\n=== Explanation of gates ===\n');
        for (const g of gates) {
          process.stdout.write(`  ${g.gate.padEnd(28)} ${g.enabledBy.padEnd(14)} ${g.purpose}\n`);
        }
      }
      return 0;
    }
    if (existsSync(outputAbs) && !force) {
      process.stderr.write(`Refusing to overwrite existing file: ${outputAbs}. Pass --force.\n`);
      return 1;
    }
    mkdirSync(nodePath.dirname(outputAbs), { recursive: true });
    writeFileSync(outputAbs, body, 'utf8');
    if (wantJson) process.stdout.write(asJson({ mode: 'write', target, output: outputAbs, bytes: body.length }) + '\n');
    else process.stdout.write(`Wrote ${outputAbs}\n`);
    return 0;
  },
};

async function runCiPermissions(args: ParsedArgs): Promise<number> {
  const file = args.positional[0];
  if (!file) {
    process.stderr.write('Usage: shrk ci permissions <workflow-file> [--provider github-actions|gitlab|bitbucket|azure|jenkins]\n');
    return 2;
  }
  const cwd = resolveCwd(args);
  const abs = nodePath.isAbsolute(file) ? file : nodePath.resolve(cwd, file);
  const providerRaw = flagString(args, 'provider');
  const valid = new Set<CiProviderForAudit>(['github-actions', 'gitlab', 'bitbucket', 'azure', 'jenkins']);
  if (providerRaw && !valid.has(providerRaw as CiProviderForAudit)) {
    process.stderr.write(`Unknown --provider "${providerRaw}". Use github-actions|gitlab|bitbucket|azure|jenkins.\n`);
    return 2;
  }
  const audit = auditCiWorkflow({
    file: abs,
    provider: providerRaw ? (providerRaw as CiProviderForAudit) : null,
  });
  if (flagBool(args, 'fix-preview')) {
    const { buildCiPermissionsFixPreview, renderCiPermissionsFixPreview } = await import('@shrkcrft/inspector');
    const preview = buildCiPermissionsFixPreview(audit);
    const formatRaw = flagString(args, 'format') ?? (flagBool(args, 'json') ? 'json' : 'markdown');
    const fmt: 'patch' | 'markdown' | 'json' =
      formatRaw === 'patch' || formatRaw === 'json' || formatRaw === 'markdown'
        ? formatRaw
        : 'markdown';
    process.stdout.write(renderCiPermissionsFixPreview(preview, fmt));
    return preview.hints.some((h) => h.severity === 'error') ? 1 : 0;
  }
  if (flagBool(args, 'json')) {
    process.stdout.write(asJson(audit) + '\n');
    return audit.findings.some((f) => f.severity === 'error') ? 1 : 0;
  }
  process.stdout.write(header(`CI permissions audit (${audit.provider})`));
  process.stdout.write(kv('workflow', audit.workflowFile) + '\n');
  process.stdout.write(kv('exists', audit.exists ? 'yes' : 'no') + '\n');
  if (!audit.exists) {
    process.stdout.write('  workflow file not found\n');
    return 1;
  }
  process.stdout.write(kv('posts comments', audit.postsComments ? 'yes' : 'no') + '\n');
  process.stdout.write(kv('write perms requested', audit.requestsWritePermissions ? 'yes' : 'no') + '\n');
  process.stdout.write(kv('uses tokens', audit.usesTokens ? 'yes' : 'no') + '\n');
  process.stdout.write(kv('external actions', String(audit.externalActions.length)) + '\n');
  process.stdout.write(kv('external images', String(audit.externalImages.length)) + '\n');
  process.stdout.write(kv('uploads artifacts', audit.uploadsArtifacts ? 'yes' : 'no') + '\n\n');
  for (const f of audit.findings) {
    process.stdout.write(`  ${f.severity.toUpperCase().padEnd(8)} ${f.code.padEnd(28)} ${f.message}\n`);
    if (f.suggestion) process.stdout.write(`         ↳ ${f.suggestion}\n`);
    if (f.lines.length > 0)
      process.stdout.write(`         lines: ${f.lines.slice(0, 10).join(', ')}${f.lines.length > 10 ? '…' : ''}\n`);
  }
  if (audit.recommendation) {
    process.stdout.write('\nRecommended least-privilege block:\n');
    for (const line of audit.recommendation.split('\n')) process.stdout.write(`  ${line}\n`);
  }
  for (const n of audit.notes) process.stdout.write(`\nnote: ${n}\n`);
  return audit.findings.some((f) => f.severity === 'error') ? 1 : 0;
}

async function runCiReport(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const reportsDir = flagString(args, 'reports-dir') ?? '.sharkcraft/reports';
  const report = buildCiIntegrityReport(cwd, { reportsDir });
  const format = (flagString(args, 'format') ?? (flagBool(args, 'json') ? 'json' : 'text')).toLowerCase();
  const failOnRaw = (flagString(args, 'fail-on') ?? 'error').toLowerCase();
  const output = flagString(args, 'output');
  const exitForLevel = (level: string): number => {
    if (level === 'none') return 0;
    if (level === 'warning')
      return report.overall === GateStatus.Fail || report.overall === GateStatus.Warn ? 1 : 0;
    // default: error
    return report.overall === GateStatus.Fail ? 1 : 0;
  };
  const exitCode = exitForLevel(failOnRaw);
  if (format === 'json') {
    const payload = asJson(report) + '\n';
    if (output) writeReportFile(cwd, output, payload);
    else process.stdout.write(payload);
    return exitCode;
  }
  if (format === 'markdown') {
    const md = renderCiIntegrityMarkdown(report);
    if (output) writeReportFile(cwd, output, md);
    else process.stdout.write(md);
    return exitCode;
  }
  if (format === 'html') {
    const html = renderCiIntegrityHtml(report);
    if (output) writeReportFile(cwd, output, html);
    else process.stdout.write(html);
    return exitCode;
  }
  // text default
  process.stdout.write(header(`CI integrity (${report.overall})`));
  process.stdout.write(`  reports dir: ${report.reportsDir}\n`);
  process.stdout.write(`  errors:      ${report.totalErrors}\n`);
  process.stdout.write(`  warnings:    ${report.totalWarnings}\n\n`);
  for (const g of report.gates) {
    process.stdout.write(`  ${g.status.padEnd(7)} ${g.title.padEnd(28)} ${g.summary}\n`);
    if (g.nextCommand) process.stdout.write(`           next: ${g.nextCommand}\n`);
  }
  if (report.nextCommands.length > 0) {
    process.stdout.write('\nNext commands:\n');
    for (const c of report.nextCommands) process.stdout.write(`  $ ${c}\n`);
  } else if (report.gates.every((g) => g.status === GateStatus.Unknown)) {
    const { ciReportEmptyHints, renderFailureHints } = await import('../output/failure-hints.ts');
    process.stdout.write(renderFailureHints(ciReportEmptyHints()));
  }
  return exitCode;
}

function writeReportFile(cwd: string, file: string, body: string): void {
  const abs = nodePath.isAbsolute(file) ? file : nodePath.join(cwd, file);
  mkdirSync(nodePath.dirname(abs), { recursive: true });
  writeFileSync(abs, body, 'utf8');
  process.stdout.write(`Wrote ${abs}\n`);
}
