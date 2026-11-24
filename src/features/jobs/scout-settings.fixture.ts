import type { HelmraiserScoutSettings } from '@shared/transport/protocol.ts';
export const scoutSettingsFixture = (): HelmraiserScoutSettings => ({ lenses: {
  state: { auto: false, cooldown_hours: 24, source: { auto: 'default', cooldown_hours: 'default' } },
  docs: { auto: true, cooldown_hours: 12, source: { auto: 'ledger', cooldown_hours: 'config' } },
  tests: { auto: false, cooldown_hours: 6, source: { auto: 'config', cooldown_hours: 'ledger' } },
  guardrails: { auto: false, cooldown_hours: 24, source: { auto: 'default', cooldown_hours: 'default' } },
} });
