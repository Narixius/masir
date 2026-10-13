# masir

Your proxies, one command away. masir is a friendly command-line client for [xray-core](https://github.com/XTLS/Xray-core): add a subscription, pick a fast proxy, and choose which apps and sites use it, as a local proxy or system-wide (TUN).

## Install

Download the archive for your platform from [Releases](https://github.com/Narixius/masir/releases), unpack it, and put `masir` on your `PATH`:

```console
$ tar -xzf masir-darwin-arm64.tar.gz
$ sudo mv masir /usr/local/bin/
```

Builds are available for macOS (`darwin-arm64`, `darwin-x64`) and Linux (`linux-x64-gnu`, `linux-arm64-gnu`).

masir runs xray for you. [Install xray](https://github.com/XTLS/Xray-core/releases) and masir finds it, along with its `geoip.dat` and `geosite.dat`, in the usual places. It checks these in order:

| Where | macOS | Linux |
| --- | --- | --- |
| masir's own folder (`xray` and the `.dat` files) | `~/Library/Application Support/masir/xray/` | `~/.local/share/masir/xray/` |
| Standard installs | `/opt/homebrew/bin`, `/usr/local/bin` (`…/share/xray`) | `/usr/local/bin`, `/usr/bin` (`…/share/xray`) |
| Your `PATH` | `xray`, with the `.dat` files next to it | same |

Anywhere else: `masir settings set xrayExecutable /path/to/xray` and `masir settings set xrayAssetsPath /path/to/xray-assets`.

## Quick start

```console
$ masir sub add https://example.com/sub    # add a subscription
$ masir use                                # pick a proxy (latency shows live)
$ masir connect                            # routes the whole system (TUN mode)
$ masir status                             # is everything working?
$ masir disconnect
```

TUN mode routes the whole system by default. It asks for your password; run `masir daemon enable` once and it won't ask again. Prefer local proxy only (HTTP and SOCKS5 on `127.0.0.1:7890`)? Run `masir connect -p` (or `--proxy`).

Run `masir use --fastest` to connect to the fastest config.

## Everyday commands

| Command                        | What it does                                                 |
| ------------------------------ | ------------------------------------------------------------ |
| `masir connect` / `disconnect` | Start or stop (default TUN; `-p` for proxy-only)             |
| `masir use [--fastest]`        | Switch the active proxy                                      |
| `masir mode [proxy\|direct]`   | What happens to traffic no rule matches                      |
| `masir status`                 | Daemon, xray and a connectivity check (`--json` for scripts) |
| `masir logs`                   | Follow xray's log                                            |
| `masir get-config`             | Print the xray config masir generated                        |
| `masir update`                 | Update the masir binary (or `masir update xray-core`)        |

## Subscriptions

```console
$ masir sub add <url>      # named after its domain; --name to choose
$ masir sub ls             # traffic used and expiry
$ masir sub update         # refresh now (masir also does it in the background)
$ masir sub rm [name...]
```

`sub` is also `subs` or `subscription`.

## Rules

Rules decide where traffic goes: through the proxy (`proxy`), around it (`direct`), or nowhere (`block`). They're checked top to bottom and the first match wins. Anything no rule matches follows `masir mode`.

Just run `masir rules add` and answer the prompts. Pickers filter as you type, and you can enter your own values too. You can match websites (readable geosite categories), IPs and countries, apps (with all their helper processes), ports, network and protocol.

Or skip the prompts. A name is picked for you:

```console
$ masir rules add          # build the rule interactively
$ masir rules add --app    # opens a picker to choose an app
$ masir rules add --domain geosite:category-ir --ip geoip:ir -o direct
$ masir rules add --domain corp.example.com --via 0435aba7    # pin to one proxy
$ masir rules add --json '{"domain":["geosite:google"],"outboundTag":"proxy"}'
```

Add `--name` only if you want your own. Then manage them:

```console
$ masir rules ls                        # list
$ masir rules edit [name]               # a menu, or flags
$ masir rules edit iran --append --domain keyword:digikala
$ masir rules rm [name...]
$ masir rules test youtube.com          # which rule applies, and where it goes
```

Leave out the name on `edit` and `rm` and you get a picker. `rules test` also takes `--port`, `--network`, `--process` and `--protocol` to try a specific connection.

masir checks every rule with `xray run -test` before saving, and a running xray picks changes up right away. `--json` accepts any [xray rule object](https://xtls.github.io/config/routing.html#ruleobject).

## Configuration

| What                             | macOS                                     | Linux                         |
| -------------------------------- | ----------------------------------------- | ----------------------------- |
| Settings                         | `~/Library/Preferences/masir/config.json` | `~/.config/masir/config.json` |
| Subscriptions and rules          | `~/Library/Application Support/masir/`    | `~/.local/share/masir/`       |
| Logs (`masir logs` tails xray's) | `~/Library/Logs/masir/`                   | `~/.local/state/masir/`       |

Change settings with `masir settings`. In a terminal it opens a menu; for scripts there's `masir settings set mixedPort 9090`, plus `get`, `reset` and `ls`. Values are checked before they're saved, and a running xray picks the change up.

Settings (all optional):

| Key                        | Default                     | Meaning                                   |
| -------------------------- | --------------------------- | ----------------------------------------- |
| `routingMode`              | `proxy`                     | Catch-all for traffic no rule matches     |
| `mixedPort`                | `7890`                      | Local HTTP + SOCKS5 proxy port            |
| `apiPort`                  | `10085`                     | xray's gRPC API port                      |
| `dohDns`                   | `https://1.1.1.1/dns-query` | DNS-over-HTTPS server                     |
| `dnsServers`               | `["1.1.1.1", "8.8.8.8"]`    | DNS servers (used for bootstrap)          |
| `tunDns`                   | falls back to `dnsServers`  | DNS servers in TUN mode                   |
| `gateway`                  | `10.10.20.1/24`             | TUN interface address                     |
| `subUpdateIntervalMinutes` | `60`                        | How often subscriptions refresh           |
| `xrayExecutable`           | found automatically         | Path to the xray binary                   |
| `xrayAssetsPath`           | found automatically         | Folder with `geoip.dat` and `geosite.dat` |

Environment variables:

- `XRAY_EXECUTABLE` and `XRAY_LOCATION_ASSET` override the two xray settings above.
- `MASIR_BIDI=on|off` controls reordering of right-to-left text (Persian, Arabic, Hebrew). By default masir reorders it only in terminals that don't do so themselves.

## Shell completion

Tab-complete commands, rules and flags. Add the line for your shell, then restart it:

```console
$ echo 'source <(masir complete zsh)' >> ~/.zshrc                      # zsh
$ echo 'source <(masir complete bash)' >> ~/.bashrc                    # bash
$ masir complete fish > ~/.config/fish/completions/masir.fish          # fish
$ masir complete powershell >> $PROFILE                                # PowerShell
```

## Build from source

You need Node.js 24, pnpm and Rust. [scriptc](https://github.com/vercel-labs/scriptc) is a project dependency, so there is nothing else to install.

```console
$ pnpm install
$ pnpm build    # → dist/masir
```

To work on masir, see [docs/development.md](docs/development.md).
