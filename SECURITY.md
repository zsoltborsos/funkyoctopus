# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability in FunkyOctopus, please report it
**privately** rather than opening a public issue.

**Contact:** Open a private security advisory on this repository's **Security**
tab on GitHub ("Report a vulnerability").

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

You will receive a response within **7 days**. If the issue is confirmed, a fix
will be released as soon as possible and you will be credited in the release
notes (unless you prefer to remain anonymous).

## What FunkyOctopus Can Reach

FunkyOctopus is a single-user, local tool with **no login**. Whoever can reach
its sidecar can drive your agents with your files and your sign-ins, so the
points below are where its security lives.

- **Ports.** The sidecar binds `127.0.0.1`: port 14787 for the installed
  service, 14788 for development, with Vite on 14174. Never bind it to another
  address or put it behind a proxy; use an SSH tunnel to loopback instead.
- **The WebSocket guard.** A browser may connect only from an allowed Origin
  (`http://localhost:14174` and `http://127.0.0.1:14174` by default); `Origin:
  null` and foreign Origins are refused. A connection with no Origin header is
  allowed; that is how the `fo` CLI connects. As a result, **any process
  running as you on the machine can drive the sidecar**.
- **Agents run without prompts.** Claude Code tabs run the `claude` binary
  through the Claude Agent SDK in `bypassPermissions` mode; pi tabs run the
  embedded pi runtime. Both can read and write files and run commands as you.
- **The Vault is a tripwire, not a sandbox.** Rules in
  `~/.funkyoctopus/vault.json` (by default, block `~/.ssh`) are checked on
  agent tool calls and on Helmraiser actions; `escalate` rules wait for your
  approval in the browser. A determined agent can get around path rules (for
  example through a script), so do not rely on the Vault to contain one.
- **Programs it starts.** `claude` (or `CLAUDE_BIN`), the global `pi` CLI (for
  a daily `pi update --all`), `lb`, `helmraiser` (or `HELMRAISER_BIN`) and
  `notify-send`, all found on your `PATH`.
- **What it reads.** pi's session files and sign-ins under `~/.pi/agent`,
  Claude Code's transcripts through the SDK, Leeboard only through the `lb`
  CLI (FO writes no entries), and Helmraiser run plans and reviews under
  `~/.helmraiser` (or `HELMRAISER_DATA_DIR`), besides the `helmraiser --json`
  CLI.
- **What it writes.** `~/.funkyoctopus/` (the Vault and `config.env`), its
  state under `~/.local/state/funkyoctopus/`, and, with `npm run
  service:install`, a deployed copy under `~/.local/share/funkyoctopus/app`
  plus a systemd user unit. Chat transcripts stay in each engine's own store.

## Scope

This policy covers FunkyOctopus: the browser app, the sidecar and its
WebSocket methods, the Vault and approvals, the `fo` CLI, and the service and
setup scripts. It does **not** cover pi, Claude Code, Leeboard or Helmraiser
themselves, or the model providers. Report vulnerabilities in those tools to
their maintainers.

## Disclosure Policy

We follow [responsible disclosure](https://en.wikipedia.org/wiki/Responsible_disclosure):
coordinated public disclosure after a fix is available, typically within 90
days of the initial report.
