# Developing masir

masir is TypeScript compiled to a native binary with [scriptc](https://scriptc.dev). Rust libraries (`native/`) provide the parts TypeScript can't: the IPC socket, xray's gRPC client, terminal prompts, process listing and RTL text shaping. One binary is both the CLI and the background daemon.

## Workflow

```console
$ pnpm dev            # terminal 1: socket broker + the daemon handler, reloading on save
$ pnpm cli status     # terminal 2: run the CLI from source
$ pnpm check          # lint + format (pnpm fix applies fixes)
$ pnpm typecheck
$ pnpm build          # the real binary → dist/masir
```

`pnpm build` uses the scriptc fork at `~/Projects/scriptc` when it exists. Otherwise set `SCRIPTC_MAIN` to its `packages/cli/dist/main.js`, or `SCRIPTC` to a compiler binary.

**Always run `pnpm build` after non-trivial changes.** `tsc` accepts code that scriptc can't compile; see [scriptc constraints](#scriptc-constraints).

## How it fits together

```
masir <command> ──▶ Rust transport ──unix socket──▶ daemon (src/handlers.ts) ──▶ xray
```

- **CLI** (`src/commands/`): each command is a citty command. Commands talk to the daemon with `callHelper`. Work that doesn't need the daemon (storage, prompts) runs in the CLI.
- **Protocol** (`src/protocol.ts`): the request schema (zod), the response type for each request, and the envelope `{"ok":true,"result":…}` / `{"ok":false,"error":"…"}`. The CLI and the daemon share it, so it must not import daemon code.
- **Daemon** (`src/handlers.ts`): checks the caller, validates the request, and runs it. It owns the xray process (`services/xray.ts`) and rebuilds the config from the active proxy and rules (`services/config-manager.ts`, `services/run-xray.ts`).
- **State** (`services/subscription/`, `services/rules/`): JSON files in the data folder. The CLI and the daemon both write them, so every change holds a lock file and writes atomically (temp file + rename).
- **Latency** (`services/latency/`): tests run through a separate, short-lived test xray with one local port per proxy, so live traffic is never touched. The CLI only tests the rows on screen and polls for results.
- **Rules:** stored in xray's own rule shape. Pinned rules (`--via`) become a `node-<id>` outbound when the config is built (`services/rules/pins.ts`). Every change is validated with `xray run -test` before it's saved.

## scriptc constraints

scriptc compiles a subset of TypeScript statically. The code avoids these on purpose:

- String-literal types inside generics: they widen to `string`. That's why calls look like `callHelper<ResponseOf<"status">>({ type: "status" })`.
- Generic function types assigned to values, and `X | Promise<X>` unions.
- Spread arguments in calls, and spreads of zod-inferred objects.
- `RegExpExecArray.groups`, `Stats.mode`, `process.exitCode` (use `setExitCode`), and `spawnSync`'s `env` option (pass variables through `/usr/bin/env`).
- `.filter` with an `x is T` predicate, and `Promise.all` over a tuple of different types.
- Reading past the end of an array (use a `Map`).
- A function returning a narrower type than its slot declares: it compiles, then throws at runtime.
- xray-schema config types: scriptc treats them as dynamic, so code that also holds static values (a `ChildProcess`) uses plain JSON interfaces.
- JSON from Rust must omit missing fields rather than send `null` when the TypeScript type is `T | undefined`.

If something silently does nothing in the binary, log the error a `catch` is swallowing first.

## Protocol requests

| Request                                         | Does                                               |
| ----------------------------------------------- | -------------------------------------------------- |
| `ping`, `echo`, `info`, `status`                | Health and state                                   |
| `start {tun?, assetsPath?}`, `stop`, `shutdown` | Run xray / stop it / stop the daemon               |
| `sub:use {id, subName?}`, `sub:update {name?}`  | Switch proxy / refresh subscriptions               |
| `reload` (alias `sub:reload`)                   | Rebuild the config and restart a running xray      |
| `latency:probe {ids, refresh?}`, `net:diagnose` | Start tests and return a snapshot (poll to update) |
| `inbound:list`, `inbound:add`, `inbound:remove` | Pass-through to xray's gRPC API                    |

## Privileges and sockets

The daemon runs as your user. TUN mode needs root: `masir start --tun` restarts the daemon through `sudo`, and `masir daemon install` sets it up as a launchd/systemd service instead. A root daemon only serves the user it was started for.

The socket is `$TMPDIR/masir-<uid>.sock` on macOS, `/tmp/masir-<uid>/masir.sock` on Linux, or `/var/run/masir.sock` for a root daemon. `MASIR_SOCKET` overrides it; keep it under 104 bytes on macOS.

## Native code

`native/` is a Cargo workspace: `masir-transport` (IPC), `masir-xray-grpc` (xray API) and `masir-ffi` (prompts, BiDi text, process list, and the bundle of all three). `ffi/masir.ffi.json` declares the functions for scriptc. On Linux, `scripts/build.sh` derives a Linux manifest from it.

```console
$ cargo test --manifest-path native/Cargo.toml -p masir-ffi
```

## Releases

GitHub Actions (`.github/workflows/build.yml`) builds `darwin-arm64`, `darwin-x64`, `linux-x64-gnu` and `linux-arm64-gnu` on every push to `main`. Pushing a `v*` tag also attaches the four archives to a GitHub Release:

```console
$ git tag v0.2.0 && git push origin v0.2.0
```
