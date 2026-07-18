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
  p="$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -iE 'chrom' || true)"
  [ -n "$p" ] && ports="$p"
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
echo 'PASS: pipe transport confirmed, no listening debug port'
