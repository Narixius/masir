# masir

A command-line client for [xray-core](https://github.com/XTLS/Xray-core). Add your proxy subscriptions, pick a fast proxy, and decide which apps and sites use it, either as a local proxy or system-wide (TUN).

## Install

Download the archive for your platform from [Releases](https://github.com/Narixius/masir/releases), unpack it, and put `masir` on your `PATH`:

```console
$ tar -xzf masir-darwin-arm64.tar.gz
$ sudo mv masir /usr/local/bin/
```

Builds are available for macOS (`darwin-arm64`, `darwin-x64`) and Linux (`linux-x64-gnu`, `linux-arm64-gnu`).

masir runs xray for you. [Install xray](https://github.com/XTLS/Xray-core/releases) and make sure `xray` is on your `PATH`, or set `XRAY_EXECUTABLE`.

## Quick start

```console
$ masir sub add --name work https://example.com/sub    # add a subscription
$ masir sub use                                        # pick a proxy (latency shows live)
$ masir start                                          # local proxy on 127.0.0.1:8083
$ masir status                                         # daemon, xray, and a connectivity check
$ masir stop
```

`127.0.0.1:8083` accepts both HTTP and SOCKS5. To route the whole system instead, run `masir start --tun`. It asks for your password; run `masir daemon install` once to skip that from then on.

## Subscriptions

| Command                             | What it does                                                      |
| ----------------------------------- | ----------------------------------------------------------------- |
| `masir sub add --name <name> <url>` | Add a subscription and choose a proxy from it                     |
| `masir sub use [id]`                | Switch the active proxy (grouped by subscription, type to filter) |
| `masir sub list`                    | Subscriptions with traffic used and expiry                        |
| `masir sub update [--name <name>]`  | Refresh now (masir also refreshes in the background)              |
| `masir sub rm [name...]`            | Remove subscriptions                                              |

## Rules

Rules decide where traffic goes: through the active proxy (`proxy`), around it (`direct`), or nowhere (`block`). They are checked top to bottom, and the first match wins.

```console
$ masir rules add --name iran --domain geosite:category-ir --ip geoip:ir -o direct
$ masir rules add --name chrome --app "Google Chrome" -o direct
$ masir rules add --name work --domain corp.example.com --via 0435aba7
$ masir rules list
$ masir rules edit iran --append --domain keyword:digikala
$ masir rules rm chrome
```

- **Match by domain** (`google.com`, `geosite:`, `domain:`, `full:`, `regexp:`, `keyword:`), **IP** (address, CIDR, `geoip:`), `--port`, `--network`, `--protocol`, `--source`, `--process` or `--app`. Flags can be repeated. `--json` takes any [xray rule object](https://xtls.github.io/config/routing.html#ruleobject).
- **Apps:** `--app` with no name opens a picker. masir matches the app together with all of its helper processes, and offers to include programs the app started from elsewhere.
- **Pin to one proxy:** `--via <id>`, or choose "a specific proxy…" when asked. If that proxy disappears from your subscriptions, the rule falls back to the active proxy.
- **Edit:** a flag replaces that field, `--append` adds to it, and `--unset` removes it. `masir rules edit <name>` with no flags opens the rule in your editor.
- **Safe to change:** masir checks every change with `xray run -test` before saving it, and a running xray picks it up right away.

## Configuration

| What                             | macOS                                     | Linux                         |
| -------------------------------- | ----------------------------------------- | ----------------------------- |
| Settings                         | `~/Library/Preferences/masir/config.json` | `~/.config/masir/config.json` |
| Subscriptions and rules          | `~/Library/Application Support/masir/`    | `~/.local/share/masir/`       |
| Logs (`masir logs` tails xray's) | `~/Library/Logs/masir/`                   | `~/.local/state/masir/`       |

Settings in `config.json` (all optional):

| Key                        | Default                  | Meaning                                   |
| -------------------------- | ------------------------ | ----------------------------------------- |
| `mixedPort`                | `8083`                   | Local HTTP + SOCKS5 proxy port            |
| `apiPort`                  | `10085`                  | xray's gRPC API port                      |
| `dnsServers`               | `["1.1.1.1", "8.8.8.8"]` | DNS servers in TUN mode                   |
| `gateway`                  | `"10.10.20.1/24"`        | TUN interface address                     |
| `subUpdateIntervalMinutes` | `720`                    | How often subscriptions refresh           |
| `xrayExecutable`           | `xray`                   | Path to the xray binary                   |
| `xrayAssetsPath`           | found automatically      | Folder with `geoip.dat` and `geosite.dat` |

Environment variables:

- `XRAY_EXECUTABLE` and `XRAY_LOCATION_ASSET` override the two xray settings above.
- `MASIR_SOCKET` sets the daemon's socket path.
- `MASIR_BIDI=on|off` controls reordering of right-to-left text (Persian, Arabic, Hebrew). By default masir reorders it only in terminals that don't do so themselves.

## Build from source

You need Node.js 24, pnpm, Rust, and the [scriptc fork](https://github.com/Narixius/scriptc) that masir compiles with. The exact commit is pinned in [`.github/workflows/build.yml`](.github/workflows/build.yml).

```console
$ pnpm install
$ SCRIPTC_MAIN=/path/to/scriptc/packages/cli/dist/main.js pnpm build    # → dist/masir
```

To work on masir, see [docs/development.md](docs/development.md).
