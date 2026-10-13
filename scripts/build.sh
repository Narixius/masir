#!/usr/bin/env bash
# Compile the TypeScript into the native binary (dist/masir).
# Run scripts/build-native.sh first (or use `npm run build` / `npm run dev`).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ ! -f native/lib/libmasir_transport.a ]]; then
  echo "native/lib/libmasir_transport.a is missing; run scripts/build-native.sh first" >&2
  exit 1
fi

# ffi/masir.ffi.json is the macOS manifest. Linux has no frameworks and other
# system libraries, so its manifest is derived from it (same symbols and paths).
MANIFEST=ffi/masir.ffi.json
if [[ "$(uname -s)" == "Linux" ]]; then
  MANIFEST=ffi/masir.ffi.linux.json
  node -e '
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync("ffi/masir.ffi.json", "utf8"));
    delete manifest.frameworks;
    // What the Rust staticlib needs on linux-gnu (cargo --print native-static-libs).
    manifest.system_libraries = ["gcc_s", "util", "rt", "pthread", "m", "dl", "c"];
    fs.writeFileSync(process.argv[1], JSON.stringify(manifest, null, 2) + "\n");
  ' "$MANIFEST"
fi

mkdir -p dist
echo "==> scriptc build src/main.ts ($MANIFEST)"
pnpm exec scriptc build src/main.ts --ffi "$MANIFEST" --dynamic --strip --no-keep-llvm -o dist/masir
echo "==> dist/masir"
