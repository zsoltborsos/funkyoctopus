/**
 * Variables that must never reach a `claude` child: the markers a parent Claude
 * Code session exports (the sidecar may itself be started from one), which
 * would make the child believe it is nested inside that session — reporting to
 * its messaging socket, sharing its session id, taking its effort level. No
 * sign-in setting is here: an API key, token, gateway or cloud provider the
 * owner set reaches the child as set, and the CLI decides which one it uses
 * (CURRENT_STATE decision 12, limit 1).
 */
const STRIPPED = new Set([
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ATTENDED',
]);

/**
 * The environment for every `claude` spawn and every Agent SDK call: the
 * sidecar's own minus the stripped names, identified as FunkyOctopus. Never
 * mutates its input and drops unset variables, so the result is a plain
 * `Record<string, string>` the SDK accepts.
 */
export function claudeChildEnv(env: NodeJS.ProcessEnv, version: string): Record<string, string> {
  const child: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !STRIPPED.has(name)) child[name] = value;
  }
  child.CLAUDE_AGENT_SDK_CLIENT_APP = `funkyoctopus/${version}`;
  return child;
}
