import type { IVerdictCoverage } from '@shrkcrft/core';
import { ExitCode } from '../exit-codes.ts';
import { buildGateEnvelope, type IGateEnvelope, type IGateRuleResult } from './gate-envelope.ts';
import type { IRegistrationQuerySettleInput } from './i-registration-query-settle-input.ts';
import { verdictLine } from './verdict-line.ts';

/**
 * Settle a registration-graph absence query (`wiring unprovided` / `wiring
 * orphans`) against what the graph read AND what every idiom's roles examined.
 *
 * The coverage comes from ONE place, @shrkcrft/boundaries
 * `registrationUnprovidedVerdict` / `registrationOrphansVerdict`: the idiom
 * files the reader could not read (over the read cap), named; every absence
 * such a file could refute, demoted from a finding to `unproven`; and — round
 * 13 (P4) — every idiom's ROLE record from THE role authority
 * (`measureRegistrationRoles`), so a declared role that matched no file is a
 * shortfall here exactly as on `gates check`. finish's unprovided sub-gate and
 * MCP `get_wiring_graph` read the same records, so the verb and its siblings
 * cannot disagree.
 *
 * The settle runs through the shared gate envelope (one row per record, the
 * query's own row carrying its findings): a proposed 0 over a shortfall is NOT
 * VERIFIED (2), a 1 keeps its exit and gains the `(also not verified: …)`
 * line, an expectEmpty acceptance is printed at 0, and a fully-examined graph
 * settles exactly as proposed, with the clean line. `--json` ALWAYS carries
 * `gate`, `coverage`, `exitCode`, `verdict`, `shortfalls` and `accepted` — it
 * carried them only when a file was unread, so a dead declared role printed
 * `{"total":0,"unprovided":[]}` at exit 0 with nothing to say it proved nothing.
 */
export function settleRegistrationGraph<T extends { readonly token: string }>(
  input: IRegistrationQuerySettleInput<T>,
): {
  readonly exit: number;
  readonly line: string;
  readonly json: Readonly<Record<string, unknown>>;
  readonly gate: IGateEnvelope;
} {
  const { verdict } = input;
  const own = verdict.coverage.find((c) => c.subject === input.subject);
  const all: IVerdictCoverage = { unit: 'registration idioms', expected: input.idioms, examined: input.idioms };
  const fails = input.proposed === ExitCode.Failure;
  const rows: IGateRuleResult[] = [
    ...verdict.coverage
      .filter((c) => c !== own)
      .map(
        (c): IGateRuleResult => ({
          id: `${c.subject ?? 'registration graph'}${c.acceptedBy !== undefined ? ' (expectEmpty)' : ''}`,
          type: 'registration',
          status: 'passed',
          severity: 'warning',
          counts: {},
          violations: [],
          coverage: c,
        }),
      ),
    {
      id: input.subject,
      type: 'registration',
      status: fails ? 'failed' : 'passed',
      severity: fails ? 'error' : 'warning',
      counts: { findings: verdict.findings.length, unproven: verdict.unproven.length },
      violations: fails ? verdict.findings.map((t) => ({ id: t.token })) : [],
      coverage: own ?? all,
    },
  ];
  const gate = buildGateEnvelope(input.verb, input.proposed, rows, all);
  return {
    exit: gate.exit,
    line: verdictLine(gate, input.clean),
    json: {
      coverage: verdict.coverage,
      ...(verdict.unread.length > 0 ? { unread: verdict.unread } : {}),
      ...(verdict.unproven.length > 0 ? { unproven: verdict.unproven } : {}),
      exitCode: gate.exit,
      verdict: gate.verdict,
      shortfalls: gate.shortfalls,
      accepted: gate.accepted,
      gate,
    },
    gate,
  };
}
