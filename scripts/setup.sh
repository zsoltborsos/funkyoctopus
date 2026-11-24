#!/usr/bin/env bash
# First-run helper for FunkyOctopus on Linux.
#
#   scripts/setup.sh [--skip-install]
#
# - checks that Node is present and new enough (the `engines` field of package.json)
# - runs `npm ci` (skip with --skip-install)
# - creates ~/.funkyoctopus/ (mode 700) and, only if it is absent, a commented
#   config.env (mode 600) derived from .env.example. An existing file is never touched.
# - reports which optional tools were found
# - prints the next steps
#
# It never uses sudo, installs nothing globally, and makes no network call
# beyond what `npm ci` itself does. Safe to run again.
set -euo pipefail

skip_install=0
for arg in "$@"; do
  case "$arg" in
    --skip-install) skip_install=1 ;;
    -h | --help)
      sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "setup: unknown option $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"

say() { printf '%s\n' "$*"; }
found() { printf '  found    %s\n' "$*"; }
absent() { printf '  missing  %s\n' "$*"; }

# --- Node -------------------------------------------------------------------

required_major="$(sed -n 's/.*"node": *">=\([0-9][0-9]*\).*/\1/p' package.json | head -n 1)"
if [ -z "$required_major" ]; then
  say "setup: could not read the required Node version from package.json" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  say "setup: Node $required_major or newer is required and 'node' is not on PATH" >&2
  exit 1
fi
node_version="$(node -v)"
node_major="${node_version#v}"
node_major="${node_major%%.*}"
if [ "$node_major" -lt "$required_major" ]; then
  say "setup: Node $required_major or newer is required (found $node_version)" >&2
  exit 1
fi
say "Node $node_version (needs >= $required_major): ok"

# --- Dependencies -----------------------------------------------------------

if [ "$skip_install" -eq 1 ]; then
  say "npm ci: skipped (--skip-install)"
else
  if ! command -v npm >/dev/null 2>&1; then
    say "setup: 'npm' is not on PATH" >&2
    exit 1
  fi
  say "npm ci ..."
  npm ci
fi

# --- Settings directory and file -------------------------------------------

state_dir="$HOME/.funkyoctopus"
config_file="$state_dir/config.env"

if [ -d "$state_dir" ]; then
  say "$state_dir: exists, left as is"
else
  mkdir -p "$state_dir"
  chmod 700 "$state_dir"
  say "$state_dir: created (700)"
fi

if [ -e "$config_file" ]; then
  say "$config_file: exists, left as is"
elif [ ! -f "$repo/.env.example" ]; then
  say "$config_file: not created (.env.example not found)"
else
  (
    umask 077
    {
      say "# FunkyOctopus settings, created by scripts/setup.sh from .env.example."
      say "# Every setting is commented out; uncomment and edit what you need, then restart the sidecar."
      say "# A variable already set in the real environment wins over this file."
      say ""
      # Drop the Vite-only block (it is not read from this file), comment out the rest.
      sed -e '/^# Browser → sidecar/,/^VITE_SIDECAR_URL=/d' \
        -e 's/^\([A-Z][A-Z0-9_]*=\)/# \1/' "$repo/.env.example"
    } >"$config_file"
  )
  chmod 600 "$config_file"
  say "$config_file: created (600), all settings commented out"
fi
if [ -n "${FUNKYOCTOPUS_CONFIG:-}" ]; then
  say "note: FUNKYOCTOPUS_CONFIG is set ($FUNKYOCTOPUS_CONFIG); the sidecar reads that file, not the one above"
fi

# --- Optional tools ---------------------------------------------------------

say ""
say "Optional tools (FunkyOctopus starts without any of them):"
if command -v claude >/dev/null 2>&1; then
  found "claude   (Claude tabs; sign in with: claude, then /login)"
else
  absent "claude   (Claude tabs need Claude Code installed)"
fi
if command -v lb >/dev/null 2>&1; then
  found "lb       (Leeboard panel)"
else
  absent "lb       (Leeboard panel shows 'not installed')"
fi
if command -v helmraiser >/dev/null 2>&1; then
  found "helmraiser (Helmraiser view and dashboard)"
else
  absent "helmraiser (Helmraiser view shows 'not installed')"
fi
pi_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
if [ -f "$pi_dir/auth.json" ]; then
  found "pi provider sign-in ($pi_dir/auth.json)"
else
  absent "pi provider sign-in (no $pi_dir/auth.json; pi chat tabs need a provider, see README)"
fi
if command -v pi >/dev/null 2>&1; then
  found "pi CLI   (for /login and the daily 'pi update --all')"
else
  absent "pi CLI   (for /login and the daily 'pi update --all')"
fi
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  found "systemd user instance (for 'npm run service:install')"
else
  absent "systemd user instance (needed only for the always-on service)"
fi

# --- Next steps -------------------------------------------------------------

cat <<'EOF'

Next steps:
  1. Sign in to a model provider for pi tabs (run `pi`, then /login) and/or to
     Claude Code (run `claude`, then /login). FunkyOctopus never handles credentials.
  2. Try it:            npm run dev:all   then open http://localhost:14174
  3. Run it always-on:  npm run service:install   (systemd user service, http://127.0.0.1:14787)
  4. Adjust settings in ~/.funkyoctopus/config.env, then restart the sidecar.

FunkyOctopus has no login. Keep it on this machine; never expose it to a network.
EOF
