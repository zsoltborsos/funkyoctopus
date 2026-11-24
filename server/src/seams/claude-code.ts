import type { MethodRegistry } from '../transport/registry.ts';
import type { ClaudeCodeStatus } from '../claude-code/status.ts';
import { isRecord } from '../util/records.ts';

function parseRefreshUsage(params: unknown): boolean {
  if (params === undefined) return false;
  if (isRecord(params)) {
    const flag = params.refreshUsage;
    if (flag === undefined) return false;
    if (typeof flag === 'boolean') return flag;
  }
  throw new Error('claude.status takes { refreshUsage?: boolean }');
}

function parseRoot(params: unknown): string | null {
  if (isRecord(params)) {
    const root = params.root;
    if (root === null || (typeof root === 'string' && root !== '')) return root;
  }
  throw new Error('claude.sessions requires { root: string | null }');
}

/**
 * Registers the read-only Claude Code awareness seam: `claude.status` for the
 * status chip and popover (sign-in, quota, running sessions) and
 * `claude.sessions` for a project's recent sessions. Neither starts a model
 * turn, logs in or reads a credential file.
 */
export function registerClaudeCodeSeam(registry: MethodRegistry, claude: ClaudeCodeStatus): void {
  registry.call('claude.status', (params) => claude.status(parseRefreshUsage(params)));
  registry.call('claude.sessions', (params) => claude.recent(parseRoot(params)));
}
