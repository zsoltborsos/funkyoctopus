import type { ClaudeAuthInfo, ClaudeStatusResult } from '@shared/transport/protocol.ts';

/** Any meter at or past this share of its window is something to watch. */
export const NEAR_LIMIT_PERCENT = 80;

export interface ClaudeChip {
  label: string;
  tooltip: string;
  /** `attention` keeps its one meaning; `quiet` is a dim note with nothing to open. */
  tone: 'normal' | 'attention' | 'quiet';
  interactive: boolean;
}

/** `max` -> `Max`; the plan as the CLI names it, capitalised for display. */
function planName(subscriptionType: string | undefined): string {
  if (!subscriptionType) return '';
  return subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1);
}

/** Cloud providers by the `apiProvider` Claude Code reports; another one shows as reported. */
const PROVIDERS: Record<string, string> = {
  bedrock: 'Amazon Bedrock',
  vertex: 'Google Vertex AI',
  foundry: 'Microsoft Foundry',
};

/**
 * How Claude is signed in, for display: `subscription (Max)`, `API key`,
 * `auth token`, or the cloud provider, from what `claude auth status`
 * reports (measured: `authMethod` is `claude.ai`, `api_key`, `oauth_token` or
 * `third_party`). Null when logged out.
 */
export function signInMethod(auth: ClaudeAuthInfo): string | null {
  if (!auth.loggedIn) return null;
  if (auth.apiProvider !== undefined && auth.apiProvider !== 'firstParty') {
    return PROVIDERS[auth.apiProvider] ?? auth.apiProvider;
  }
  const plan = planName(auth.subscriptionType);
  if (plan) return `subscription (${plan})`;
  switch (auth.authMethod) {
    case 'claude.ai':
      return 'subscription';
    case 'api_key':
      return 'API key';
    case 'oauth_token':
      return 'auth token';
    default:
      return auth.authMethod ?? null;
  }
}

/**
 * The status-bar chip for one `claude.status` answer: plan plus the 5h and
 * weekly shares while all is well on a subscription, the sign-in itself for
 * one billed per use (an API key, a token, a cloud provider), attention when it
 * needs the owner (logged out, usage refused, CLI failing, any meter near its
 * limit), and a quiet dim note when `claude` is not installed.
 */
export function claudeChip(status: ClaudeStatusResult): ClaudeChip {
  if (status.cli === 'missing') {
    return { label: 'claude not found', tooltip: status.error ?? '', tone: 'quiet', interactive: false };
  }
  if (status.cli === 'error') {
    return { label: 'Claude · unavailable', tooltip: status.error ?? '', tone: 'attention', interactive: true };
  }
  if (status.auth && !status.auth.loggedIn) {
    return { label: 'Claude · logged out', tooltip: status.error ?? '', tone: 'attention', interactive: true };
  }
  const plan = planName(status.auth?.subscriptionType);
  const method = status.auth ? signInMethod(status.auth) : null;
  if (!plan && method !== null && status.auth?.authMethod !== 'claude.ai') {
    return {
      label: `Claude · ${method}`,
      tooltip: `Claude via ${method}: billed per use, no subscription quota`,
      tone: 'normal',
      interactive: true,
    };
  }
  const name = plan ? `Claude ${plan}` : 'Claude';
  const usage = status.usage;
  if (usage && 'error' in usage) {
    return { label: `${name} · usage unavailable`, tooltip: usage.error, tone: 'attention', interactive: true };
  }
  const limits = usage?.limits ?? [];
  const session = limits.find((limit) => limit.kind === 'session');
  const weekly = limits.find((limit) => limit.kind === 'weekly_all');
  const parts = [
    name,
    ...(session ? [`5h ${Math.round(session.percent)}%`] : []),
    ...(weekly ? [`wk ${Math.round(weekly.percent)}%`] : []),
  ];
  const near = limits.some((limit) => limit.percent >= NEAR_LIMIT_PERCENT);
  return {
    label: parts.join(' · '),
    tooltip: plan ? `Claude on your subscription (${plan}): quota and sessions` : 'Claude subscription quota and sessions',
    tone: near ? 'attention' : 'normal',
    interactive: true,
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** When a window resets: `in 1h 30m` within a day, the local weekday and time beyond. */
export function formatReset(resetsAt: number, now: number): string {
  const diff = resetsAt - now;
  if (diff <= 0) return 'now';
  if (diff < HOUR) return `in ${Math.max(1, Math.round(diff / MINUTE))}m`;
  if (diff < DAY) return `in ${Math.floor(diff / HOUR)}h ${Math.round((diff % HOUR) / MINUTE)}m`;
  return new Date(resetsAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/** How long ago something happened, coarsely: `just now`, `2m ago`, `3h ago`, `4d ago`. */
export function formatAgo(at: number, now: number): string {
  const diff = Math.max(0, now - at);
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  return `${Math.floor(diff / DAY)}d ago`;
}

/** The last path segment, for a compact project label. */
export function folderName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}
