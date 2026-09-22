# 10Router - FREE AI Router & Token Saver

**Never stop coding. Save 20-40% tokens with RTK + auto-fallback to FREE & cheap AI models.**

**Connect All AI Code Tools (Claude Code, Cursor, Antigravity, Copilot, Codex, Gemini, OpenCode, Cline, OpenClaw...) to 40+ AI Providers & 100+ Models.**

[![npm](https://img.shields.io/npm/v/@techysy/10router.svg)](https://www.npmjs.com/package/@techysy/10router)
[![Downloads](https://img.shields.io/npm/dm/@techysy/10router.svg)](https://www.npmjs.com/package/@techysy/10router)
[![GHCR](https://img.shields.io/badge/GHCR-techysy%2F10router-blue?logo=github)](https://github.com/techysy/10router/pkgs/container/10router)
[![License](https://img.shields.io/npm/l/@techysy/10router.svg)](https://github.com/techysy/10router/blob/main/LICENSE)

**English** | [简体中文](https://github.com/techysy/10router/blob/main/cli/README.zh-CN.md)

[📖 Full Docs](https://github.com/techysy/10router)

---

## 🤔 Why 10Router?

**Stop wasting money, tokens and hitting limits:**

- ❌ Subscription quota expires unused every month
- ❌ Rate limits stop you mid-coding
- ❌ Tool outputs (git diff, grep, ls...) burn tokens fast
- ❌ Expensive APIs ($20-50/month per provider)

**10Router solves this:**

- ✅ **RTK Token Saver** - Auto-compress tool_result, save 20-40% tokens
- ✅ **Maximize subscriptions** - Track quota, use every bit before reset
- ✅ **Auto fallback** - Subscription → Cheap → Free, zero downtime
- ✅ **Multi-account** - Round-robin between accounts per provider
- ✅ **Universal** - Works with any OpenAI/Claude-compatible CLI

---

## ⚡ Quick Start

**1. Install** — pick one:

*npm (recommended for desktop):*

```bash
npm install -g @techysy/10router
10router

# Or run directly with npx
npx @techysy/10router
```

> ⚠️ The package is **`@techysy/10router`**, not `10router` — that name belongs to an
> unrelated fork on npm.

> ℹ️ **Seeing `npm warn install-scripts … @techysy/10router …`?** The install still
> succeeded. Newer npm runs install scripts only for allow-listed packages, and the
> skipped `postinstall` is just an optional warm-up (SQLite/tray runtime into
> `~/.10router/runtime`) — `10router` re-runs the same warm-up on first start, so you
> can safely ignore the warning. To pre-warm at install time instead:
> `npm i -g @techysy/10router --allow-scripts=@techysy/10router`, or allow it
> permanently with `npm config set allow-scripts=@techysy/10router --location=user`.
> (`--force` does not change this — the skip is npm's script allow-list, not a conflict.)

*Docker (server/VPS):*

```bash
docker run -d --name 10router -p 20128:20128 \
  -v "$HOME/.10router:/app/data" -e DATA_DIR=/app/data \
  ghcr.io/techysy/10router:latest
```

Published images: [GHCR](https://github.com/techysy/10router/pkgs/container/10router) (multi-platform amd64/arm64).

🎉 Dashboard opens at `http://localhost:20128`

**2. Connect a FREE provider (no signup needed):**

Dashboard → Providers → Connect **Kiro AI** (free Claude unlimited) or **OpenCode Free** (no auth) → Done!

**3. Use in your CLI tool:**

```
Claude Code/Codex/OpenClaw/Cursor/Cline Settings:
  Endpoint: http://localhost:20128/v1
  API Key:  [copy from dashboard]
  Model:    kr/claude-sonnet-4.5
```

That's it! Start coding with FREE AI models.

---

## 🚀 CLI Options

```bash
10router                    # Start with default settings
10router --port 8080        # Custom port
10router --no-browser       # Don't open browser
10router --skip-update      # Skip auto-update check
10router --tray             # Run in the system tray
10router --no-tray          # Serve without a tray icon (headless)
10router --help             # Show all options
```

**Dashboard**: `http://localhost:20128/dashboard`

### Running headless (nohup / systemd)

With no terminal attached, `10router` ignores `SIGHUP`: closing the terminal or
logging out no longer takes the gateway down, so a background start survives the
shell that launched it. Add `--no-tray` when there is no desktop to draw an icon
on (a server, a container, a systemd unit) so the launcher does not spend startup
on a tray it cannot create; `--no-browser` skips the browser it also cannot open:

```bash
# keep serving after the shell exits
nohup 10router --no-tray --no-browser >~/.10router/10router.log 2>&1 &
```

```ini
# ~/.config/systemd/user/10router.service
[Unit]
Description=10Router gateway
After=network-online.target

[Service]
ExecStart=%h/.local/share/npm/bin/10router --no-tray --no-browser
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now 10router
```

---

## 🩺 Diagnosing problems

`10router doctor` inspects the installation and prints what is wrong, without
changing anything:

```bash
10router doctor                 # human-readable report
10router doctor --json          # stable schema, for a support ticket or CI
10router doctor --port 20129    # inspect a different port
```

It checks what versions you actually have (launcher, on-disk marker, and whatever
is serving), a server left over from a previous build, which SQLite driver won,
the runtime dependencies, the port, the tray, the build's completeness and the
data dir. It never installs, repairs, restarts or kills anything, and it exits
non-zero when something is genuinely broken — so it is safe to run in CI and safe
to paste into an issue.

> A red line is a fact, not always something to fix: running `doctor` from a
> source checkout while an installed build is serving reports a version mismatch,
> because those really are two different builds.

---

## 🔄 Updating

How you update depends on how you installed. The dashboard shows an update
banner when a newer version is on npm. **npm installs** get the "Update now"
button; **fnOS (fpk) installs** are detected at runtime (`INSTALL_CHANNEL=fpk`
from the launch script) and the banner automatically swaps the npm button for
a "Get the fpk from Releases" link.

**npm** — either use the dashboard button, or:

```bash
npm i -g @techysy/10router@latest
```

**Docker** — pull the new image and recreate the container. Your data lives in
the mounted volume and is not touched:

```bash
docker pull ghcr.io/techysy/10router:latest
docker rm -f 10router
docker run -d --name 10router -p 20128:20128 \
  -v "$HOME/.10router:/app/data" -e DATA_DIR=/app/data \
  ghcr.io/techysy/10router:latest
```

**fnOS (fpk)** — install the new `.fpk` from
[Releases](https://github.com/techysy/10router/releases) through the fnOS app
centre. The dashboard banner links straight to the matching release tag.

**Standalone** — download the new `10router-server.tar.gz` from
[Releases](https://github.com/techysy/10router/releases), stop the server, and
extract over the install directory.

> ⚠️ **Docker / standalone users: don't press "Update now".** It runs
> `npm i -g @techysy/10router@latest` and relaunches through `npx`, which installs a
> *second* copy into your global npm prefix. The original install keeps running
> the old version, and the two don't know about each other. fpk installs are
> detected automatically and shown the Releases link instead; Docker and
> standalone still have no install-source check (tracked as a known gap).

Data in `~/.10router/` survives every update path; no migration step is needed.

---

## 🛠️ Supported CLI Tools

Claude-Code • OpenClaw • Codex • OpenCode • Cursor • Antigravity • Cline • Continue • Droid • Roo • Copilot • Kilo Code • Gemini CLI • Qwen Code • iFlow • Crush • Crusher • Aider

Any tool supporting OpenAI/Claude-compatible API works.

---

## 💾 Data Location

- **macOS/Linux**: `~/.10router/db/data.sqlite`
- **Windows**: `%APPDATA%/10router/db/data.sqlite`
- **Docker**: `/app/data/db/data.sqlite` (mount `$HOME/.10router` to persist)

---

## 📚 Documentation

Full docs, advanced setup, video tutorials & development guide:

- **GitHub**: https://github.com/techysy/10router
- **Full README**: https://github.com/techysy/10router/blob/main/README.md
- **Changelog**: https://github.com/techysy/10router/blob/main/CHANGELOG.md

---

## 🙏 Acknowledgments

- **[9Router](https://github.com/decolua/9router)** - Upstream project this is an optimized fork of
- **[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)** - Original Go implementation

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.
