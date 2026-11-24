# FunkyOctopus — Confirmed Tasks

Only current, evidence-backed work belongs here. Remove completed tasks rather
than preserving a progress history. Later tranches are headlines; their slices
are written when the tranche starts.

Rules for all work:

- Every UI slice is screenshot-reviewed (`fo-visual-reviewer`) before it is
  called done; every slice keeps `npm run verify` green and hermetic.
- No dependency beyond the approved set (`AGENTS.md`) without owner approval.
- Friction found while using FO becomes an evidence-backed task here or is
  discarded.

## T4 — Helmraiser loop

**Evidence:** the Helmraiser view covers the happy path (scout, queue,
approve, merge), failed-run retry and merge rework, the queue's hold reasons,
the run log and the dashboard (`CURRENT_STATE.md`, "What is built").

Rules for every slice:
- Helmraiser owns the logic; FO calls its `--json` CLI and renders the result.
- Approvals and hand-backs stay owner clicks behind the existing confirm and
  Vault path.
- Default tests use fixtures from the real output shapes and never touch the
  real `~/.helmraiser`.
- Retry and rework each get one opt-in live check, named in advance, before
  they are called working.
- Visual review applies to each UI slice.

### T4.3 Retry a failed run — live check

**Evidence:** RETRY and RETRY (IMPLEMENT) on failed rows go through the
owner-only, Vault-gated `helmraiser.retry {runId, implement?}` seam
(`src/features/jobs/RetryControls.tsx`); fixture tests cover it, but no real
failed run has been retried from FO.

**Acceptance:** one live check on a real failed run shows the row leaving
`failed`. It waits for the owner.

### T4.4 Rework a run awaiting merge — live check

**Evidence:** REWORK on awaiting-merge rows goes through the owner-only,
Vault-gated `helmraiser.rework {runId, note?, rebase?}` seam
(`src/features/jobs/ReworkForm.tsx`, `ReworkRounds.tsx`); fixture tests
cover it, but no real rework has been sent from FO.

**Acceptance:** one live check shows the row moving to resuming. It waits
for the owner.

### T4.5 Run lookup (later)

**Evidence:** the dashboard shows recent failed runs with their RunLog, but
there is no way to find an older or landed run from FO.

**Acceptance:** find any past run, then open its timeline, verify, review,
cost and reworks through `show --json` / `log --json` and the existing
RunLog.

## T5 — Open source (owner decisions 2026-11-23)

**Evidence:** the coordinator's request
`request-brainstorm-with-the-owner-what-funkyocto-b6a9` (MIT, single-user,
local-only, shared as-is, one tool family with Helmraiser and Leeboard). On
2026-11-23 gitleaks found no secrets in 413 commits or the tree, but the
history carries the owner's email on every commit, private work and project
names, a LAN address and real home-directory paths in 23 tracked files.
GitHub PRs #1 and #2 keep old commits reachable, so a clean history needs a
new repo.

Owner decisions:
- FO is the tool that ties Helmraiser and Leeboard together and shows what
  they do under the hood. It drives any agent, and it can be the main driver.
  HR and Leeboard stay usable without it, and FO works without them.
- Description agreed (reply on the request). Tagline: "Your agents and tools,
  all within a tentacle's reach." The alternate is "There's a tentacle for
  all your agent needs."
- Clean history. Rename this repo to a private archive that keeps the full
  history and recreate `funkyoctopus` with one fresh commit. The owner made
  it public on 2026-11-24, without waiting for the coordinator's brief.
- Linux only, stated in the README. No installer: setup scripts or skills.
- Screenshots use demo data, never the owner's projects, and wait for the
  owner's UI tweaks.

The tree was cleaned (T5.1–T5.5, T5.7), then lifted into a fresh repo as
one commit (T5.6, 2026-11-23). What remains is under Later.

## Later (headlines only)

- Chat fork (pi and Claude tabs).
- "Remember this" from a message or the composer: FO hands the text to the
  session's agent or calls `lb`; FO stores nothing itself (non-goal 7).
- FO release update check.
- Local-client authentication: today any local process, from any user, can
  drive the sidecar (`CURRENT_STATE.md`, Known gaps). Candidates include a
  per-user token for `fo` and other non-browser clients, or a Unix socket
  with owner-only permissions.
- Demo mode and screenshots, in the branded theme (owner deferred UI tweaks
  2026-11-23).
- GitHub social preview upload (`docs/brand/funkyoctopus-social.png`, the
  repository's Settings): the owner's manual step.
