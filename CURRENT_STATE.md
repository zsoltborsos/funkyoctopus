# FunkyOctopus — Current State

Measured present truth: what is built, how it runs, how it is verified, what
is missing, and the decisions in force. Last measured 2026-11-23. Git history
holds everything older; this file is not a diary (see `AGENTS.md`).

## Product shape

FunkyOctopus (FO) is a local, single-user browser cockpit for coding agents.
It drives:

- **pi** (`@earendil-works/pi-coding-agent`), embedded in the sidecar as the
  default chat engine;
- **Claude Code**, through the Agent SDK and the user's installed `claude`
  binary, as a second chat engine (decision 12);
- **Leeboard** (`lb` CLI): shared rules, holds, references, handoffs and
  requests that every agent session reads;
- **Helmraiser** (`helmraiser` CLI): delegated, governed runs.

The charter is *thin consumer throughout*: FO drives these through seams and
owns none of their loop, memory, governance or extension model. Leeboard and
Helmraiser are optional; FO works without them, and they work without FO.
There is no login: FO binds loopback only and is meant for one user on one
Linux machine.

## Architecture as built

Two processes, one wire contract (`src/shared/transport/protocol.ts`):
request/response *calls* and server→client *streams*, correlated by id over a
single WebSocket. The browser never sees a concrete server class; the method
name is the only coupling. Request/response methods share one `WireCalls`
map, checked at compile time for browser calls, CLI calls and sidecar
registration; inbound frames and `fo call` are runtime-validated.

- **Browser** — Vite 8 + React 19 + Tailwind 4, strict TS project
  references. A DI container (`src/core/container`) resolves seam tokens to
  thin transport clients; wiring lives only in `src/core/bootstrap.ts`. The
  shell (`src/App.tsx`, `src/core/shell/nav.ts`) shows one view at a time —
  Chat, Helmraiser, Prompts, Settings — with a status bar below and a Ctrl+K
  switcher over everything.
- **Sidecar** — Fastify 5 + `@fastify/websocket` on loopback. Wiring lives
  only in `server/src/index.ts`; `server/src/entrypoint.ts` applies the
  settings file (`~/.funkyoctopus/config.env`, or `FUNKYOCTOPUS_CONFIG`; real
  env wins) before the core loads. Every setting is listed in `.env.example`.
  A browser Origin allow-list guards `/ws` before the upgrade
  (`server/src/transport/server.ts`; `FUNKYOCTOPUS_WS_ORIGINS` overrides).
  `GET /health` returns a small liveness body. With `FUNKYOCTOPUS_SERVE_UI=1`
  the same process serves `dist/`.
- **Wire methods** (`protocol.ts`):
  - `system.health`, `system.upkeep`, `models.list`, `vault.resolve`,
    `projects.discover`, `projects.resolve`;
  - `chat.*`: `send`, `observe`, `setRoot`, `new`, `open`, `exists`,
    `transcript`, `list`, `current`, `create`, `close`, `slots`,
    `slotsObserve`, `commands`, `compact`, `rename`, `search`;
  - `claude.status`, `claude.sessions`;
  - `leeboard.brief`, `show`, `review`, `holds`, `open`, `asked` (all reads);
  - `helmraiser.*`: `status`, `observe`, `report`, `stats`, `drafts`,
    `allDrafts`, `draft`, `propose`, `queue`, `queueRemove`, `dropDraft`,
    `requestScouts`, `cancelScouts`, `scoutSettings`, `setScoutSettings`,
    `resetScoutSettings`, `plan`, `runReview`, `log`, `approve`, `reject`,
    `retry`, `rework`, `abort`, `workerStart`, `workerStop`, `pause`,
    `resume`.
- **Chat slots** (`server/src/chat-registry.ts`, decision 13) — each tab is
  an FO-minted `chatId` holding one engine for its life; a permanent `main`
  slot always exists. Slots are server-owned and shared by every window and
  the `fo` CLI. They persist as UI state in `slots.json` in the checkout's
  state dir (`${XDG_STATE_HOME:-~/.local/state}/funkyoctopus/upkeep/<hash>/`,
  `server/src/upkeep/state-path.ts`), guarded by a pid lock so one sidecar
  owns a state dir. Restore after a restart only arms a slot; it never starts
  a turn. Engine contract: `server/src/chat-engine.ts`.
- **pi engine** (`server/src/pi/`) — one `PiChat` per pi slot owns one live
  `AgentSession`. Sessions are pi `SessionManager` JSONL files under
  `~/.pi/agent/sessions/<encoded-cwd>/`, unencrypted on purpose, where pi's
  own TUI keeps them; a meta session stays in memory so it never reaches
  history. pi's own `/new /resume /fork` replacement machinery is
  deliberately unreachable (`session-host.ts`); FO owns session replacement
  and tears sessions down with the TUI's reasons. Turn options carry
  provider/model/effort and apply to the live session before each turn.
- **Claude Code engine** (`server/src/claude-code/`) — `ClaudeCodeChat`
  implements `ChatEngine`; wire identity is `claude-code:<sessionId>`.
  `ClaudeCodeStatus` reads `claude auth status --json` (forwarding only
  `loggedIn`, `authMethod`, `apiProvider`, `subscriptionType`),
  `claude agents --json`, and the SDK's usage and `listSessions`, each cached
  and single-flight; quota is read only for a subscription sign-in. Every
  child gets `claudeChildEnv`, which strips only parent-session markers and
  passes the user's own sign-in settings through (decision 12, limit 4); the
  binary is `CLAUDE_BIN` via `pathToClaudeCodeExecutable`
  (`stubs/no-claude-binary` replaces the SDK's bundled one).
- **Leeboard seam** (`server/src/seams/leeboard.ts`, `server/src/leeboard/`) —
  read-only calls to the `lb` CLI; each failure is an in-band `error`. A
  missing `lb` is a `not_installed` backend, logged once per process. Every
  `lb` spawn drops the sidecar's `LEEBOARD_SESSION` / `LEEBOARD_HARNESS`.
- **Helmraiser seams** (`server/src/helmraiser/`, `server/src/seams/workflow.ts`)
  — the `helmraiser --json` CLI is the only action and status plane. Writes go
  through the Vault (`vaultBeforeSpawn`). Plan and review reads come straight
  from run artefacts under `HELMRAISER_DATA_DIR` (default `~/.helmraiser`)
  through UUID, canonical-path and 256-KiB guards. Chat-to-task drafts may
  live only in a known project's `.helmraiser/tasks/`. A watcher polls status
  every 30 s and streams `awaiting` / `failed` / `landed` events. A missing
  CLI is `not_installed`; status answers from memory for 60 s before it
  rechecks.
- **Security** (`server/src/security/`) — tools run without prompts by
  default, with a tiered Vault (`~/.funkyoctopus/vault.json`; the default rule
  blocks `~/.ssh`; `escalate` rules go to an approval broker and show as
  inline APPROVE/DENY cards). For Claude Code the Vault runs as an SDK
  `PreToolUse` hook. The Vault is a tripwire, not a sandbox.
- **Upkeep** — two parts:
  - in the sidecar (`server/src/upkeep/`): global `pi update --all` after
    start and every 24 h, embedded-pi drift detection against npm's stable
    `latest`, Claude SDK ↔ CLI drift detection (`claude-sdk-drift.ts`), and
    the status-bar chips;
  - outside it: `npm run promote:pi` and `npm run promote:claude-sdk`
    (re-runnable scripts: refuse on a dirty tree or a live sidecar, install
    exact, run the gates, commit, restore on failure), and the quarantined
    promotion/recovery/canary engine in `tools/pi-upkeep/`
    (`npm run upkeep:embedded`, decision 1).
- **`fo` CLI** (`bin/fo` → `server/src/cli/fo.ts`) — a Node client over the
  same WebSocket: `health`, `projects`, `models`, `helmraiser`, `call`,
  `chats`, `chat …` (`current`, `new`, `open`, `root`, `create`, `close`),
  `send`, `vault`. Stable human and `--json` output, exit codes
  0/1/2/3/124/130. It defaults to `main`; sending into a Claude slot needs an
  explicit `--chat` and an interactive terminal (decision 12, limit 2).
- **Service** (`scripts/service.ts`) — `npm run service:install` /
  `npm run deploy` install a systemd user unit (`funkyoctopus.service`) that
  runs a detached deployed worktree of `main` (or the ref `service:install`
  is given), serving the UI and the WebSocket on the service port.
  `service:install` refuses Node older than 26; a missing `pi`, `helmraiser`
  or `lb` CLI is only a warning.

## What is built

- **Chat** (`src/features/chat/`)
  - Streaming turns as ordered steps: thinking, text, tool call, tool result,
    approval request. Assistant text is GFM markdown (decision 2); fenced code
    has a language label and a copy button; user text stays plain. Thinking is
    a labelled fold, open while it is the live tail and folded once text
    follows. Tool steps are collapsed one-liners, expandable to args, diff or
    output; edits render as ± diffs.
  - Tabs over both engines: a "＋" menu opens a pi or a Claude tab; each
    tab's model picker shows only its engine. Busy, attention and unread
    marks on the tab bar.
  - Per-message model and effort pickers (effort scoped to the model's
    thinking ladder); the empty chat names the server-resolved pi default or
    says none is configured. Context meter after each turn.
  - Composer: Enter while a turn streams queues the message (decision 10);
    Esc stops a turn; Ctrl+N / Alt+N start a new chat; Up/Down recall sent
    messages shell-style (200 entries, persisted); pasted or dropped images
    are sent as image content, with a warning on a text-only model; text that
    is only paths becomes path chips. One shortcuts table
    (`shortcuts.ts`), listed read-only in Settings.
  - The transcript sticks to the bottom, with a "jump to latest" pill when
    scrolled up; reopening lands at the end.
  - History per folder (or all folders in Global); `/` palette per engine
    (`chat.commands`; pi's commands plus FO's `compact` and `rename`; Claude's
    own); Ctrl+K switches views and tabs and, from 3 letters, searches stored
    chats of both engines (`server/src/search/`).
  - pi-crew activity: live crew strip and crew audit cards (observe-only).
    Until pi-crew binds per session, crew loads in at most one pi tab
    (decision 13).
  - Opt-in browser notifications when a turn finishes while the page is
    hidden; a tab-local "While you were away" card after 60 s hidden.
  - Save a draft as a prompt template.
- **Leeboard panel** (right edge of Chat, `src/features/chat/leeboard-panel/`)
  — a labelled spine (`↧ inbox`, `⊘ holds`, `Δ digest`, each with its
  count, plus `↻ refresh`) and one pane per tab:
  - the inbox: requests and handoffs addressed to this tab, those asked from
    it (with a REPLIED badge), and those for other projects, with **take it**
    (puts a prompt in the target tab's composer, never sends) or a jump to,
    or a new tab in, the target project;
  - every active hold across projects, yellow where it applies to this tab
    and dim elsewhere;
  - the `lb review --peek` digest, with `review with an agent ▾`.

  Entries open read-only as markdown, raw HTML off. FO writes nothing to
  Leeboard itself (decision 14). A missing `lb` shows one dim "not installed —
  FunkyOctopus works without it" line with a link.
- **Helmraiser** (`src/features/jobs/`) — a `queue | dashboard` switch.
  - Queue view: a "LAST 24H" headline strip; RUNNING (ABORT, run log),
    AWAITING YOUR APPROVAL (plan, scope and merge rows: APPROVE, confirm-first
    REJECT, REWORK with a note and/or rebase and earlier rounds; REVIEW with
    summary, verdict and diff stat; review in the originating chat or a fresh
    one), QUEUED NEXT (why each task is held; remove), FAILED · 24H (RETRY /
    RETRY (IMPLEMENT), run log). Worker START/STOP and PAUSE/RESUME. A scout
    lens grid per focus project with per-cell Scout and Cancel, per-lens
    scout settings, SCOUTED and unqueued drafts with confirm-first Queue,
    classed Drop and Discuss-in-chat. NEW TASK and FROM CHAT draft a task
    file, ask intake for a proposal, and queue only on the owner's click.
  - Dashboard view (24h / 7d / 30d): health tiles, provider usage bars,
    implementer models table, quality, trends, cost and time, failures by
    class, scout funnel, and failed runs with their run log.
  - Opt-in browser and desktop (`notify-send`, `FUNKYOCTOPUS_DESKTOP_NOTIFY=1`)
    notifications for awaiting, failed and landed runs.
  - A missing CLI shows one dim "not installed" line with a link.
- **Prompts** — a localStorage template list; picking one loads it into the
  composer.
- **Settings** — font size, timestamps, expand tool steps by default, run and
  chat notifications, menu side, and the shortcuts list. Stored in
  localStorage.
- **Status bar** — sidecar online/offline, version, uptime; pi, helmraiser
  and leeboard up / down / unknown / not installed (not installed is dim with
  the install hint as tooltip; down is red); embedded-SDK and Claude SDK
  drift chips; the Claude chip (sign-in method, plus plan and usage on a
  subscription); the first running
  Helmraiser run.
- **Project selector** — Global (`FUNKYOCTOPUS_WORKSPACE_ROOT`), Known
  projects from `lb project list --json` (existing directories only), Folders
  from `FUNKYOCTOPUS_PROJECT_ROOTS` (default `<home>/projects`, plus git repos
  one level under a non-repo child), and an "Open folder…" typed path. Each
  tab keeps its own folder.

Nothing above is stubbed; every control reaches the sidecar.

## Runtime baseline

- Embedded pi **1.6.0**, exact-pinned (promoted with `npm run promote:pi`,
  2026-11-22). Claude Agent SDK **0.3.332**, exact-pinned, paired with Claude
  Code CLI 2.1.332 (live Claude Code runtime test passed 2026-11-25).
- TypeScript 6.0.3 (typescript-eslint 8.74.0 supports `<6.1.0` only; TypeScript 7 waits for it); Vite 8,
  Vitest 5, ESLint 10.
- Node 26 or newer (`engines`, enforced by `service:install`).
- Ports (decision 15): service 14787, dev sidecar 14788, dev Vite 14174
  (`strictPort`). `DEFAULT_SIDECAR_PORT` in `protocol.ts` feeds the sidecar,
  `fo`, the deploy script and the promotion probe.
- Default pi model: `FUNKYOCTOPUS_PROVIDER` / `FUNKYOCTOPUS_MODEL`, else pi's
  own `defaultProvider` / `defaultModel` (`resolvePiModel`). When neither
  names one, pi is reported down with the reason and the sidecar still boots.
- Evidence tooling: `scripts/ui-*.mjs` screenshot and evidence drivers pick
  their browser through `scripts/lib/ui-browser.mjs` (`CHROME_PATH`, else
  the newest chrome-headless-shell under `~/.cache/puppeteer/`, else
  `/usr/bin/google-chrome`). chrome-headless-shell is the one that works
  inside Helmraiser's srt sandbox.
- No CI. All gates run locally; the pre-commit hook runs `verify`.
- Repository: `github.com/zsoltborsos/funkyoctopus`, restarted on
  2026-11-23 from one fresh commit of the cleaned tree, and **public** since
  2026-11-24 (owner's decision). The earlier history is kept in the private
  archive repo `funkyoctopus-archive`. Helmraiser and Leeboard are still
  private repos.

## Verification baseline (2026-11-24)

- `npm run verify` (`tsc -b` strict + ESLint with `any`/unused as errors +
  Vitest): 3052 passed, 1 skipped, in 153 files
  (47.0 s Vitest).
  Two Vitest projects: `browser` (`src/`, jsdom) and `node` (`server/`,
  `scripts/`). The expected skip is the `pi-contract.test.ts` case that only
  runs once pi-crew binds per session (decision 13).
- `npm run verify:tools` (`tools/pi-upkeep`, its own tsc + ESLint + Vitest):
  427 passed in 11 files.
- `npm run test:runtime` (opt-in, needs model credentials): real embedded pi
  and real model turns, the live canary for a pi bump; 22/22 at the pi 1.6.0
  promotion (2026-11-22).
- `verify` is hermetic: no test starts a sidecar, model, CLI or updater, or
  touches the real `~/.pi`, `~/.helmraiser` or `~/.leeboard`. The one
  deliberate outside read: `pi-contract.test.ts` reads the global pi-crew
  extension when present and skips those cases when it is absent.
- `pi-contract.test.ts` names every private pi surface FO relies on, so an
  SDK bump fails in `verify`, not in production.
- Strict TS includes `exactOptionalPropertyTypes` and
  `noUncheckedIndexedAccess`; no non-null assertions, no TODOs.
- Wall times vary with machine load; compare before and after in one sitting
  rather than against a recorded number.

## Known gaps

Chat
- No fork.
- The "↓ jump to latest" pill overlays transcript content
  (`src/features/chat/ChatPanel.tsx:623`, absolute `bottom-6`).
- Search's first build after a sidecar start takes seconds and briefly lifts
  RSS to about 1 GB (the Claude SDK parses each transcript whole); a chat in
  use can trail by up to a minute in results.
- A Claude tab's `/rename` names the session in Claude Code, but the tab
  title follows only when the session is next read.
- FO's `/compact` cannot be stopped from the browser once started
  (`chat.compact` has no cancel).
- A pi transcript reopened after a `/skill:` pick shows the expanded skill
  body as the user message.
- pi-crew loads in at most one pi tab until it binds per session
  (decision 13).

Leeboard and Helmraiser
- Leeboard panel reads run on mount, a folder or session change, refresh, and
  a turn ending in any tab. There is no polling, so a Leeboard edit made
  outside FO stays unseen until one of those.
- No "remember this" from a message or the composer (`TASKS.md`, later).
- Retry and rework have not yet been checked live from FO (`TASKS.md` T4.3,
  T4.4). No run lookup for older runs (T4.5).
- Typed wire error codes cover only the unavailable / not-installed states
  and the Helmraiser CLI's errors; other seam failures cross the wire as a
  bare message.

Operations
- Any local process, under any user account, can drive the sidecar: the
  WebSocket's Origin guard admits a connection with no Origin header (how
  `fo` connects; Node's WebSocket sends none), and there is no token
  (`server/src/transport/server.ts`, `originGuard`; `SECURITY.md`).
- `npm run deploy` writes the unit's `PATH` and Node from the deploying
  shell, so the service inherits that shell's toolchain.
- The sidecar takes no lock at boot, so it can start mid-promotion; stopping
  the sidecar before promoting is the mitigation (decision 1).

## Decisions in force

Numbers are stable because code and tests cite them; gaps are retired
decisions.

1. **Upkeep engine in quarantine.** The embedded-pi promotion, recovery and
   canary engine lives in `tools/pi-upkeep/` with its own `tsconfig.json`
   (extends `tsconfig.server.json`) and Vitest project, outside `verify` and
   outside the sidecar boot path. Nothing in `server/src` or `src` imports
   from `tools/` (a sidecar test enforces this). Detection, the status chip,
   global `pi update --all` and the version and state readers stay in the
   sidecar. Promotion is a re-runnable script (`scripts/promote-pi.ts`):
   refuse outside git, on a dirty tree, on a live sidecar or on pin ≠
   installed → `npm install --save-exact` → `verify` → `test:runtime` →
   commit; on failure restore `package*.json` and `npm ci`. Git is the
   journal. The promotion tool refuses while a sidecar answers on
   `SIDECAR_HOST:SIDECAR_PORT`, checked before any state I/O and again right
   before mutating; the sidecar itself takes no lock or sentinel.
2. **Renderer.** `react-markdown` + `remark-gfm` + `rehype-highlight`,
   exact-pinned, raw HTML skipped, `javascript:` hrefs dropped. `hljs-*`
   tokens are styled in `src/index.css`; the copy button reads the hast
   subtree. Thinking is a labelled collapsible that folds once text follows;
   a click overrides it for the mounted message.
3. **Aesthetic.** Accent identity on chrome, gutter and prompt glyphs;
   assistant body text neutral; muted text and timestamps at AA contrast
   (`muted`); `attention` carries one meaning — a warning or something
   waiting on you. Colours are semantic tokens named for what they mean
   (`bg`, `surface`, `border`, `text`, `muted`, `accent`, `ok`, `danger`,
   `attention`, `info`, `special`), documented at the top of `src/index.css`.
   Themes (owner, 2026-11-23): a theme is one `--theme-*` token block plus a
   registry entry (`src/features/settings/themes.ts`), and the remembered
   `theme` preference sets `data-theme` before first paint. **Brand** is the
   default. It uses the ZB Code Shipyard site palette, follows the system
   light/dark setting and uses the Geist fonts (bundled, SIL OFL 1.1).
   **Matrix** is the original green look, dark only. Every brand text colour
   is ≥ 4.5:1 on bg, surface and surface-raised.
4. **Driving essentials.** The composer never drops a message: Enter while
   busy queues it, STOP returns queued text and images to the composer. Esc
   stops, Ctrl+N new chat, paste or drop images and paths, a `/` palette
   routed to the engine's own methods, Ctrl+K, and multiple concurrent chats
   (decision 13).
7. **Non-goals (hard).** FO never grows its own memory store, skill hub or
   plugin marketplace: Leeboard owns shared memory, pi and Claude Code own
   tools, skills and extensions, Helmraiser owns workflows. Messaging
   channels, mobile apps, a composable dashboard, a workflow editor and
   in-FO scheduling are not renounced, but are not on the current list.
10. **Queue-while-streaming is browser-side.** `ChatSession` queues messages
    that arrive while a turn streams; the sidecar streams one turn per
    `chat.send`, so queued messages become ordinary consecutive turns, each
    capturing its text and images at enqueue time. pi's in-run `followUp`
    queue is not used.
11. **Session-path containment.** `chat.open` and `chat.exists` accept a pi
    session file only inside pi's session store (`guardedSessionPath`:
    canonical realpath, so `..` and symlink escapes fail, `bad_session_path`
    otherwise) and open the canonical path. Claude Code handles
    (`claude-code:<id>`) are ids, not paths. Reviewing a Helmraiser run in
    its originating chat reopens that session with pi's effective cwd and
    never re-roots it to the run worktree; plan review asks the agent for a
    recommendation and never approves.
12. **Claude as a second chat engine.** FO drives Claude Code through the
    TypeScript Agent SDK (exact-pinned), running the user's installed,
    unmodified `claude` binary via `pathToClaudeCodeExecutable`.
    - **Limits:**
      1. *Within Anthropic's published terms* (Claude Code "Legal and
         compliance", https://code.claude.com/docs/en/legal-and-compliance,
         and the Agent SDK overview's branding guidance,
         https://code.claude.com/docs/en/agent-sdk/overview; both checked
         2026-11-23):
         - the installed binary runs as Anthropic publishes it, unmodified;
         - sign-in happens only through Anthropic's own flow, in the user's
           terminal (`claude`, then `/login`); FO never collects, stores or
           relays credentials or session tokens;
         - every authentication method the binary supports is accepted — a
           claude.ai subscription, the user's own API key (environment,
           `apiKeyHelper` or a Console key from `/login`), an auth token, or
           a cloud provider (Amazon Bedrock, Google Vertex AI, Microsoft
           Foundry) — and the one in use is shown (status chip and popover:
           `subscription (Max)`, `API key`, `auth token` or the provider), so
           metered billing is never a surprise;
         - each user signs in with their own plan, key or provider
           credential and is billed by it;
         - the UI calls the engine and its features "Claude", never "Claude
           Code"; plain text may say accurately that FO runs Claude Code;
         - the Agent SDK dependency is under Anthropic's Commercial Terms,
           not FO's MIT licence.
      2. *Human-driven turns only.* No scheduled, unattended or retried
         Claude turns from the sidecar, and no Helmraiser workers on it. FO's
         Claude engine runs with cron and background tasks disabled, because
         a finished background task makes the CLI start a turn of its own
         (measured).
      3. *FO never touches Claude credentials.* No reading
         `~/.claude/.credentials.json` or any token, no `setup-token`; login
         happens in a terminal. Verified 2026-11-23: no FO code reads a
         credential file; `claude auth status --json` is whitelisted to
         `loggedIn`, `authMethod`, `apiProvider`, `subscriptionType`.
      4. *No auth method is removed, disabled or restricted.* `claudeChildEnv`
         strips only a parent Claude Code session's markers (`CLAUDECODE`,
         `CLAUDE_CODE_SESSION_ID`, the messaging socket and token, ...), never
         a sign-in setting the user set; `--bare` is never passed. Before the
         first prompt FO asks only whether the process is signed in at all,
         and logged out is refused with the `claude`-then-`/login` line.
         Quota meters are read for a subscription only.
      5. *No double-driving.* A resume of a session that `claude agents
         --json` reports live is forked instead.
    - **Permissions:** `bypassPermissions`. Under bypass `canUseTool` is
      never called (measured), so the Vault runs as a `PreToolUse` hook — a
      tripwire, not a sandbox.
    - **Memory:** FO injects no brief or recall; Claude Code's own CLAUDE.md,
      skills and hooks own orientation and memory (non-goal 7).
    - **Transcripts:** each engine owns its transcript store; FO reads it and
      never writes it.
13. **Multi-session design.**
    - **Unit:** an FO-minted `chatId` per slot (tab), each holding one engine
      for its life; a permanent `main` slot; new slots start fresh. A
      conversation never moves between engines.
    - **Tabs are shared** by every window and the `fo` CLI (server-owned).
      Closing one closes it everywhere and is refused while a turn is live.
      Restore after a restart is server-owned (`slots.json`, UI state only)
      and only arms.
    - **One holder per engine session** across slots; wire identity is
      `{engine, id}`. A pi tab and the pi TUI holding the same file is
      accepted; FO only prevents two FO slots holding one session.
    - **pi-crew:** FO tears pi sessions down with the TUI's reasons through
      public API (`session_shutdown` with `new`, `resume` or `quit`, then
      `dispose()`). Until a per-session pi-crew is installed, crew loads in at
      most one pi slot; the others run without the extension, and the UI
      says so. Subagents of a session a tab switched away from keep running
      and show on the tab.
    - **Caps (defaults):** 8 slots (`FUNKYOCTOPUS_MAX_CHATS`), at most 4
      running Claude processes (`FUNKYOCTOPUS_MAX_CLAUDE_RUNNING`).
14. **FO consumes Leeboard read-only.** FO reads `lb project list --json` (the
    project registry) and `lb brief` / `show` / `review --peek` / `list`
    (including all active holds). It writes no Leeboard entries and stores
    nothing itself (non-goal 7). It injects nothing into sessions: agents run
    `lb brief` from their own global instructions. `lb list --session` /
    `--harness` are author filters, so FO never passes itself as either.
15. **Ports off the common dev defaults.** Service 14787, dev sidecar 14788,
    dev Vite 14174 — below Linux's ephemeral range and clear of the
    8787/8788/5174 defaults other dev projects want. The service binds
    loopback because FO has no login; an SSH tunnel to loopback reaches it
    from another machine without widening the bind or the Origin allow-list.
