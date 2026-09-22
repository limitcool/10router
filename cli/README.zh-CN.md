# 10Router - 免费 AI 路由与 Token 节省器

**别让编码中断。用 RTK 节省 20-40% token，并自动回退到免费/廉价 AI 模型。**

**把所有 AI 编码工具（Claude Code、Cursor、Antigravity、Copilot、Codex、Gemini、OpenCode、Cline、OpenClaw…）接到 40+ 供应商、100+ 模型上。**

[![npm](https://img.shields.io/npm/v/@techysy/10router.svg)](https://www.npmjs.com/package/@techysy/10router)
[![Downloads](https://img.shields.io/npm/dm/@techysy/10router.svg)](https://www.npmjs.com/package/@techysy/10router)
[![GHCR](https://img.shields.io/badge/GHCR-techysy%2F10router-blue?logo=github)](https://github.com/techysy/10router/pkgs/container/10router)
[![License](https://img.shields.io/npm/l/@techysy/10router.svg)](https://github.com/techysy/10router/blob/main/LICENSE)

[English](https://github.com/techysy/10router/blob/main/cli/README.md) | **简体中文**

[📖 完整文档](https://github.com/techysy/10router)

---

## 🤔 为什么用 10Router？

**别再浪费钱、token 和额度：**

- ❌ 订阅额度每月用不完就作废
- ❌ 限流在编码中途打断你
- ❌ 工具输出（git diff、grep、ls…）疯狂烧 token
- ❌ API 太贵（每家每月 $20-50）

**10Router 的解法：**

- ✅ **RTK Token 节省器** — 自动压缩 tool_result，省 20-40% token
- ✅ **榨干订阅** — 跟踪配额，在重置前用尽每一点
- ✅ **自动回退** — 订阅 → 廉价 → 免费，零中断
- ✅ **多账号** — 同一供应商下多账号轮询
- ✅ **通用** — 兼容任何 OpenAI / Claude 协议的 CLI

---

## ⚡ 快速开始

**1. 安装** — 任选一种：

*npm（桌面推荐）：*

```bash
npm install -g @techysy/10router
10router

# 或直接用 npx 运行
npx @techysy/10router
```

> ⚠️ 包名是 **`@techysy/10router`**，不是 `10router` —— 后者在 npm 上是一个与本项目无关的 fork。

> ℹ️ **安装时看到 `npm warn install-scripts … @techysy/10router …`？** 安装本身是成功的。新版 npm 只对允许清单内的包执行安装脚本，被跳过的 `postinstall` 只是可选预热（把 SQLite / 托盘运行时预下载到 `~/.10router/runtime`）——首次运行 `10router` 会自动重做同样的预热，直接忽略警告即可。若想在安装时就预热：`npm i -g @techysy/10router --allow-scripts=@techysy/10router`，或永久放行：`npm config set allow-scripts=@techysy/10router --location=user`。（`--force` 对此无效——这是 npm 的脚本允许清单策略，不是依赖冲突。）

*Docker（服务器 / VPS）：*

```bash
docker run -d --name 10router -p 20128:20128 \
  -v "$HOME/.10router:/app/data" -e DATA_DIR=/app/data \
  ghcr.io/techysy/10router:latest
```

镜像地址：[GHCR](https://github.com/techysy/10router/pkgs/container/10router)（支持 amd64 / arm64）。

🎉 仪表盘会在 `http://localhost:20128` 打开

**2. 接入一个免费供应商（无需注册）：**

仪表盘 → Providers → 连接 **Kiro AI**（免费不限量 Claude）或 **OpenCode Free**（免认证）→ 完成！

**3. 在你的 CLI 工具里使用：**

```
Claude Code / Codex / OpenClaw / Cursor / Cline 设置：
  Endpoint: http://localhost:20128/v1
  API Key:  [从仪表盘复制]
  Model:    kr/claude-sonnet-4.5
```

搞定，开始用免费模型写代码。

---

## 🚀 CLI 参数

```bash
10router                    # 用默认配置启动
10router --port 8080        # 自定义端口
10router --no-browser       # 不自动打开浏览器
10router --skip-update      # 跳过更新检查
10router --tray             # 以系统托盘模式运行
10router --no-tray          # 不创建托盘图标（无桌面环境）
10router --help             # 查看全部参数
```

**仪表盘**：`http://localhost:20128/dashboard`

### 无桌面 / 后台常驻（nohup / systemd）

没有终端时，`10router` 会忽略 `SIGHUP`：关掉终端或退出登录不再把网关一起带走，因此后台启动能活过启动它的那个 shell。服务器、容器、systemd 单元这类没有桌面可画图标的环境，加上 `--no-tray` 可以省掉注定失败的托盘初始化；`--no-browser` 则跳过同样打不开的浏览器：

```bash
# shell 退出后继续运行
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

## 🩺 排查问题

`10router doctor` 检查当前安装并打印问题所在，全程不改动任何东西：

```bash
10router doctor                 # 人类可读报告
10router doctor --json          # 结构稳定，便于贴进工单或 CI
10router doctor --port 20129    # 检查其他端口
```

它会核对三处版本(启动器、磁盘标记、真正在服务的那个)、上次构建残留的服务、
实际用了哪个 SQLite 驱动、运行时依赖、端口、托盘、构建是否完整、数据目录。
不会安装、修复、重启或结束任何进程；只要确实有问题就以非 0 退出码结束，
因此放进 CI 或直接贴到 issue 里都是安全的。

> 标红是「事实」，不一定都要修：在源码目录里跑 `doctor`，而服务由已安装的构建
> 提供，就会报版本不一致 —— 因为它们确实是两份不同的构建。

---

## 🔄 更新

更新方式取决于你当初是怎么装的。npm 上有新版本时仪表盘会显示提示条：**npm 安装**显示「立即更新」按钮；**fnOS（fpk）安装**会被运行时自动识别（启动脚本注入 `INSTALL_CHANNEL=fpk`），提示条自动把 npm 按钮换成「Get the fpk from Releases」下载入口。

**npm** —— 用仪表盘按钮，或者：

```bash
npm i -g @techysy/10router@latest
```

**Docker** —— 拉新镜像并重建容器。数据在挂载卷里，不受影响：

```bash
docker pull ghcr.io/techysy/10router:latest
docker rm -f 10router
docker run -d --name 10router -p 20128:20128 \
  -v "$HOME/.10router:/app/data" -e DATA_DIR=/app/data \
  ghcr.io/techysy/10router:latest
```

**fnOS（fpk）** —— 从 [Releases](https://github.com/techysy/10router/releases) 下载新的 `.fpk`，通过飞牛应用中心安装。仪表盘提示条会直接指向对应版本的 release 标签。

**Standalone** —— 从 [Releases](https://github.com/techysy/10router/releases) 下载新的 `10router-server.tar.gz`，停止服务后覆盖解压到安装目录。

> ⚠️ **Docker / standalone 用户请勿点击「立即更新」。** 该按钮执行的是 `npm i -g @techysy/10router@latest` 并通过 `npx` 重新拉起，会在全局 npm 目录里装出**第二份**。原来那份仍跑着旧版本，两者互不知晓。fpk 安装已被自动识别并改用 Releases 下载入口；Docker 和 standalone 暂无安装来源判断，属于已知待办。

`~/.10router/` 中的数据在所有更新路径下都会保留，无需迁移操作。

---

## 🛠️ 支持的 CLI 工具

Claude-Code • OpenClaw • Codex • OpenCode • Cursor • Antigravity • Cline • Continue • Droid • Roo • Copilot • Kilo Code • Gemini CLI • Qwen Code • iFlow • Crush • Crusher • Aider

任何支持 OpenAI / Claude 协议的工具都可以用。

---

## 💾 数据位置

- **macOS/Linux**：`~/.10router/db/data.sqlite`
- **Windows**：`%APPDATA%/10router/db/data.sqlite`
- **Docker**：`/app/data/db/data.sqlite`（挂载 `$HOME/.10router` 以持久化）

---

## 📚 文档

完整文档、进阶配置与开发指南：

- **GitHub**：https://github.com/techysy/10router
- **完整 README**：https://github.com/techysy/10router/blob/main/README.md
- **更新日志**：https://github.com/techysy/10router/blob/main/CHANGELOG.md

---

## 🙏 致谢

- **[9Router](https://github.com/decolua/9router)** —— 本项目基于其优化的上游项目
- **[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)** —— 最初的 Go 实现

## 📄 License

MIT License，详见 [LICENSE](https://github.com/techysy/10router/blob/main/LICENSE)。
