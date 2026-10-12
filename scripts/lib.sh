#!/usr/bin/env bash
# Shared compiler invocation.
#
# The CLI uses `citty` and builds with `--dynamic` (citty runs in the
# embedded dynamic island; the program's own TypeScript stays static). The
# scriptc fork at ~/Projects/scriptc carries the fixes citty's parser needs
# (class-expression `instanceof`, Proxy assignment without a set trap).
# Point SCRIPTC_MAIN at its packages/cli/dist/main.js, or SCRIPTC at an
# installed compiler binary.
run_scriptc() {
  local scriptc_main="${SCRIPTC_MAIN:-}"
  if [[ -z "$scriptc_main" && -f "$HOME/Projects/scriptc/packages/cli/dist/main.js" ]]; then
    scriptc_main="$HOME/Projects/scriptc/packages/cli/dist/main.js"
  fi

  if [[ -n "$scriptc_main" ]]; then
    node "$scriptc_main" "$@"
  else
    "${SCRIPTC:-scriptc}" "$@"
  fi
}