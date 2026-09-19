<div align="center">

<img width="3818" height="1901" alt="image" src="https://github.com/user-attachments/assets/790507c7-68be-4111-a907-32ca6303f141" />

# 🚀 10Router

[![10Router](https://img.shields.io/badge/10Router-v1.1.3-orange.svg)](https://github.com/techysy/10router/releases)
[![Downloads](https://img.shields.io/github/downloads/techysy/10router/total?label=Downloads&color=green)](https://github.com/techysy/10router/releases)
[![Docker](https://img.shields.io/badge/Docker-ghcr.io%2Ftechysy%2F10router-blue?logo=docker)](https://github.com/techysy/10router/pkgs/container/10router)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/techysy/10router?style=flat&logo=github)](https://github.com/techysy/10router/stargazers)

基于 [decolua/9router](https://github.com/decolua/9router) v0.5.55 的本地优化快照

**✨ 单一 commit 历史，无上游提交污染；上游新功能一律学习后自行重写。**

</div>

---

## 📖 简介

10Router 是 [9Router](https://github.com/decolua/9router) 的精简优化版本。在上游 v0.5.55 基础上合并了若干本地验证过的修复，排除未完成的实验性功能，保持干净的 git 历史便于持续同步上游。

```
┌─────────────┐
│  Your CLI   │  Claude Code · Codex · Cursor · Cline · OpenCode ...
│   Tool      │
└──────┬──────┘
       │ http://localhost:20128/v1
       ↓
┌─────────────────────────────────────────┐
│            10Router (Smart Router)       │
│  • RTK Token Saver (cut tool_result)    │
│  • Format translation (OpenAI ↔ Claude) │
│  • Quota tracking                       │
│  • Auto fallback & token refresh        │
│  • Regional currency display            │
└──────────┬──────────────────────────────┘
           ↓
┌──────────────────────────────────────────┐
│     85+ Providers · 1000+ Models         │
│  Free ──→ Cheap ──→ Subscription         │
└──────────────────────────────────────────┘
```

## 🧾 版本历程

| 版本 | 核心要点 |
|------|----------|
| **v1.1.3** | Qoder 国内版完整恢复；Qoder 每日 Credits 自动领取（实验开关）；资源包逐包展示与到期；配额文案对齐官网；CodeBuddy intl DeepSeek reasoning_effort 修复（#23） |
| **v1.1.2** | 用量仪表盘（热力图 / 节点健康度 / 生涯统计）；CodeBuddy 11128 渠道级熔断；Cline/ClinePass 凭据自动刷新修复；小米 Token Plan 出口节点匹配 |
| **v1.1.1** | 跨账号「配额包到期优先」调度；Command Code 配额追踪；全供应商 OAuth 加密导出/导入；用量国际化与官方图标补齐 |
| **v1.1.0** | 小米 MiMo 桌面版（Desktop 专属模型与会话）；opencode-go 供应商；Codex 图片工具化；Windows 数据目录迁移 |
| **v1.0.6 – v1.0.8** | ZCode 用量同步；桌面单色托盘与 Web 安装器；CodeBuddy 每日自动签到；仪表盘与模型端点多语言 |
| **v1.0.0 – v1.0.5** | 桌面托盘版（Win / macOS）；多币种配额追踪与连接隔离；三层 SSRF 防护与安全加固；85+ 供应商模型生态扩充 |

👉 完整开发日志见 **[CHANGELOG.md](CHANGELOG.md)**；本地打包发版流程见 [cli/PACKAGING.md](cli/PACKAGING.md)。

## 🚀 快速开始

### 💻 npm 全局安装（桌面推荐）

```bash
npm i -g @techysy/10router
10router
```

装完后可执行命令是 `10router`，仪表盘默认在 `http://localhost:20128`。

> ⚠️ 包名是 **`@techysy/10router`**，不是 `10router` —— 后者是 npm 上一个与本项目无关的 fork。

> ℹ️ **npm 11+ 的 `allow-scripts` 提示**：新版本 npm 会拦截本包的 `postinstall` 脚本并警告
> `Run npm install -g --allow-scripts=@techysy/10router to allow these scripts once...`。
> **这是可选的，不影响使用**——该脚本只是把 SQLite 引擎「预暖」到 `~/.10router/runtime`，
> 跳过它首次启动时会自动补装。想消除提示：
>
> ```bash
> npm install -g --allow-scripts=@techysy/10router
> # 或永久允许：
> npm config set allow-scripts=@techysy/10router --location=user
> ```

### 🐳 Docker 部署

```bash
docker pull ghcr.io/techysy/10router:latest
docker run -d \
  --name 10router \
  -p 20128:20128 \
  -v ~/.10router:/app/data \
  ghcr.io/techysy/10router:latest
```

支持 `linux/amd64` 和 `linux/arm64`。

### 📦 fnOS fpk 安装

从 [Releases](https://github.com/techysy/10router/releases) 下载对应架构的 `.fpk` 文件：

| 文件 | 说明 |
|------|------|
| `10router-<版本>-x86.fpk` | x86 URL 版 |
| `10router-<版本>-iframe-x86.fpk` | x86 IFRAME 版 |
| `10router-<版本>-arm.fpk` | ARM URL 版 |
| `10router-<版本>-iframe-arm.fpk` | ARM IFRAME 版 |

安装：App Center → 手动安装 → 选择 fpk。

### 💻 Standalone Server

```bash
tar xzf 10router-server.tar.gz -C /opt/10router
cd /opt/10router
node custom-server.js --port 20128
```

### 🛠 源码开发

```bash
git clone https://github.com/techysy/10router.git
cd 10router
cp .env.example .env
npm install
PORT=20128 npm run dev        # 开发模式
```

生产部署：

```bash
npm run build
PORT=20128 HOSTNAME=0.0.0.0 npm run start
```

- Dashboard: `http://localhost:20128/dashboard`
- API endpoint: `http://localhost:20128/v1`
- 初始密码: `123456`（登录后请修改）

## 🔌 用量同步插件（10router-sync）

10Router 附带一个**用量同步插件**（`zcode-plugin/`，插件名 `10router-sync`），把本机 AI 编码工具的调用用量一键导入 10Router 统计——幂等可重复执行，自动防双重计数。

支持 **5 个数据源**：

| 数据源 | `--source` | 读取位置 |
|--------|-----------|----------|
| ZCode | `zcode`（默认） | `~/.zcode/cli/db/db.sqlite` |
| OpenCode | `opencode` | `~/.local/share/opencode/opencode.db` |
| mirasim | `mirasim` | `~/.mirasim/insights/usage-*.ndjson` |
| 小米 MiMo | `mimo` | `~/.local/share/mimocode/mimocode.db` |
| 10Router/9Router 实例 | `10r` | 另一个实例的 `data.sqlite` |

还提供 **`/10router-sync:status`** 命令：不打开仪表盘，一条命令查看目标 10Router 实例的运行状态（渠道熔断 / 账号健康 / 今日用量）。

### 安装

ZCode → Settings → Plugin Management → Discover 页 → 点 `+` 添加市场，填 GitHub 仓库 `techysy/10router` → 找到 **10router-sync** 点 Get 安装。

### 使用

```bash
# 同步 ZCode 用量（默认）
node scripts/export-usage.mjs --endpoint http://127.0.0.1:20127 --key sk-…

# 同步 OpenCode / mirasim / MiMo / 10r 实例
node scripts/export-usage.mjs --source opencode --endpoint <URL> --key sk-…
node scripts/export-usage.mjs --source mirasim --endpoint <URL> --key sk-…
node scripts/export-usage.mjs --source mimo --endpoint <URL> --key sk-…
node scripts/export-usage.mjs --source 10r --endpoint <URL> --key sk-…

# 查看实例状态
node scripts/status.mjs --endpoint <URL> --password <面板密码>
```

离线模式：本机 `--export usage.json` 导出，带到能连通的机器 `--import` 灌回。

详见 [zcode-plugin/README.md](zcode-plugin/README.md)。

## 🔄 同步上游

上游新增功能时，**先学习、再自己写**：阅读上游对应实现理解思路，然后在本仓库用自己的代码和提交重写，移植后跑 `npx vitest run` + 三条 registry 基线确认无回归，并在 CHANGELOG.md 记录。

> ⚠️ 不要直接 merge / cherry-pick 上游分支，也不要用 tarball 覆盖文件 —— 那会把上游提交和未验证的代码带进这条干净的单提交历史（contributor 目录就是这么被污染的）。

上游 remote 仅用于阅读源码：

```bash
git remote add upstream https://github.com/decolua/9router.git
git fetch upstream
git show upstream/master:<path>    # 阅读某文件的上游实现
```

## 📁 项目结构

```
10router/
├── src/                    # Next.js app + Dashboard
│   ├── app/                # 路由 + API
│   ├── lib/                # DB / Auth / Usage
│   └── shared/             # 组件 / 工具函数
├── open-sse/               # 路由/翻译引擎（可独立使用）
│   ├── executors/          # 每个 provider 的执行器
│   ├── translator/         # 格式翻译（OpenAI ↔ Claude）
│   ├── providers/          # Provider 注册 + 配置
│   └── rtk/                # Token Saver 压缩引擎
├── cli/                    # CLI launcher（npm: @techysy/10router）
├── zcode-plugin/           # ZCode 用量同步插件（marketplace.json 在仓库根）
├── tests/                  # 测试（vitest）
├── docs/                   # 架构文档
└── .github/workflows/      # CI（Docker GHCR 构建）
```

## 🔗 相关链接

- [GitHub 仓库](https://github.com/techysy/10router) — 主仓库
- [Gitee 镜像](https://gitee.com/techysy/10router) — 国内镜像
- [📚 技术文档](https://github.com/techysy/10router/tree/main/docs) — 架构 + 工程专题（中英双语导航）
- [上游项目 9Router](https://github.com/decolua/9router)
- [9Router 文档](https://9router.com)
- [9Router fnOS 应用包](https://github.com/techysy/9router-fnos)

## 👥 交流群

**9+1 Router 飞书交流群** — 扫码加入：

![飞书交流群二维码](assets/feishu-qr.png)

## 👥 贡献者

- [techysy](https://github.com/techysy) — 主要维护者
- [shiyangyuda](https://github.com/shiyangyuda) — 代码优化
- [monkey2jack](https://github.com/monkey2jack) — arm64 Docker 支持

## 📄 License

MIT — 与 [decolua/9router](https://github.com/decolua/9router) 一致
# Updated Sat Sep 19 16:43:20 CST 2026
