#!/usr/bin/env bash
# Runs the full dev loop: ensures the broker is running in the background
# and runs the TypeScript handler in watch mode.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

export MASIR_SOCKET="${MASIR_SOCKET:-/tmp/masir-dev.sock}"
export MASIR_DEV_HANDLER="${MASIR_DEV_HANDLER:-/tmp/masir-dev-handler.sock}"

echo "==> building transport broker"
cargo build --manifest-path native/Cargo.toml --bin masir-dev-broker

BROKER="native/target/debug/masir-dev-broker"
"$BROKER" &
BROKER_PID=$!
HANDLER_PID=""

cleanup() {
  kill "$BROKER_PID" 2>/dev/null || true
  [[ -n "$HANDLER_PID" ]] && kill "$HANDLER_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 100); do
  [[ -S "$MASIR_SOCKET" ]] && break
  sleep 0.05
done

echo
echo "  ==> Dev server is ready!"
echo "  Socket : $MASIR_SOCKET"
echo "  Watch  : src/handlers.ts (auto-reloads on save)"
echo "  Test   : In another terminal, run: pnpm req '{\"type\":\"ping\"}'"
echo

npx tsx watch src/handler.dev.ts &
HANDLER_PID=$!
wait