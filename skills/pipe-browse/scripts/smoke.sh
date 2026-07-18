#!/usr/bin/env bash
# smoke: prove pipe-browse drives Chromium with NO open CDP TCP port.
# PASS = snapshot works AND the launched chromium carries --remote-debugging-pipe
# AND no process listens on a remote-debugging TCP port while it runs.
set -euo pipefail
cd "$(dirname "$0")"

profile="smoke-$$"
snap_out="$(mktemp)"
node pipe-browse.mjs snap "$profile" 'https://example.com' >"$snap_out" 2>&1 &
snap_pid=$!

flags=""; ports=""
for _ in $(seq 1 40); do
  # NOTE: search for the PIPE flag specifically, not the broader
  # "remote-debugging" (which also matches "--remote-debugging-port" on any
  # OTHER already-running debuggable browser on this machine, e.g. a
  # daily-driver browser kept CDP-enabled for the WebSocket-attach skills --
  # a genuinely unrelated process, but pgrep is system-wide, so a loose
  # pattern here false-FAILs on a healthy pipe-browse run whenever such a
  # browser happens to be open).
  f="$(pgrep -fl 'remote-debugging-pipe' 2>/dev/null | head -2 || true)"
  [ -n "$f" ] && flags="$f"
  # Same false-fail hazard as the pgrep search above, on the listener check:
  # a system-wide `lsof ... | grep chrom` also flags a completely unrelated
  # chromium process holding a TCP listener (a daily-driver browser kept
  # CDP-enabled for the WebSocket-attach skills, or another pipe-browse-style
  # tool's own launch). Cross-reference each candidate PID's actual cmdline
  # against THIS run's unique profile dir, so only OUR launched browser can
  # trip the negative control.
  ports=""
  for pid in $(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -iE 'chrom' | awk '{print $2}' | sort -u); do
    if ps -o command= -p "$pid" 2>/dev/null | grep -q "profiles/$profile"; then
      ports="$ports pid=$pid"
    fi
  done
  kill -0 "$snap_pid" 2>/dev/null || break
  sleep 0.25
done
wait "$snap_pid"

echo '--- snapshot ---'; cat "$snap_out"
echo '--- flags seen ---'; echo "${flags:-<none>}"
echo '--- listeners seen (NEGATIVE CONTROL, must be empty) ---'; echo "${ports:-<none>}"

grep -q 'Example Domain' "$snap_out" || { echo 'FAIL: snapshot missing'; exit 1; }
echo "$flags" | grep -q 'remote-debugging-pipe' || { echo 'FAIL: pipe flag not present'; exit 1; }
[ -z "$ports" ] || { echo 'FAIL: a chromium TCP listener appeared'; exit 1; }
rm -rf "$HOME/.local/share/pipe-browse/profiles/$profile" 2>/dev/null || true
echo 'PASS (snap): pipe transport confirmed, no listening debug port'

# --- second pass: the `open` verb (headed, indefinite-duration) -- the
# actual highest-risk window (a human sitting there typing a bank
# password/2FA while the browser is alive) is a DIFFERENT code path than
# `snap` (headless, seconds long). The `snap` pass above proves the claim
# for a short-lived headless launch; this proves it holds for the
# long-lived headed one too, not just asserts it by analogy.
open_profile="smoke-open-$$"
open_log="$(mktemp)"
node pipe-browse.mjs open "$open_profile" 'https://example.com' >"$open_log" 2>&1 &
open_pid=$!

open_flags=""; open_ports=""
for _ in $(seq 1 40); do
  f="$(pgrep -fl 'remote-debugging-pipe' 2>/dev/null | grep "profiles/$open_profile" || true)"
  [ -n "$f" ] && open_flags="$f" && break  # found it; no need to wait out the full loop
  kill -0 "$open_pid" 2>/dev/null || break
  sleep 0.25
done
for pid in $(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -iE 'chrom' | awk '{print $2}' | sort -u); do
  if ps -o command= -p "$pid" 2>/dev/null | grep -q "profiles/$open_profile"; then
    open_ports="$open_ports pid=$pid"
  fi
done
# `open` waits indefinitely for the user to close the window (by design --
# there's no auto-close for a real login flow); the smoke test isn't a real
# user, so it tears the process down once the port claim has been checked.
kill "$open_pid" 2>/dev/null || true
wait "$open_pid" 2>/dev/null || true

echo '--- open: flags seen ---'; echo "${open_flags:-<none>}"
echo '--- open: listeners seen (NEGATIVE CONTROL, must be empty) ---'; echo "${open_ports:-<none>}"
echo "$open_flags" | grep -q 'remote-debugging-pipe' || { echo 'FAIL: open verb pipe flag not present'; exit 1; }
[ -z "$open_ports" ] || { echo 'FAIL: open verb -- a chromium TCP listener appeared'; exit 1; }
rm -rf "$HOME/.local/share/pipe-browse/profiles/$open_profile" 2>/dev/null || true
echo 'PASS (open): pipe transport confirmed, no listening debug port'
