#!/usr/bin/env bash
# Build the Rust native shim into native/lib/libmasir_transport.a (and libmasir_core.a).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PROFILE="${PROFILE:-release}"
case "$PROFILE" in
  debug)   CARGO_ARGS=();          OUT_DIR=debug ;;
  release) CARGO_ARGS=(--release); OUT_DIR=release ;;
  *) echo "PROFILE must be debug or release (got: $PROFILE)" >&2; exit 1 ;;
esac

echo "==> cargo build ($PROFILE)"
cargo build --manifest-path native/Cargo.toml --package masir-ffi "${CARGO_ARGS[@]}"

mkdir -p native/lib
cp "native/target/$OUT_DIR/libmasir_ffi.a" native/lib/libmasir_ffi.a
cp "native/target/$OUT_DIR/libmasir_ffi.a" native/lib/libmasir_transport.a
echo "==> native/lib/libmasir_ffi.a ($PROFILE)"