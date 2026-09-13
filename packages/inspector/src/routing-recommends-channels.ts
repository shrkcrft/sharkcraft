/**
 * THE routing-hint `recommends` channel table: every channel a hint may name,
 * and the registry its ids resolve in.
 *
 * One table read by the load lint (an unknown channel key — `pipeline` for
 * `pipelines` — is reported at load), the self-config doctor (every id probed
 * through THE id resolver) and `prepareAgentTask` (the resolved non-command
 * assets it hands the agent). `Record<keyof ITaskRoutingRecommends, …>` makes a
 * channel added to the public shape without a row here a compile error, so a
 * channel can never again load, validate, and reach nothing.
 */
import type { ITaskRoutingRecommends } from '@shrkcrft/plugin-api';
import type { ReferenceKind } from './reference-registry.ts';

export const ROUTING_RECOMMENDS_CHANNELS: Readonly<
  Record<
    keyof ITaskRoutingRecommends,
    {
      /** The registry the channel's ids resolve in; `command` goes through the injected command resolver. */
      readonly kind: ReferenceKind | 'command';
      /** Singular noun for finding codes and messages (`routing-hint-<label>-missing`). */
      readonly label: string;
    }
  >
> = Object.freeze({
  commands: { kind: 'command', label: 'command' },
  templates: { kind: 'template', label: 'template' },
  playbooks: { kind: 'playbook', label: 'playbook' },
  helpers: { kind: 'helper', label: 'helper' },
  profiles: { kind: 'migration-profile', label: 'profile' },
  conventions: { kind: 'convention', label: 'convention' },
  knowledge: { kind: 'knowledge', label: 'knowledge' },
  policies: { kind: 'policy', label: 'policy' },
  pipelines: { kind: 'pipeline', label: 'pipeline' },
  rules: { kind: 'rule', label: 'rule' },
  paths: { kind: 'path-convention', label: 'path' },
});

/** Every channel key, in table order. */
export const ROUTING_RECOMMENDS_CHANNEL_KEYS: readonly (keyof ITaskRoutingRecommends)[] = Object.freeze(
  Object.keys(ROUTING_RECOMMENDS_CHANNELS) as (keyof ITaskRoutingRecommends)[],
);

/** True when `key` is a channel of the table. */
export function isRoutingRecommendsChannel(key: string): key is keyof ITaskRoutingRecommends {
  return Object.prototype.hasOwnProperty.call(ROUTING_RECOMMENDS_CHANNELS, key);
}
