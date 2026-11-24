# FunkyOctopus Agent Instructions

## Repository posture

FunkyOctopus is a local, single-user agent cockpit: a browser shell over
**pi** (the agent runtime, embedded as an npm dependency), **Claude Code**
(a second chat engine), **Leeboard** (`lb`, shared rules, holds, handoffs and
requests) and **Helmraiser** (delegated, governed runs). Leeboard and
Helmraiser are optional; FunkyOctopus works without them.
Treat it as real software with one user, not a demo: keep it small, readable
and honest about what it does; do not grow it into a product with channels,
its own memory or a plugin system (see the non-goals in `CURRENT_STATE.md`).

The charter is *thin consumer throughout*: FunkyOctopus drives pi, Claude Code,
Leeboard and Helmraiser through seams and owns none of their logic. When a change would
make FunkyOctopus own something one of those systems already owns, stop and
raise it.

## Repository structure

- `src/` — browser app (Vite + React 19 + Tailwind 4): `core/` (DI container,
  transport client, shell), `shared/` (wire contract, storage adapters),
  `features/` (chat + Leeboard panel, claude-code, jobs/helmraiser, prompts,
  settings, status).
- `server/src/` — Node sidecar (Fastify + WebSocket): `transport/`, `seams/`
  (method registration), `pi/` (embedded pi session lifecycle), `claude-code/`
  (the Claude Code chat engine, decision 12), `leeboard/` (the `lb` runner and
  read-only reads), `helmraiser/`, `security/` (Vault + approvals), `upkeep/`
  (embedded-SDK drift detection + status chip, embedded-state readers, global
  `pi update --all`), `search/` (chat search over pi session files), `cli/`
  (the `fo` command-line client over the sidecar WebSocket), `projects/`,
  `runtime/` (opt-in live tests), `test/`, `util/`.
- `tools/pi-upkeep/` — the quarantined embedded-pi promotion/recovery/canary
  engine (`npm run upkeep:embedded`), with its own `tsconfig.json` and
  `vitest.config.ts`; gated by `npm run verify:tools`, **outside** `verify`.
  It imports from `server/src`; nothing in `server/src` or `src` may import
  from `tools/` (a sidecar test enforces this).
- `scripts/` — repo tools (`ui-shots.mjs` screenshots the running UI; the
  ui-* evidence scripts share `scripts/lib/ui-browser.mjs`, which prefers
  chrome-headless-shell so they also run inside Helmraiser's srt sandbox;
  `promote-pi.ts` the re-runnable embedded-pi promotion — `npm run promote:pi`).
- `docs/brand/` — logo, lockup and social-card assets.
- `.claude/agents/` — project sub-agents (`fo-visual-reviewer`, `fo-grunt`,
  `fo-state-scribe`).

## Current-state and task authority

`CURRENT_STATE.md` and `TASKS.md` at the repository root are the coordination
files. FunkyOctopus is one ownership scope, so both live at the root only.

Before meaningful work:

1. Read both files and treat them as required orientation, subject to
   verification against current evidence.
2. Source, automated tests, freshly measured runtime evidence and explicit
   owner direction outrank the coordination files when they disagree.
   Reconcile stale content rather than silently following it.

Maintain them as follows:

- `CURRENT_STATE.md` records **measured present truth**: what is built, the
  runtime and verification baseline, known gaps, and the decisions in force —
  each mutable claim with its evidence or date. It is not a progress diary.
  Update it when work materially changes implementation, runtime baseline,
  verification posture, external-state knowledge or known gaps.
- `TASKS.md` contains **only current, evidence-backed work**. Each task states
  why it exists (Evidence) and verifiable Acceptance criteria. Remove
  completed tasks instead of keeping a completion ledger. Later tranches are
  headlines only; detail is added when a tranche starts, so it cannot go stale.
- Git history, screenshots and prototypes are context, not task authority.
  Do not recover or invent tasks from them without current evidence and owner
  confirmation.
- New decisions are recorded in `CURRENT_STATE.md` under "Decisions in
  force" — not as separate ADR or plan files. Decision numbers are stable:
  code cites them, so retire a decision by removing it, never by renumbering.

`fo-state-scribe` exists to keep these two files honest after a slice lands;
use it (or do the same by hand) rather than leaving them stale.

## Gates

```bash
npm run verify        # tsc -b (strict) + eslint (any/unused = error) + vitest
npm run verify:tools  # tools/pi-upkeep: its own tsc + eslint + vitest (node env)
npm run test:runtime  # opt-in: real embedded pi + real model turns (needs creds)
```

`verify` is the pre-commit hook and must stay hermetic: no default test may
start a sidecar, model, Hub or updater, or mutate global state. Keep it green
and keep it fast — its duration is a tracked number in `CURRENT_STATE.md`.

`verify:tools` is **not** run by the hook. Run it yourself whenever a change
touches `tools/` or anything it imports from the sidecar side —
`server/src/upkeep/{state-path,embedded-state,detect,run-command,stable-latest,versions,upkeep}.ts`,
`server/src/security/vault.ts`, `server/src/pi/{pi-chat,model-catalog}.ts`,
`src/shared/transport/protocol.ts` — and before committing such a change.

## Running locally

```bash
npm run dev:all       # Vite on 14174 + development sidecar on 14788
```

- Vite is pinned to **14174 with `strictPort`** and the sidecar only accepts
  browser Origins `http://localhost:14174` / `http://127.0.0.1:14174` by default.
  If 14174 is taken by another project, run `npx vite --port 5199 --strictPort`
  and start the sidecar with `SIDECAR_PORT=14788
  FUNKYOCTOPUS_WS_ORIGINS=http://localhost:5199,http://127.0.0.1:5199`.
  Never "fix" this by widening the Origin allow-list to a wildcard.
- Readiness: the log line `funkyoctopus sidecar ready — methods: …`, a
  WebSocket handshake on `/ws`, or an HTTP `GET /health` (a small JSON
  liveness body).
- The status bar's `SDK update available` chip is embedded-pi drift detection
  (read-only). Promotion is an explicit terminal action; never run it from a
  test or on startup. The sidecar takes no lock and checks no sentinel at
  boot; the promotion tool refuses while anything answers on
  `SIDECAR_HOST:SIDECAR_PORT` (default `127.0.0.1:14787`) — checked before any
  state is touched and again right before a promotion mutates — so stop the
  sidecar before promoting or recovering; nothing else keeps them apart. The
  probe reads the *tool's* environment: if the sidecar was started with a
  custom `SIDECAR_HOST`/`SIDECAR_PORT`, run the tool with the same values.
- Screenshots: `node scripts/ui-shots.mjs --out <dir>` (auto-detects a Vite
  serving FunkyOctopus on 5199 or 14174; `--base` overrides). Browser picked
  via `scripts/lib/ui-browser.mjs`: `CHROME_PATH`, else the newest
  chrome-headless-shell under `~/.cache/puppeteer/chrome-headless-shell/`
  (works inside Helmraiser's srt sandbox), else `/usr/bin/google-chrome`.

## Safety and change rules

- **Commits:** meaningful, verified slices are committed with Conventional
  Commit messages **after review** (visual review for UI slices, `verify` for
  all). No micro-commits per file, and no commit of an unreviewed slice.
- Never push, rebase, reset, clean, delete branches, checkout away from
  current work or rewrite history unless explicitly asked.
- Never add a dependency without owner approval. Approved and installed:
  `react-markdown`, `remark-gfm` and `rehype-highlight`, all **exact-pinned**
  like pi, with raw HTML disabled. Approved 2026-10-17: `@anthropic-ai/claude-agent-sdk`
  (exact-pinned) and the peers it requires (`@modelcontextprotocol/sdk`,
  `zod` 4), for the Claude Code engine (`CURRENT_STATE.md` decision 12).
- The embedded pi SDK pin is exact. Bumping it is a code change: install
  exact, `verify`, `test:runtime`, commit — never on startup, never over a
  dirty tree.
- Do not touch the user's real `~/.helmraiser`, `~/.leeboard` or `~/.pi`
  stores from tests.
- Do not store secrets or transcripts in git. Chat transcripts stay in each
  engine's own store by design: pi's in `~/.pi/agent/sessions/`, where pi's
  own TUI keeps them, and Claude Code's in its own (decision 12).

## Sub-agents

| agent | model | use it for |
| --- | --- | --- |
| `fo-visual-reviewer` | opus, low effort | read-only screenshot review of the running UI against the reading/contrast/state checklist, after every UI slice |
| `fo-grunt` | haiku | mechanical moves, import rewrites, config splits, helper dedup — stops and reports on any judgement call |
| `fo-state-scribe` | haiku | refreshing `CURRENT_STATE.md` / `TASKS.md` from measured evidence after a slice |

Design, sequencing and anything that changes a decision in force stay with
the owner and the primary session.

## Commit messages

Conventional Commits, scoped when practical, matching the existing history:
`feat(chat): …`, `fix(helmraiser): …`, `refactor(upkeep): …`, `test(pi): …`,
`docs: …`, `chore(deps): …`.
