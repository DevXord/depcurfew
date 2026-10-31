import type { Policy } from './schema.ts';

export const POLICY_FILE = 'depcurfew.json';

/** Where the published package serves schema.json; init writes it into `$schema`. */
export const SCHEMA_URL = 'https://unpkg.com/depcurfew/schema.json';

/** What `depcurfew init` writes. Every section is explicit, so the file shows what can be configured. */
export const DEFAULT_POLICY = {
  $schema: SCHEMA_URL,
  version: 1,
  cooldown: { minimum: '3d', exclude: [], securityUpdates: 'bypass' },
  installScripts: { default: 'deny', allow: [], deny: [] },
  sources: { git: 'deny', remoteTarball: 'deny', file: 'allow', directory: 'allow' },
  targets: 'auto',
} as const satisfies Policy;

export function renderPolicy(policy: Policy): string {
  return `${JSON.stringify(policy, null, 2)}\n`;
}
