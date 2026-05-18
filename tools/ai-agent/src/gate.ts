import { ALLOWED_ACTORS } from './config/allowed-actors.ts';
import { MAINTAINERS } from './config/maintainers.ts';
import { LABELS } from './config/labels.ts';

export interface IIssueEventLabel {
  name: string;
}

export interface IIssueEventIssue {
  number: number;
  title: string;
  body: string | null;
  user: { login: string };
  labels?: IIssueEventLabel[];
}

export interface IIssueEvent {
  action: string;
  issue: IIssueEventIssue;
  label?: IIssueEventLabel;
  sender?: { login: string };
}

export type GateDecisionKind = 'plan' | 'implement' | 'ignore';

export interface IGateDecision {
  kind: GateDecisionKind;
  reason: string;
}

const AI_TITLE_PREFIX = '[AI]';

export function gate(event: IIssueEvent): IGateDecision {
  if (event.action === 'opened') {
    const author = event.issue.user.login;
    const isAllowed = ALLOWED_ACTORS.includes(author);
    const hasPrefix = event.issue.title.startsWith(AI_TITLE_PREFIX);
    if (isAllowed && hasPrefix) {
      return {
        kind: 'plan',
        reason: `opened by allowed actor ${author} with ${AI_TITLE_PREFIX} prefix`,
      };
    }
    if (!isAllowed) {
      return { kind: 'ignore', reason: `opened by non-allowed actor ${author}` };
    }
    return { kind: 'ignore', reason: `opened by ${author} without ${AI_TITLE_PREFIX} prefix` };
  }

  if (event.action === 'labeled') {
    const labelName = event.label?.name;
    const senderLogin = event.sender?.login;
    if (!labelName) {
      return { kind: 'ignore', reason: 'labeled event missing label payload' };
    }
    if (!senderLogin) {
      return { kind: 'ignore', reason: 'labeled event missing sender' };
    }
    if (labelName !== LABELS.plan && labelName !== LABELS.implement) {
      return { kind: 'ignore', reason: `unrelated label "${labelName}"` };
    }
    if (!MAINTAINERS.includes(senderLogin)) {
      return {
        kind: 'ignore',
        reason: `label "${labelName}" applied by non-maintainer ${senderLogin}`,
      };
    }
    if (labelName === LABELS.plan) {
      return { kind: 'plan', reason: `maintainer ${senderLogin} applied "${labelName}"` };
    }
    return { kind: 'implement', reason: `maintainer ${senderLogin} applied "${labelName}"` };
  }

  return { kind: 'ignore', reason: `unhandled action "${event.action}"` };
}
