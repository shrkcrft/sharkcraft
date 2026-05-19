import {
  buildAcknowledgement,
  buildAiReadinessReport,
  buildSuppressionEntry,
  doctorSuppressionsFile,
  DoctorSeverity,
  filterDoctorResult,
  inspectSharkcraft,
  loadDoctorSuppressions,
  renderAcknowledgementsText,
  runDoctor,
  saveDoctorSuppressions,
  summarizeAcknowledgements,
  type IDoctorFilterOptions,
  type IDoctorSuppressionEntry,
} from '@shrkcrft/inspector';
import { detectProjectShape } from '@shrkcrft/workspace';
import { loadSurfaceContext } from '../surface/load-surface-context.ts';
import { buildSurfaceSummary } from '../surface/surface-summary.ts';
import { renderShapeLine } from '../surface/shape-defaults.ts';
import { existsSync } from 'node:fs';
import {
  flagBool,
  flagNumber,
  flagString,
  flagList,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';
import { maybeRunInWatchMode } from '../output/watch-loop.ts';
import { doctorHints, renderFailureHints } from '../output/failure-hints.ts';
import {
  foldDoctorChecks,
  renderFoldedSummary,
  DoctorState,
} from '../doctor/doctor-tags.ts';

const SEVERITY_LABEL: Record<DoctorSeverity, string> = {
  [DoctorSeverity.Ok]: 'OK   ',
  [DoctorSeverity.Info]: 'INFO ',
  [DoctorSeverity.Warning]: 'WARN ',
  [DoctorSeverity.Error]: 'ERR  ',
};

/**
 * Graduated strict modes:
 *  - `off`:       errors fail the run (default doctor behavior).
 *  - `errors`:    same as `off` — explicit opt-in alias.
 *  - `warnings`:  structural warnings also fail (excludes action-hint quality).
 *  - `all`:       any warning (including hint-quality) fails.
 */
type StrictMode = 'off' | 'errors' | 'warnings' | 'all';

function resolveStrictMode(args: ParsedArgs): StrictMode {
  const explicit = flagString(args, 'strict');
  if (explicit) {
    if (explicit === 'errors' || explicit === 'warnings' || explicit === 'all') {
      return explicit;
    }
    return 'warnings'; // unknown value → default strict behavior
  }
  if (flagBool(args, 'strict-all')) return 'all';
  if (flagBool(args, 'strict-warnings')) return 'warnings';
  if (flagBool(args, 'strict-errors')) return 'errors';
  if (flagBool(args, 'strict')) return 'warnings';
  return 'off';
}

function describeStrictMode(mode: StrictMode): string {
  switch (mode) {
    case 'all':
      return 'strict=all (every warning fails)';
    case 'warnings':
      return 'strict=warnings (structural warnings fail, advisory excluded)';
    case 'errors':
      return 'strict=errors (only errors fail)';
    case 'off':
      return '';
  }
}

interface IStrictEvaluation {
  failed: boolean;
  countedWarnings: number;
  excludedWarnings: number;
  reason: string;
}

function evaluateStrict(
  mode: StrictMode,
  checks: readonly { id: string; severity: DoctorSeverity; advisory?: boolean }[],
  errorCount: number,
): IStrictEvaluation {
  if (mode === 'off' || mode === 'errors') {
    return {
      failed: false,
      countedWarnings: 0,
      excludedWarnings: 0,
      reason: 'errors-only',
    };
  }
  let countedWarnings = 0;
  let excludedWarnings = 0;
  for (const c of checks) {
    if (c.severity !== DoctorSeverity.Warning) continue;
    // `--strict=warnings` excludes anything the inspector flagged as
    // advisory (action-hint quality today, any future advisory category
    // tomorrow). `--strict=all` counts every warning, advisory or not.
    if (mode === 'warnings' && c.advisory === true) {
      excludedWarnings += 1;
    } else {
      countedWarnings += 1;
    }
  }
  const failed = errorCount > 0 || countedWarnings > 0;
  return {
    failed,
    countedWarnings,
    excludedWarnings,
    reason:
      mode === 'all'
        ? 'any warning'
        : 'structural warnings only (advisory excluded)',
  };
}

function buildFilterOptions(args: ParsedArgs, suppressions: ReadonlyArray<IDoctorSuppressionEntry>): IDoctorFilterOptions {
  const opts: IDoctorFilterOptions = { suppressions };
  const focus = flagList(args, 'focus');
  if (focus.length > 0) {
    opts.focus = focus as IDoctorFilterOptions['focus'];
  }
  const hide = flagList(args, 'hide');
  if (hide.length > 0) opts.hide = hide;
  if (flagBool(args, 'quiet-known')) opts.quietKnown = true;
  return opts;
}

/**
 * Blockers-only preset.
 *
 * A finding is a blocker when:
 *   - severity = error, OR
 *   - severity = warning AND category is in BLOCKER_WARNING_CATEGORIES.
 *
 * Anything else (action-hint quality, advisory rules, known-noise
 * suppressions) is NOT a blocker. The `--blockers` flag composes with
 * `--json` and `--watch`; exit code is non-zero iff at least one blocker
 * remains after filtering.
 */
const BLOCKER_WARNING_CATEGORIES: ReadonlySet<string> = new Set([
  'config-invalid',
  'pack-signature-invalid',
  'plan-signature-divergent',
  'asset-load-failed',
  // Engine-internal mappings: derivedCategory uses `id.split(...)[0]` for
  // unknown prefixes, so canonical inspector finding ids land in these
  // buckets. We allow-list the buckets explicitly so future additions to
  // the inspector don't accidentally creep into "blockers".
  'config',
  'pack-doctor',
]);

function isBlockerCheck(check: { severity: DoctorSeverity; category?: string; id?: string }): boolean {
  if (check.severity === DoctorSeverity.Error) return true;
  if (check.severity !== DoctorSeverity.Warning) return false;
  const cat = (check.category ?? '').trim();
  if (cat && BLOCKER_WARNING_CATEGORIES.has(cat)) return true;
  // Some inspector findings emit the category via the id prefix only.
  const id = (check.id ?? '').trim();
  if (id.startsWith('pack-signature')) return true;
  if (id.startsWith('plan-signature')) return true;
  if (id.startsWith('asset-load')) return true;
  if (id.startsWith('config-invalid')) return true;
  return false;
}

async function runDoctorOnce(args: ParsedArgs): Promise<number> {
  return doctorCommandImpl(args);
}

export const doctorCommand: ICommandHandler = {
  name: 'doctor',
  description:
    'Validate the local SharkCraft setup (config, knowledge, templates, project). `--focus errors|warnings-new|info`, `--hide <category,...>`, `--quiet-known` filter the headline view using `sharkcraft/doctor.suppressions.json`. `--watch`/`--once`/`--debounce` for live mode. `--explain-quality` shows the per-warning "why this matters" line so warnings stop being permanent yellow noise. `--blockers` shows only must-fix findings (errors + warning-category in {config-invalid, pack-signature-invalid, plan-signature-divergent, asset-load-failed}); exit code is non-zero iff a blocker remains. Subcommands: `suppress`, `suppressions list|check`, `watch`.',
  usage:
    'shrk [--cwd <dir>] doctor [--no-config] [--json] [--strict[=errors|warnings|all]] [--blockers] [--show-advisory] [--min-score <0-100>] [--focus errors,warnings-new,info] [--hide action-hint-quality,...] [--quiet-known] [--explain-quality] [--watch [--once] [--debounce N]]',
  async run(args: ParsedArgs): Promise<number> {
    const watchExit = await maybeRunInWatchMode(args, runDoctorOnce);
    if (watchExit !== null) return watchExit;
    return runDoctorOnce(args);
  },
};

async function doctorCommandImpl(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const noCache = flagBool(args, 'no-cache');
    const debug = flagBool(args, 'debug');
    const inspectOpts: { cwd: string; useCache?: boolean; loaderTimeoutMs?: number } = {
      cwd,
      useCache: !noCache,
    };
    const loaderTimeout = flagNumber(args, 'loader-timeout');
    if (typeof loaderTimeout === 'number' && loaderTimeout > 0) {
      inspectOpts.loaderTimeoutMs = loaderTimeout;
    }
    const inspection = await inspectSharkcraft(inspectOpts);
    const result = runDoctor(inspection);
    const report = buildAiReadinessReport(inspection);
    if (debug) {
      process.stderr.write(`[debug] inspection elapsed ${inspection.inspectionElapsedMs}ms cache=${inspection.cacheEnabled ? 'on' : 'off'} loaders=${inspection.loaderDiagnostics.length}\n`);
      for (const d of inspection.loaderDiagnostics) {
        process.stderr.write(
          `[debug] ${d.kind.padEnd(10)} ${d.status.padEnd(12)} ${String(d.elapsedMs).padStart(5)}ms count=${d.count} ${d.deduped ? '(deduped) ' : ''}${d.largeFile ? '(large) ' : ''}${d.filePath}` +
            (d.errorMessage ? ` — ${d.errorMessage}` : '') +
            '\n',
        );
      }
    }

    // `--no-config` mode. When the repo has no sharkcraft/, downgrade
    // the missing-folder warning to info-equivalent (we suppress it from
    // both the visible check list and the strict-failure accounting) and
    // make the exit code lenient. The contract: doctor in --no-config
    // mode never red-fails on "no sharkcraft folder"; it red-fails only
    // on real config errors *if* the folder exists.
    const noConfig = flagBool(args, 'no-config');
    const sharkcraftMissing = !inspection.hasSharkcraftFolder;
    if (noConfig && sharkcraftMissing) {
      // Reuse the existing filter machinery — hide the canonical missing-
      // folder warnings by category. We do not mutate the result; the
      // filter view is used for headline + exit code only.
      // The existing inspector emits these as warnings with `category:
      // "sharkcraft-folder"`; if the implementation changes we still
      // catch them via message regex below.
    }

    const strictMode = resolveStrictMode(args);
    const minScore = flagNumber(args, 'min-score');
    const strictEval = evaluateStrict(strictMode, result.checks, result.summary.errors);
    const minScoreFailed = typeof minScore === 'number' && report.score < minScore;
    // Surface acknowledgement state so doctor exit can fail on expired
    // acknowledgements when the caller opts in.
    const hideAcknowledged = flagBool(args, 'hide-acknowledged');
    const failOnExpiredAcknowledgement = flagBool(args, 'fail-on-expired-acknowledgement');

    const suppressionsCfg = loadDoctorSuppressions(cwd);
    const ackSummary = summarizeAcknowledgements(suppressionsCfg.doctorSuppressions);
    // When --hide-acknowledged is set, only entries with an explicit expiry
    // (true acknowledgements) take effect; bare suppressions stay visible.
    const effectiveSuppressions = hideAcknowledged
      ? ackSummary.acknowledgements
      : suppressionsCfg.doctorSuppressions;
    const filterOpts = buildFilterOptions(args, effectiveSuppressions);
    const blockersOnly = flagBool(args, 'blockers');
    const useFilter =
      (filterOpts.focus && filterOpts.focus.length > 0) ||
      (filterOpts.hide && filterOpts.hide.length > 0) ||
      filterOpts.quietKnown === true ||
      effectiveSuppressions.length > 0;
    const filtered = useFilter ? filterDoctorResult(result, filterOpts) : null;
    let visibleChecks = filtered ? filtered.checks : result.checks;
    // `--blockers` preset: keep only blocker-level findings. Applied
    // AFTER the existing filter pass so acknowledgements / hides compose
    // cleanly (an acknowledged blocker still shows when the user passes
    // --blockers, since acknowledgements pre-filter the result above).
    let blockerCount = 0;
    if (blockersOnly) {
      visibleChecks = visibleChecks
        .map((c) => ({ ...c, category: c.category ?? '' }))
        .filter((c) => isBlockerCheck(c as { severity: DoctorSeverity; category?: string; id?: string }));
      blockerCount = visibleChecks.length;
    }
    // When --no-config is set and the repo has no sharkcraft folder,
    // filter the "no sharkcraft folder" / "config missing" warnings so the
    // user does not see noise. The check ids the inspector emits are
    // stable, but we also fall back on the message text in case a future
    // inspector renames them.
    if (noConfig && sharkcraftMissing) {
      visibleChecks = visibleChecks.filter((c) => {
        const id = c.id ?? '';
        const msg = c.message ?? '';
        const isSharkcraftMissing =
          /^sharkcraft-folder|^config-file|^sharkcraft\.config/i.test(id) ||
          /sharkcraft.*folder|sharkcraft\.config|no sharkcraft/i.test(msg);
        return !isSharkcraftMissing;
      });
    }
    const ackExpired = ackSummary.expired.length > 0 && failOnExpiredAcknowledgement;
    // Under --no-config + missing sharkcraft, treat the run as advisory: do not
    // red-fail on the inspector's "no sharkcraft" errors / warnings.
    const noConfigLenient = noConfig && sharkcraftMissing;
    // When --blockers is set, the exit code reflects ONLY the
    // remaining blocker set. This is the agent-friendly contract: 0 means
    // "nothing must-fix", 1 means "at least one blocker remains".
    const overallExitCode =
      noConfigLenient
        ? 0
        : blockersOnly
          ? blockerCount > 0
            ? 1
            : 0
          : (result.passed && !strictEval.failed && !minScoreFailed && !ackExpired)
            ? 0
            : 1;

    if (flagBool(args, 'json')) {
      // Also compute the folded view for machine consumers so JSON
      // callers see source/state tags + folded counts.
      const jsonFold = foldDoctorChecks(visibleChecks, {
        ack: {
          acknowledgements: ackSummary.acknowledgements,
          expiredAcknowledgements: ackSummary.expired,
        },
        showAdvisory: flagBool(args, 'show-advisory'),
        showAll: strictMode !== 'off',
      });
      // Project shape + surface totals JSON block.
      let shape: ReturnType<typeof detectProjectShape> | null = null;
      let surfaceSummary: Awaited<ReturnType<typeof buildSurfaceSummary>> | null = null;
      try {
        shape = detectProjectShape({
          projectRoot: inspection.projectRoot,
          packageJson: inspection.workspace.raw.packageJson,
        });
        const ctx = await loadSurfaceContext({ cwd: inspection.projectRoot, inspection });
        surfaceSummary = buildSurfaceSummary(ctx.context);
      } catch {
        // ignore
      }
      process.stdout.write(
        asJson({
          targetRoot: inspection.projectRoot,
          ready: result.passed && inspection.knowledgeEntries.length > 0,
          strict: strictMode,
          strictCountedWarnings: strictEval.countedWarnings,
          strictExcludedWarnings: strictEval.excludedWarnings,
          minScore: minScore ?? null,
          strictFailed: strictEval.failed,
          minScoreFailed,
          exitCode: overallExitCode,
          // Blockers preset state. Shape stays stable when --blockers is off.
          blockers: blockersOnly
            ? {
                enabled: true,
                count: blockerCount,
                categories: [...BLOCKER_WARNING_CATEGORIES],
                excludes: ['action-hint-quality', 'advisory-rule', 'known-noise'],
              }
            : { enabled: false },
          // Adaptive surface + project shape.
          shape: shape ? { kind: shape.shape, evidence: shape.evidence } : null,
          surface: surfaceSummary
            ? {
                core: surfaceSummary.totals.core,
                extended: surfaceSummary.totals.extended,
                experimental: surfaceSummary.totals.experimental,
                visibleInHelp: surfaceSummary.totals.visible,
                callable: surfaceSummary.totals.callable,
              }
            : null,
          aiReadiness: report,
          acknowledgements: {
            active: ackSummary.acknowledgements.length,
            expiringSoon: ackSummary.expiringSoon.length,
            expired: ackSummary.expired.length,
            bareSuppressions: ackSummary.bareSuppressions.length,
            failOnExpired: failOnExpiredAcknowledgement,
            hideAcknowledged,
          },
          folded: {
            counts: jsonFold.counts,
            visible: jsonFold.visible.length,
            folded: jsonFold.folded.length,
          },
          tags: jsonFold.tagged.map((t) => ({
            id: t.check.id,
            source: t.source,
            state: t.state,
          })),
          ...result,
          ...(filtered ? { filtered } : {}),
        }) + '\n',
      );
      return overallExitCode;
    }

    process.stdout.write(header('SharkCraft doctor'));
    process.stdout.write(kv('target root', inspection.projectRoot) + '\n');
    process.stdout.write(
      kv('sharkcraft folder', inspection.sharkcraftDir ?? '(missing)') + '\n',
    );
    // Project shape + surface totals one-liner.
    try {
      const detection = detectProjectShape({
        projectRoot: inspection.projectRoot,
        packageJson: inspection.workspace.raw.packageJson,
      });
      process.stdout.write(kv('shape', renderShapeLine(detection).replace(/^Project shape: /, '')) + '\n');
      const { context } = await loadSurfaceContext({ cwd: inspection.projectRoot, inspection });
      const summary = buildSurfaceSummary(context);
      process.stdout.write(
        kv(
          'surface',
          `${summary.totals.core} core + ${summary.totals.extended} extended (${summary.tiers.extended.filter((c) => c.hidden).length} hidden, ${summary.tiers.experimental.filter((c) => c.enabled).length} experimental enabled)`,
        ) + '\n',
      );
    } catch {
      // ignore shape detection errors — doctor must not fail on the audit line.
    }
    if (strictMode !== 'off') {
      process.stdout.write(kv('mode', describeStrictMode(strictMode)) + '\n');
    }
    if (typeof minScore === 'number') {
      process.stdout.write(kv('min readiness', `${minScore}`) + '\n');
    }
    if (blockersOnly) {
      process.stdout.write(
        kv(
          'mode',
          'blockers-only — errors + warnings in {' +
            [...BLOCKER_WARNING_CATEGORIES].join(', ') +
            '}; excludes action-hint-quality, advisory-rule, known-noise',
        ) + '\n',
      );
    }
    process.stdout.write('\n');

    const explainQuality = flagBool(args, 'explain-quality');
    // Fold advisory / acknowledged warnings into a summary line by
    // default. `--show-advisory` (or any `--strict` variant) restores the
    // full inline view.
    const showAdvisory = flagBool(args, 'show-advisory');
    const showAll = strictMode !== 'off';
    const fold = foldDoctorChecks(visibleChecks, {
      ack: {
        acknowledgements: ackSummary.acknowledgements,
        expiredAcknowledgements: ackSummary.expired,
      },
      showAdvisory,
      showAll,
    });
    for (const t of fold.visible) {
      const c = t.check;
      const label = SEVERITY_LABEL[c.severity];
      const stateTag =
        t.state === DoctorState.Blocker
          ? ' [blocker]'
          : t.state === DoctorState.Advisory
            ? ' [advisory]'
            : t.state === DoctorState.Acknowledged
              ? ' [acknowledged]'
              : t.state === DoctorState.ExpiredAcknowledgement
                ? ' [expired-ack]'
                : '';
      const sourceTag = ` [src:${t.source}]`;
      const codeTag = c.code ? ` (${c.code})` : '';
      process.stdout.write(
        `${label} ${c.title}${codeTag}${stateTag}${sourceTag} — ${c.message}\n`,
      );
      if (c.fix && !c.recommendedFix) process.stdout.write(`        fix: ${c.fix}\n`);
      if (c.recommendedFix) process.stdout.write(`        fix: ${c.recommendedFix}\n`);
      if (explainQuality && c.whyThisMatters) {
        process.stdout.write(`        why: ${c.whyThisMatters}\n`);
      }
    }
    if (fold.folded.length > 0) {
      const summary = renderFoldedSummary(fold);
      if (summary) process.stdout.write('\n' + summary);
    }

    process.stdout.write('\n');
    if (filtered) {
      const s = filtered.summary;
      process.stdout.write(
        `Summary: ${s.ok} ok, ${s.info} info, ${s.warnings} active warnings, ${s.errors} errors\n`,
      );
      if (s.suppressedWarnings + s.suppressedInfo + s.suppressedErrors > 0) {
        process.stdout.write(
          `  (${s.suppressedWarnings + s.suppressedInfo + s.suppressedErrors} suppressed: ${s.suppressedWarnings} warning(s), ${s.suppressedInfo} info, ${s.suppressedErrors} error(s))\n`,
        );
      }
      if (filtered.expiredSuppressions.length > 0) {
        process.stdout.write(
          `  ⚠ ${filtered.expiredSuppressions.length} expired suppression(s) — re-evaluate and remove from sharkcraft/doctor.suppressions.json\n`,
        );
      }
    } else {
      process.stdout.write(
        `Summary: ${result.summary.ok} ok, ${result.summary.info} info, ${result.summary.warnings} warnings, ${result.summary.errors} errors\n`,
      );
    }
    void buildSuppressionEntry;
    void doctorSuppressionsFile;
    void saveDoctorSuppressions;
    void existsSync;
    if (strictMode === 'warnings' && strictEval.excludedWarnings > 0) {
      process.stdout.write(
        `  (strict=warnings excluded ${strictEval.excludedWarnings} advisory warning(s); use --strict=all to include)\n`,
      );
    }
    // Surface acknowledgement state. Bare suppressions don't qualify as
    // acknowledgements; expiring/expired ones get a callout so authors don't
    // forget to re-evaluate.
    if (
      ackSummary.acknowledgements.length > 0 ||
      ackSummary.expired.length > 0 ||
      ackSummary.expiringSoon.length > 0
    ) {
      process.stdout.write(
        `Acknowledgements: ${ackSummary.acknowledgements.length} active`,
      );
      if (ackSummary.expiringSoon.length > 0) {
        process.stdout.write(`, ${ackSummary.expiringSoon.length} expiring soon`);
      }
      if (ackSummary.expired.length > 0) {
        process.stdout.write(`, ${ackSummary.expired.length} expired`);
      }
      process.stdout.write('\n');
      if (ackExpired) {
        process.stdout.write(
          `  → --fail-on-expired-acknowledgement set: failing on ${ackSummary.expired.length} expired acknowledgement(s).\n`,
        );
      }
    }

    const hasContent = inspection.knowledgeEntries.length > 0;
    if (noConfigLenient) {
      process.stdout.write(
        '\nVerdict: --no-config mode — repo has no sharkcraft/ yet (advisory). Detection works regardless.\n',
      );
    } else if (result.passed && hasContent) {
      process.stdout.write('\nVerdict: Ready for AI-agent use. ✓\n');
    } else if (result.passed && !hasContent) {
      process.stdout.write(
        '\nVerdict: Setup is valid but empty. Add knowledge to sharkcraft/knowledge.ts.\n',
      );
    } else {
      process.stdout.write('\nVerdict: Not ready yet. Fix the errors above and re-run doctor.\n');
    }
    // First-run UX: when sharkcraft/ is missing entirely, point the
    // user at the zero-config init flow directly.
    if (!inspection.sharkcraftDir) {
      process.stdout.write(
        '\nNothing here yet — try `shrk init --zero-config` to detect your stack and pick a preset.\n',
      );
    }

    process.stdout.write(
      `\nAI-readiness: ${report.score} / 100 (${report.grade})\n`,
    );
    if (report.topRecommendations.length) {
      // Keep the default doctor output short: top 3 recommendations,
      // pass `--verbose` for the full list.
      const verbose = flagBool(args, 'verbose');
      const visible = verbose ? report.topRecommendations : report.topRecommendations.slice(0, 3);
      process.stdout.write(`Top recommendations${verbose ? '' : ` (top ${visible.length})`}:\n`);
      for (const r of visible) process.stdout.write(`  • ${r}\n`);
      if (!verbose && report.topRecommendations.length > visible.length) {
        process.stdout.write(
          `  … (${report.topRecommendations.length - visible.length} more — pass --verbose to see all)\n`,
        );
      }
    }
    if (strictEval.failed) {
      process.stdout.write(
        `\nStrict mode: failing because ${strictEval.countedWarnings} warning(s) + ${result.summary.errors} error(s) exist (${strictEval.reason}).\n`,
      );
    }
    if (minScoreFailed) {
      process.stdout.write(
        `\nMin-score gate: failing because readiness ${report.score} < ${minScore}.\n`,
      );
    }
    // Failure-to-success hints surface only when something is wrong.
    if (overallExitCode !== 0 || result.summary.warnings > 0) {
      process.stdout.write(renderFailureHints(doctorHints()));
    }
    // When there are preview-eligible findings (action-hints,
    // knowledge-stale, template-drift, self-config, pack-conflict,
    // stale-pack-signature), point the user at `shrk fix preview` so a
    // draft patch is one command away. Preview-only; writes only under
    // `.sharkcraft/fixes/`.
    const previewEligible = result.checks.some(
      (c) =>
        (c.severity === 'warning' || c.severity === 'error') &&
        (c.id.startsWith('actionhints-') ||
          c.id.startsWith('action-hint') ||
          c.id.startsWith('knowledge-stale') ||
          c.id.startsWith('template-drift') ||
          c.id.startsWith('self-config') ||
          c.id.startsWith('pack-conflict') ||
          c.id.startsWith('stale-pack-signature')),
    );
    if (previewEligible) {
      process.stdout.write(
        '\nDraft patch available — run `shrk fix preview` for a preview-only patch under `.sharkcraft/fixes/`.\n',
      );
    }
    return overallExitCode;
}

export const doctorSuppressCommand: ICommandHandler = {
  name: 'suppress',
  description:
    'Add a doctor finding to sharkcraft/doctor.suppressions.json. Requires --reason.',
  usage:
    'shrk doctor suppress [--id <stable-id>] [--code <finding-code>] [--category <cat>] --reason "<text>" [--expires-at <YYYY-MM-DD>] [--allow-error]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const reason = flagString(args, 'reason');
    if (!reason) {
      process.stderr.write('Usage: shrk doctor suppress [--id|--code|--category] --reason "<text>"\n');
      return 2;
    }
    const entry = buildSuppressionEntry({
      ...(flagString(args, 'id') ? { id: flagString(args, 'id')! } : {}),
      ...(flagString(args, 'code') ? { code: flagString(args, 'code')! } : {}),
      ...(flagString(args, 'category') ? { category: flagString(args, 'category')! } : {}),
      reason,
      ...(flagString(args, 'expires-at') ? { expiresAt: flagString(args, 'expires-at')! } : {}),
      ...(flagBool(args, 'allow-error') ? { allowError: true } : {}),
    });
    if (!entry.id && !entry.code && !entry.category) {
      process.stderr.write('At least one of --id, --code, --category is required.\n');
      return 2;
    }
    const cfg = loadDoctorSuppressions(cwd);
    const next = {
      schema: cfg.schema,
      doctorSuppressions: [...cfg.doctorSuppressions, entry],
    };
    const written = saveDoctorSuppressions(cwd, next);
    process.stdout.write(`Suppression added → ${written}\n`);
    process.stdout.write(`  ${JSON.stringify(entry)}\n`);
    return 0;
  },
};

async function suppressionsListRun(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const cfg = loadDoctorSuppressions(cwd);
  if (flagBool(args, 'json')) {
    process.stdout.write(asJson(cfg) + '\n');
    return 0;
  }
  if (cfg.doctorSuppressions.length === 0) {
    process.stdout.write('No doctor suppressions configured.\n');
    return 0;
  }
  process.stdout.write(header(`Doctor suppressions (${cfg.doctorSuppressions.length})`));
  for (const s of cfg.doctorSuppressions) {
    const key = s.id ?? s.code ?? s.category ?? '(unknown)';
    const exp = s.expiresAt ? ` [expires ${s.expiresAt}]` : '';
    process.stdout.write(`  • ${key}${exp} — ${s.reason}\n`);
  }
  return 0;
}

async function suppressionsCheckRun(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const inspection = await inspectSharkcraft({ cwd });
  const result = runDoctor(inspection);
  const cfg = loadDoctorSuppressions(cwd);
  const filtered = filterDoctorResult(result, { suppressions: cfg.doctorSuppressions });
  const unused = filtered.appliedSuppressions.filter((a) => a.matched === 0);
  if (flagBool(args, 'json')) {
    process.stdout.write(
      asJson({ filtered, expired: filtered.expiredSuppressions, unused }) + '\n',
    );
    return filtered.expiredSuppressions.length === 0 && unused.length === 0 ? 0 : 1;
  }
  process.stdout.write(header('Doctor suppressions check'));
  if (filtered.expiredSuppressions.length > 0) {
    process.stdout.write(`Expired (${filtered.expiredSuppressions.length}):\n`);
    for (const e of filtered.expiredSuppressions) {
      process.stdout.write(`  • ${e.id ?? e.code ?? e.category ?? '?'} [expired ${e.expiresAt}]\n`);
    }
  }
  if (unused.length > 0) {
    process.stdout.write(`Unused (${unused.length}):\n`);
    for (const u of unused) {
      const e = u.entry;
      process.stdout.write(`  • ${e.id ?? e.code ?? e.category ?? '?'} — ${e.reason}\n`);
    }
  }
  if (filtered.expiredSuppressions.length === 0 && unused.length === 0) {
    process.stdout.write('All suppressions still match.\n');
  }
  return filtered.expiredSuppressions.length === 0 && unused.length === 0 ? 0 : 1;
}

export const doctorSuppressionsCommand: ICommandHandler = {
  name: 'suppressions',
  description:
    'List or check doctor suppressions. `shrk doctor suppressions list` / `... check`.',
  usage: 'shrk doctor suppressions <list|check> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const verb = args.positional[0] ?? 'list';
    const sub: ParsedArgs = { ...args, positional: args.positional.slice(1) };
    if (verb === 'list') return suppressionsListRun(sub);
    if (verb === 'check') return suppressionsCheckRun(sub);
    process.stderr.write('Usage: shrk doctor suppressions <list|check>\n');
    return 2;
  },
};

// ─── Doctor acknowledgements (typed suppressions) ───────────────────

export const doctorAcknowledgeCommand: ICommandHandler = {
  name: 'acknowledge',
  description:
    'Add an acknowledgement for a doctor finding. Requires --reason AND an explicit expiry (--expires-in 7d or --expires-at YYYY-MM-DD). Writes to sharkcraft/doctor.suppressions.json.',
  usage:
    'shrk doctor acknowledge [--id <stable-id>] [--code <code>] [--category <cat>] --reason "<text>" (--expires-in <7d|48h|2w>|--expires-at <ISO>) [--allow-error]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const reason = flagString(args, 'reason');
    const expiresIn = flagString(args, 'expires-in');
    const expiresAt = flagString(args, 'expires-at');
    const id = flagString(args, 'id');
    const code = flagString(args, 'code');
    const category = flagString(args, 'category');
    if (!reason) {
      process.stderr.write(
        'Usage: shrk doctor acknowledge [--id|--code|--category] --reason "<text>" --expires-in 7d\n',
      );
      return 2;
    }
    const result = buildAcknowledgement({
      ...(id ? { id } : {}),
      ...(code ? { code } : {}),
      ...(category ? { category } : {}),
      reason,
      ...(expiresIn ? { expiresIn } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(flagBool(args, 'allow-error') ? { allowError: true } : {}),
    });
    if (!result.ok || !result.entry) {
      process.stderr.write(`Acknowledgement rejected: ${result.error}\n`);
      return 2;
    }
    const cfg = loadDoctorSuppressions(cwd);
    const next = {
      schema: cfg.schema,
      doctorSuppressions: [...cfg.doctorSuppressions, result.entry],
    };
    const written = saveDoctorSuppressions(cwd, next);
    process.stdout.write(`Acknowledgement added → ${written}\n`);
    process.stdout.write(`  ${JSON.stringify(result.entry)}\n`);
    return 0;
  },
};

async function acknowledgementsListRun(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const cfg = loadDoctorSuppressions(cwd);
  const summary = summarizeAcknowledgements(cfg.doctorSuppressions);
  if (flagBool(args, 'json')) {
    process.stdout.write(asJson(summary) + '\n');
    return 0;
  }
  process.stdout.write(renderAcknowledgementsText(summary));
  return 0;
}

async function acknowledgementsCheckRun(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const cfg = loadDoctorSuppressions(cwd);
  const summary = summarizeAcknowledgements(cfg.doctorSuppressions);
  if (flagBool(args, 'json')) {
    process.stdout.write(asJson(summary) + '\n');
    return summary.expired.length === 0 ? 0 : 1;
  }
  process.stdout.write(renderAcknowledgementsText(summary));
  if (summary.expired.length > 0) {
    process.stdout.write(
      `\nExpired acknowledgements need to be re-evaluated or renewed.\n`,
    );
    return 1;
  }
  return 0;
}

export const doctorAcknowledgementsCommand: ICommandHandler = {
  name: 'acknowledgements',
  description:
    'List / check doctor acknowledgements. Same backing file as suppressions but only entries with reason + expiry are surfaced.',
  usage: 'shrk doctor acknowledgements <list|check> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const verb = args.positional[0] ?? 'list';
    const sub: ParsedArgs = { ...args, positional: args.positional.slice(1) };
    if (verb === 'list') return acknowledgementsListRun(sub);
    if (verb === 'check') return acknowledgementsCheckRun(sub);
    process.stderr.write('Usage: shrk doctor acknowledgements <list|check>\n');
    return 2;
  },
};
