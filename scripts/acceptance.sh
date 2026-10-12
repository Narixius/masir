#!/usr/bin/env bash
# Acceptance tests for the masir-ts IPC layer.
#
#   scripts/acceptance.sh
#
# Env:
#   SOAK_N   sequential request count for the soak test (default 5000)
#   SOAK_C   concurrent request count (default 50)
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

BIN=./dist/masir
SOCK=/tmp/masir-test.sock
export MASIR_SOCKET="$SOCK"
UID_ME="$(id -u)"
PASS=0
FAIL=0
HELPER_PID=""

pass() { PASS=$((PASS + 1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }

cleanup() {
  [[ -n "$HELPER_PID" ]] && kill "$HELPER_PID" 2>/dev/null && wait "$HELPER_PID" 2>/dev/null
}
trap cleanup EXIT

start_helper() {
  rm -f "$SOCK"
  "$BIN" helper >/tmp/masir-helper.out 2>&1 &
  HELPER_PID=$!
  for _ in $(seq 1 100); do
    [[ -S "$SOCK" ]] && return 0
    sleep 0.05
  done
  return 1
}

request() { "$BIN" request "$1"; }

[[ -x "$BIN" ]] || { echo "missing $BIN; run: npm run build" >&2; exit 1; }

echo "== starting helper (uid $UID_ME, socket $SOCK)"
start_helper || { echo "helper did not bind"; cat /tmp/masir-helper.out; exit 1; }

echo "== basic protocol"
OUT="$(request '{"type":"ping"}')"; RC=$?
[[ "$OUT" == '{"ok":true,"result":"pong"}' && $RC -eq 0 ]] && pass "ping -> pong (exit 0)" || fail "ping: rc=$RC out=$OUT"

OUT="$(request '{"type":"echo","data":"hi"}')"; RC=$?
[[ "$OUT" == '{"ok":true,"result":"hi"}' && $RC -eq 0 ]] && pass "echo (exit 0)" || fail "echo: rc=$RC out=$OUT"

OUT="$(request 'not json')"; RC=$?
[[ "$OUT" == '{"ok":false,"error":"invalid json"}' && $RC -eq 1 ]] && pass "invalid json -> ok:false (exit 1)" || fail "invalid json: rc=$RC out=$OUT"

OUT="$(request '{"type":"nope"}')"; RC=$?
[[ "$OUT" == '{"ok":false,"error":"unknown request type"}' && $RC -eq 1 ]] && pass "unknown type -> ok:false (exit 1)" || fail "unknown: rc=$RC out=$OUT"

echo "== peer uid / euid / pid"
INFO="$(request '{"type":"info"}')"
read -r PEER EUID_ HPID_ <<<"$(printf '%s' "$INFO" | node -e '
let data = "";
process.stdin.on("data", c => data += c);
process.stdin.on("end", () => {
  const r = JSON.parse(data).result;
  console.log(r.peerUid, r.helperEuid, r.helperPid);
});
')"
[[ "$PEER" == "$UID_ME" ]] && pass "info.peerUid == my uid ($PEER)" || fail "peerUid=$PEER want $UID_ME"
[[ "$EUID_" == "$UID_ME" ]] && pass "info.helperEuid == my uid (non-root run)" || fail "helperEuid=$EUID_ want $UID_ME"
[[ "$HPID_" == "$HELPER_PID" ]] && pass "info.helperPid == helper pid" || fail "helperPid=$HPID_ want $HELPER_PID"

echo "== oversize request line (70 KiB)"
BIG="$(node -e 'process.stdout.write("x".repeat(70000))')"
OUT="$(request "$BIG")"; RC=$?
if [[ "$OUT" == '{"ok":false,"error":"bad request"}' && $RC -eq 1 ]]; then
  pass "70 KiB line -> bad request (exit 1)"
elif [[ $RC -eq 2 ]]; then
  fail "70 KiB line -> transport error (client EPIPE race; check helper health below)"
else
  fail "70 KiB line: rc=$RC out=${OUT:0:60}"
fi
kill -0 "$HELPER_PID" 2>/dev/null && pass "helper alive after oversize" || fail "helper died after oversize"

echo "== idle client (sends nothing), expect server close by timeout"
node - "$SOCK" <<'JS'
import { connect } from "node:net";
const socket = connect(process.argv[2]);
socket.setTimeout(20000, () => {
  console.log("TIMEOUT");
  process.exit(1);
});
socket.on("data", () => {
  console.log("DATA");
  process.exit(0);
});
socket.on("end", () => {
  console.log("CLOSED");
  process.exit(0);
});
socket.on("error", (err) => {
  console.error("socket error", err);
  process.exit(1);
});
JS
OUT="$(request '{"type":"ping"}')"
[[ "$OUT" == '{"ok":true,"result":"pong"}' ]] && pass "helper serves after idle client closed" || fail "helper unhealthy after idle client: $OUT"

echo "== restart after kill -9 (stale socket)"
kill -9 "$HELPER_PID" 2>/dev/null
wait "$HELPER_PID" 2>/dev/null
[[ -S "$SOCK" ]] && echo "  (stale socket left behind, as expected)"
start_helper || fail "restart did not bind"
OUT="$(request '{"type":"ping"}')"
[[ "$OUT" == '{"ok":true,"result":"pong"}' ]] && pass "restart removes stale socket and serves" || fail "restart: $OUT"

echo "== soak: ${SOAK_N:-5000} sequential + ${SOAK_C:-50} concurrent"
RSS_BEFORE="$(ps -o rss= -p "$HELPER_PID" | tr -d ' ')"
SEQ_FAIL=0
for _ in $(seq 1 "${SOAK_N:-5000}"); do
  "$BIN" request '{"type":"ping"}' >/dev/null 2>&1 || SEQ_FAIL=$((SEQ_FAIL + 1))
done
[[ $SEQ_FAIL -eq 0 ]] && pass "${SOAK_N:-5000} sequential requests all succeeded" || fail "$SEQ_FAIL sequential requests failed"

FAIL_FILE="$(mktemp)"
CONC_PIDS=()
for _ in $(seq 1 "${SOAK_C:-50}"); do
  ( "$BIN" request '{"type":"ping"}' >/dev/null 2>&1 || echo x >>"$FAIL_FILE" ) &
  CONC_PIDS+=("$!")
done
# Wait only for the concurrent clients; the helper daemon runs forever.
for pid in "${CONC_PIDS[@]}"; do wait "$pid" 2>/dev/null; done
CONC_FAIL=$(wc -l <"$FAIL_FILE" | tr -d ' '); rm -f "$FAIL_FILE"
[[ "$CONC_FAIL" -eq 0 ]] && pass "${SOAK_C:-50} concurrent requests all succeeded" || fail "$CONC_FAIL concurrent requests failed"

RSS_AFTER="$(ps -o rss= -p "$HELPER_PID" | tr -d ' ')"
DELTA=$((RSS_AFTER - RSS_BEFORE))
echo "  helper RSS: before=${RSS_BEFORE}KB after=${RSS_AFTER}KB delta=${DELTA}KB"
LIMIT=8192
[[ $DELTA -lt $LIMIT ]] && pass "RSS growth < ${LIMIT}KB across soak" || fail "RSS grew ${DELTA}KB"

echo
echo "== summary: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
