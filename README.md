<picture><source media="(prefers-color-scheme: dark)" srcset="docs/brand/funkyoctopus-lockup-dark.svg"><img src="docs/brand/funkyoctopus-lockup.svg" alt="FunkyOctopus" height="64"></picture>

Your agents and tools, all within a tentacle's reach.

FunkyOctopus is one of the tools from [ZB Code Shipyard](https://zsoltborsos.net).

## Read this first

- **Single user.** One person, one machine. There is no account system.
- **Local only.** The sidecar binds `127.0.0.1` and has **no login and no
  security layer**. Anyone who can reach it can drive your agents, with your
  files and your sign-ins. Never expose it to a network: no port forwarding,
  no reverse proxy, no `SIDECAR_HOST=0.0.0.0`. To reach it from another
  machine, use an SSH tunnel to the loopback address.
- **Linux only.** It is built and tested on Linux. macOS and Windows are not
  supported yet.
- **Shared as-is.** No warranty, no support promise, no stability promise.

## What it is

FunkyOctopus is a browser cockpit that ties your coding agents and their tools
together on your own machine. Leeboard gives agents shared rules, holds and
handoffs, and Helmraiser runs delegated coding tasks under review gates. Both
work on their own from the command line. FunkyOctopus adds the view from
above: a Leeboard side panel that shows what your agents are reading and
writing, a Helmraiser dashboard with runs, outcomes, costs and scouting, and
chat tabs that drive Claude Code or, through pi, models from OpenAI, OpenCode
and others. Keep it open beside your main agent to see what's happening under
the hood, or make it your main driver. It is single-user and local-only (no
login, not for network exposure), runs on Linux, and is shared as-is.

## Features

- **Chat tabs.** Several tabs at once (default cap 8), each running one engine
  for its life: **pi** (the embedded pi agent runtime, any provider and model
  pi knows) or **Claude** (see [Claude](#claude)). Streaming turns with
  thinking, tool calls, diffs and markdown; per-message model and effort
  pickers; image paste; Enter while a turn runs queues the next message; Esc
  stops. Tabs are shared by every browser window and by the `fo` CLI.
- **Chat search.** Ctrl+K switches views and tabs and, from three letters,
  searches your stored chats from both engines.
- **Prompt library.** Saved prompt templates that load into the composer
  (kept in your browser's local storage).
- **Leeboard panel.** A side panel on the chat view: the inbox of requests and
  handoffs for this tab and project, every active hold across projects, and
  the review digest. Read-only: FunkyOctopus writes nothing to Leeboard.
- **Helmraiser view and dashboard.** A queue of running, awaiting-approval,
  queued and failed runs with approve, reject, rework, retry and abort, and
  scouting per project; and a dashboard (24h, 7d, 30d) of health, provider
  usage, models, quality, cost and time, failures and the scout funnel.
  Optional browser and desktop (`notify-send`) notifications when a run needs
  you.
- **Vault.** An optional path tripwire for agent tool calls, not a sandbox.
  By default it blocks access to `~/.ssh`. Rules live in
  `~/.funkyoctopus/vault.json` (a JSON array of `{ "target", "action" }`
  with `action` either `"block"` or `"escalate"`). Tools run without approval
  prompts unless you add an `escalate` rule, which asks you in the chat.
- **Update detection.** Status-bar chips tell you when the embedded pi SDK or
  the Claude Agent SDK has drifted from its latest stable release. Detection
  only reads; promoting a new version is an explicit terminal step
  (`npm run promote:pi`, `npm run promote:claude-sdk`).
- **`fo` command-line client.** The same sidecar from a shell; see
  [The `fo` client](#the-fo-client).

Leeboard and Helmraiser are optional. Without them the panel and the view show
"not installed" and everything else works.

## Claude

FunkyOctopus drives your own, installed, unmodified Claude Code through the
Claude Agent SDK. It uses whatever sign-in your Claude Code already has: a
claude.ai subscription, your own API key, an auth token, or a cloud provider
(Amazon Bedrock, Google Vertex AI, Microsoft Foundry). The status chip shows
which one is in use. Usage is billed to you under your own agreement with
Anthropic.

- You sign in in your own terminal: run `claude`, then `/login`.
  FunkyOctopus never reads, stores or relays credentials or session tokens.
- Claude turns are human-driven only. FunkyOctopus never starts, schedules or
  retries a Claude turn on its own, and runs the engine with cron and
  background tasks off. Nothing scripted or unattended, including Helmraiser
  workers, runs on it.
- The SDK dependency is not covered by this repository's MIT licence. It is
  governed by Anthropic's Commercial Terms. Check Anthropic's terms for your
  own use: <https://code.claude.com/docs/en/legal-and-compliance>.
- The SDK's bundled binary is replaced by a stub (`stubs/no-claude-binary`),
  so only the `claude` on your `PATH` (or `CLAUDE_BIN`) is ever run.

FunkyOctopus is an independent project and is not endorsed by or affiliated
with Anthropic.

## Prerequisites

- Linux, and **Node 26 or newer** (`engines` in `package.json`).
- `git` and `npm`.
- **pi** is embedded as an npm dependency, so there is nothing separate to
  install for chat. For pi tabs you need a model provider that pi can use.
  Provider sign-ins live in pi's own configuration directory, `~/.pi/agent`
  (`auth.json`, `models.json`), or in the provider's usual environment
  variables. The simplest route is to install the pi CLI
  (`npm install -g --ignore-scripts @earendil-works/pi-coding-agent`), run
  `pi` and use `/login`; FunkyOctopus then sees the same credentials. Set the
  default model in pi, or with `FUNKYOCTOPUS_PROVIDER` and `FUNKYOCTOPUS_MODEL`.
- Optional: **Claude Code** (`claude`) for Claude tabs; **Leeboard** (`lb`) for
  the Leeboard panel and its project list; **Helmraiser** (`helmraiser`) for
  the Helmraiser view; `notify-send` for desktop notifications.
- For the always-on service only: a **systemd user session** (`systemctl
  --user`). Without the pi CLI on your `PATH` the service runs, but skips
  its daily `pi update --all`.

## Install and run

```bash
git clone https://github.com/zsoltborsos/funkyoctopus.git funkyoctopus
cd funkyoctopus
scripts/setup.sh        # checks Node, runs npm ci, creates ~/.funkyoctopus/config.env, reports optional tools
```

`scripts/setup.sh` is small and re-runnable. It uses no `sudo`, installs
nothing globally and makes no network call beyond `npm ci`. It never
overwrites an existing `config.env`. `--skip-install` skips `npm ci`. If you
would rather do it by hand, `npm ci` is the only required step.

**Development** (Vite with hot reload, and a sidecar that restarts on edits):

```bash
npm run dev:all         # open http://localhost:14174; the sidecar is on 14788
```

Vite is pinned to port 14174 with `strictPort`, and the sidecar accepts only
the Origins `http://localhost:14174` and `http://127.0.0.1:14174` by default.
If 14174 is taken, run `npx vite --port 5199 --strictPort` and start the
sidecar with `SIDECAR_PORT=14788
FUNKYOCTOPUS_WS_ORIGINS=http://localhost:5199,http://127.0.0.1:5199`. Do not
widen the allow-list to a wildcard.

**Always-on service** (a systemd user service on `http://127.0.0.1:14787`):

```bash
npm run service:install        # once; deploys your local master
npm run service:install -- <ref>  # or another branch or commit
npm run deploy                 # later: publish the current master
npm run deploy -- <ref>        # or a specific commit; also the rollback
journalctl --user -u funkyoctopus -f
npm run service:uninstall      # add -- --remove-copy to delete the deployed copy too
```

`service:install` checks Node 26+, `git` and a reachable `systemctl --user`
(a missing `pi`, `helmraiser` or `lb` is only a warning). It creates a
detached git worktree of your local `master`, or of the ref you pass, at
`~/.local/share/funkyoctopus/app`, runs `npm ci` and `npm run build` there,
writes `~/.config/systemd/user/funkyoctopus.service` and enables and starts
it. The service runs that copy, not your working tree, so development keeps
running separately on 14174 and 14788. `npm run deploy` checks out a ref (default
`master`) in the deployed copy, reinstalls if the lockfile changed, rebuilds
and restarts the service; it needs `service:install` to have been run first
and refuses if the deployed copy has local changes. `--deploy-dir <absolute
path>` or `FUNKYOCTOPUS_DEPLOY_DIR` picks another location. The unit records
the `PATH` and Node of the shell that installed or deployed it, so the service
inherits that toolchain. As a user service it runs while your user session does.

## Configuration

The sidecar reads an optional settings file at startup:
`~/.funkyoctopus/config.env`, or the file named by `FUNKYOCTOPUS_CONFIG`
(which works from the real environment only). The format is one `KEY=VALUE`
per line, `#` comments, optional quotes. **A variable already set in the real
environment wins over the file.** A missing file is fine; a file that exists
but cannot be read stops the sidecar. Paths are used literally (no `~`
expansion), so give absolute paths. `scripts/setup.sh` writes a fully
commented template, and [`.env.example`](.env.example) is the same reference
in source form. Changes need a sidecar restart.

The service sets `SIDECAR_HOST`, `SIDECAR_PORT` and `FUNKYOCTOPUS_SERVE_UI` in
its unit, so those three cannot be changed from `config.env` for the service.

| Setting | Default | What it does |
| --- | --- | --- |
| `SIDECAR_HOST` | `127.0.0.1` | Interface the sidecar listens on. Leave it on loopback. |
| `SIDECAR_PORT` | `14787` (`14788` under `npm run dev:server`) | Sidecar port. |
| `FUNKYOCTOPUS_CHAT_ENGINE` | `pi` | Engine for the permanent `main` chat tab: `pi` or `claude-code`. Any other value stops the sidecar. |
| `FUNKYOCTOPUS_PROVIDER` | pi's own `defaultProvider` | Provider pi drives. Must exist in `~/.pi/agent/models-store.json`. With neither provider nor model set here or in pi, pi chats do not start and the UI says so. |
| `FUNKYOCTOPUS_MODEL` | pi's own `defaultModel` | Model pi drives. |
| `FUNKYOCTOPUS_WORKSPACE_ROOT` | `~/Work` | Starting folder for the Global space until you pick a project. |
| `FUNKYOCTOPUS_PROJECT_ROOTS` | `~/projects` | Comma-separated folders scanned one level deep for the folder list. |
| `FUNKYOCTOPUS_VAULT_PATH` | `~/.funkyoctopus/vault.json` | Vault rules file; created with the default `~/.ssh` block rule if absent. |
| `HELMRAISER_BIN` | `helmraiser` | Helmraiser CLI the sidecar runs. |
| `HELMRAISER_DATA_DIR` | `~/.helmraiser` | Helmraiser's run store, read for plans and reviews. |
| `CLAUDE_BIN` | `claude` | Claude Code CLI to run. |
| `FUNKYOCTOPUS_CLAUDE_IDLE_MS` | `900000` (15 min) | Idle time before a Claude tab's process is closed; the next send resumes it. |
| `FUNKYOCTOPUS_MAX_CHATS` | `8` | Most chat tabs at once, `main` included. |
| `FUNKYOCTOPUS_MAX_CLAUDE_RUNNING` | `4` | Most Claude processes running at once across tabs. |
| `FUNKYOCTOPUS_DESKTOP_NOTIFY` | off | `1` sends desktop notifications through `notify-send`. |
| `FUNKYOCTOPUS_SERVE_UI` | unset (no UI served) | `1` serves the repository's built `dist/` from the sidecar; or give a dist directory. |
| `FUNKYOCTOPUS_WS_ORIGINS` | the two Vite dev origins on 14174 | Comma-separated exact browser Origins allowed on the WebSocket; no wildcards. Empty keeps the default. A sidecar serving the UI also allows its own port. |
| `FUNKYOCTOPUS_UPKEEP_DISABLED` | `0` | `1` turns off the automatic `pi update --all` after start and every 24 hours. |
| `FUNKYOCTOPUS_UPKEEP_INTERVAL_MS` | `86400000` | Interval for that automatic update. |
| `FUNKYOCTOPUS_CONFIG` | `~/.funkyoctopus/config.env` | Path of the settings file itself (real environment only). |
| `VITE_SIDECAR_URL` | `ws://127.0.0.1:14788/ws` in dev | Browser-to-sidecar WebSocket URL, read by Vite at build or dev time from the environment or a repository-root `.env`, not from `config.env`. |

The `fo` client reads `FO_URL` and `SIDECAR_PORT` from the real environment
only.

Where state lives, outside the checkout: settings and Vault rules in
`~/.funkyoctopus/`; pi's models, credentials and chat sessions under
`~/.pi/agent/`; Helmraiser and Leeboard keep their own stores; UI preferences
and prompt templates in your browser's local storage; open-tab state and
update-check records under `${XDG_STATE_HOME:-~/.local/state}/funkyoctopus`.

## The `fo` client

A shell client over the same WebSocket the browser uses. Link it onto your
`PATH`:

```bash
ln -s "$PWD/bin/fo" ~/.local/bin/fo   # then: fo --help
```

Commands: `fo health`, `fo call <method> [params-json]`, `fo projects`,
`fo chats [--root <path>|--global]`, `fo chats --live`,
`fo chat current|new|open <session-path>|root <path|global>`,
`fo chat create --engine <pi|claude-code> [--root <dir>]`,
`fo chat close <id> [--force]`, `fo send <text...> [--model <provider/id>]
[--effort <level>] [--thinking]`, `fo models`, `fo helmraiser`, and
`fo vault approve|deny <requestId>`. Every command takes `--json` (NDJSON for
`send`). Exit codes: 0 ok, 1 wire error, 2 usage, 3 sidecar unreachable,
124 timeout, 130 interrupted. The URL comes from `FO_URL`, default
`ws://127.0.0.1:${SIDECAR_PORT:-14787}/ws`.

Chat commands and `send` act on one shared chat slot (a browser tab), chosen
with `--chat <id>`; the default is `main`, not the browser's active tab.
Sending into a Claude tab needs an explicit `--chat` and an interactive
terminal on stdin, because Claude turns are human-driven.

## Chat transcripts are written to disk

pi tab conversations are pi's own session files, so they survive a reload, can
be listed per project and reopened, and are the same files pi's own terminal
UI uses. **They are written unencrypted to
`~/.pi/agent/sessions/<encoded-cwd>/` and contain whatever the agent read,
including material the Vault is meant to guard.** Claude tabs use Claude
Code's own session store; FunkyOctopus reads those transcripts and never
writes them.

## Architecture

A browser tab cannot embed pi, spawn the `lb` CLI or reach Helmraiser, so the
app is two processes:

```
 browser (Vite + React 19)                  Node sidecar (Fastify + WS)
 ─────────────────────────                  ───────────────────────────
 chat tabs, history ───────┐                pi + Claude sessions, Vault
 Leeboard panel ───────────┤ one WebSocket  Leeboard reads ─────▶ lb CLI
 Helmraiser view ──────────┼◀─────────────▶ Helmraiser CLI ─────▶ helmraiser
 projects, settings, status┘ calls+streams
```

Everything crosses one wire contract (`src/shared/transport/protocol.ts`):
request/response calls and server-to-client streams, correlated by id. The
browser never sees a concrete server class; the method name is the only
coupling. FunkyOctopus is a thin consumer: it drives pi, Claude Code, Leeboard
and Helmraiser through seams and owns none of their logic. It stores no memory
of its own and injects nothing from Leeboard into a session; agents run
`lb brief` themselves.

```
src/                 browser app: core/ (DI, transport client, shell), shared/ (wire contract), features/
server/src/          sidecar: transport/, pi/, claude-code/, leeboard/, helmraiser/, security/ (Vault),
                     upkeep/, search/, cli/ (fo), projects/, runtime/
tools/pi-upkeep/     quarantined embedded-pi promotion and recovery engine, with its own gate
scripts/             setup.sh, the systemd service tool, SDK promotion scripts, UI screenshot tools
```

## Development

```bash
npm run verify         # strict TypeScript + ESLint + hermetic Vitest suite
npm run verify:tools   # type-check, lint and test the quarantined tools/pi-upkeep
npm run test:runtime   # opt-in: real embedded pi and real model calls (needs credentials)
```

`verify` is hermetic: no test starts a sidecar, a model, a CLI or an updater,
or touches your real `~/.pi`, `~/.helmraiser` or `~/.leeboard`. A husky
pre-commit hook runs it. `verify:tools` is not part of the hook; run it when a
change touches `tools/`. There is no CI. Contributors and coding agents:
read [`AGENTS.md`](AGENTS.md) for the repository rules, and
[`CURRENT_STATE.md`](CURRENT_STATE.md) and [`TASKS.md`](TASKS.md) for what is
built, the decisions in force and the current work.

## Licence

MIT — see [`LICENSE`](LICENSE).

The bundled fonts (`public/fonts/`) are Geist and Geist Mono by Vercel,
under the SIL Open Font License 1.1 (`public/fonts/OFL.txt`).
