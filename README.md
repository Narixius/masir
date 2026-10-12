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
$ masir rules add             # build a rule step by step
$ masir rules list
$ masir rules edit <name>     # change any part from a menu
$ masir rules rm <name>
```

`masir rules add` asks what the rule should match, then gives you a picker for each choice. Pickers filter as you type, and you can also type your own values:

- **Websites:** geosite categories with readable names, such as 🇮🇷 Iranian Websites (`geosite:category-ir`) or AI (not China), or your own domains.
- **IP addresses:** countries, private networks, or your own IPs and ranges.
- **Apps:** an app together with all of its helper processes and data folders.
- **Ports, network, protocol:** common choices, or your own.

You then choose where the traffic goes; "a specific proxy…" pins the rule to one proxy and falls back to the active proxy if that proxy disappears. Review it and save: new rules go to the end of the list, and `masir rules edit` can move them. masir checks the rule with `xray run -test` before saving, and a running xray picks it up right away.

Every step also has a flag, for scripts:

```console
$ masir rules add --name iran --domain geosite:category-ir --ip geoip:ir -o direct
$ masir rules add --name chrome --app "Google Chrome" -o direct
$ masir rules add --name work --domain corp.example.com --via 0435aba7
$ masir rules edit iran --append --domain keyword:digikala
```

`--json` takes any [xray rule object](https://xtls.github.io/config/routing.html#ruleobject).

## Configuration

| What                             | macOS                                     | Linux                         |
| -------------------------------- | ----------------------------------------- | ----------------------------- |
| Settings                         | `~/Library/Preferences/masir/config.json` | `~/.config/masir/config.json` |
| Subscriptions and rules          | `~/Library/Application Support/masir/`    | `~/.local/share/masir/`       |
| Logs (`masir logs` tails xray's) | `~/Library/Logs/masir/`                   | `~/.local/state/masir/`       |

Change settings with `masir settings`. In a terminal it opens a menu; for scripts there's `masir settings set mixedPort 9090`, plus `get`, `reset` and `list`. Values are checked before they're saved, and a running xray picks the change up.

Settings (all optional):

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
