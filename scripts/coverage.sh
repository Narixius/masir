#!/usr/bin/env bash
# Report how much of the program compiles statically.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ ! -f native/lib/libmasir_transport.a ]]; then
  scripts/build-native.sh
fi

pnpm exec scriptc coverage src/main.ts --ffi ffi/masir.ffi.json --dynamic
