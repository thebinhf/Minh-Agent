#!/usr/bin/env bash
# One install (caller). Typecheck and test in parallel.
# Paper-only. No keys. No daemon.
set -uo pipefail

tc_log="$(mktemp)"
bun run typecheck >"$tc_log" 2>&1 &
tc_pid=$!
test_status=0
bun test || test_status=$?
wait "$tc_pid"
tc_status=$?
cat "$tc_log"
rm -f "$tc_log"
if [[ "$tc_status" -ne 0 ]]; then
  echo "typecheck failed" >&2
  exit "$tc_status"
fi
exit "$test_status"
