#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROTO_DIR="${ROOT_DIR}/native/masir-xray-grpc/proto"
OUT_DIR="${ROOT_DIR}/src/injectables/xray/proto"
PLUGIN="${ROOT_DIR}/node_modules/.bin/protoc-gen-ts_proto"

echo "==> Generating TypeScript types from Xray protos..."

if ! command -v protoc >/dev/null 2>&1; then
  echo "Error: protoc is required to generate proto types." >&2
  exit 1
fi

if [ ! -f "${PLUGIN}" ]; then
  echo "Error: ts-proto plugin not found at ${PLUGIN}. Run 'pnpm install' first." >&2
  exit 1
fi

rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}"

(
  cd "${PROTO_DIR}"
  find . -name "*.proto" | xargs protoc \
    --plugin="${PLUGIN}" \
    --ts_proto_out="${OUT_DIR}" \
    --ts_proto_opt=onlyTypes=true,importSuffix=.js,useExactTypes=false,stringEnums=true,outputServices=false,outputIndex=true \
    -I .
)

echo "==> Formatting generated files with oxfmt..."
pnpm exec oxfmt --write "${OUT_DIR}" >/dev/null 2>&1 || true

echo "==> Successfully generated types in src/xray/proto"
