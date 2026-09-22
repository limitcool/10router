# 规格与实现：`10router doctor` 自检命令（§5.4）

> 归属：issue #24 §5.4。**已实现**：`cli/src/cli/doctor.js` + `tests/unit/doctor.test.js`（63 例）。
> 下面保留原始规格，文末「实现记录」列出落地时与规格的差异（三处）。
> 与 `docs/zh-CN/design-tray-ready-handshake.md` 同类：给维护者一份可直接贴进 issue 的稿子。

## 为什么要它

#24 的三个根因有一个共同点：**用户能看见的症状（「更新完还是旧界面」「装好了却起不来」）
和真实原因之间隔了好几层，且所有现成的自检手段都回答不了**。

- §1 的 hook 互剪：`better-sqlite3` 在 `node_modules` 里存在但在 `runtime/package.json` 里缺失，
  于是被下一次 install 当 extraneous 剪掉——`npm ls` 看不出来，`/api/health` 也照样 `ok`。
- §3 的 stale server：旧的 next-server 还占着端口，新构建根本没被服务；
  `/api/health` 是**旧进程**回的 `ok`，等于骗人。
- §4 的驱动遮蔽：全局 `node_modules` 里的 better-sqlite3 顶掉了 runtime 副本；
  原 `/api/health` 连驱动名都不返回。

三次都得靠人工翻进程、读 `node_modules`、比对版本号才能定位。`10router doctor` 就是把
这套人工取证固化成一条命令。

## 命令面

```
10router doctor [--json] [--port <port>]
```

默认输出人类可读的分组报告；`--json` 输出稳定 schema（给支持人员/CI 粘贴）；
**任一项 red 时退出码非 0**（便于 CI 与「装坏了」的脚本判断）。全流程**只读**。

## 检查项

| 组 | 检查 | 数据来源 | 判红条件 |
|---|---|---|---|
| 版本 | 启动器版本 vs `<dataDir>/.disk-version` vs **运行中** server 版本 | `pkg.version`；§3a 的 `readDiskVersion()` / `probeServerVersion()` | 三者不一致 → 就是 stale build（§3b 的横幅场景） |
| 陈旧进程 | 端口占用者 PID、是否为本项目 pidfile 记录的 PID | §3a 的 `readPidFile()` / `pidFilePath()` + 端口探测 | 占用者的版本 ≠ 磁盘版本 |
| 驱动 | `/api/health` 的 `driver` 与 `lastDriverError`；`<dataDir>/runtime/node_modules/better-sqlite3` 是否存在 | §4 新增的 health 字段（**不触发 DB 初始化**） | `driver` 为 null 或 `lastDriverError` 非空且 runtime 副本缺失 |
| runtime 依赖 | `better-sqlite3` / `sql.js`（+ 非 Windows 的 `systray2`）是否既在 `node_modules` **又**在 `runtime/package.json` 的 deps 里 | 直接读 `runtime/package.json` + 目录存在性 | 存在但未登记 → §1 的互剪前兆 |
| 托盘 | 平台、`systray2` 是否就位、当前会话能否画图标 | 平台判断 + 同 §5.2 的告警条件 | 仅告警（yellow），不判红 |
| 端口 | 目标端口是否空闲、是否与配置一致、是否有 MIT/隧道 PID 文件残留 | `killProcessOnPort` 同源的探测 + §3a 的 pid 文件 | 端口被非本项目进程占用 |
| 完整度 | `cli/app` 是否含 `.next-cli-build` + `custom-server.js`；`app/package.json` 版本 vs 启动器版本 | 文件存在性 + 读版本 | 缺文件或版本不一致 → 「半次升级」 |
| 数据目录 | `DATA_DIR` 解析结果、存在性、可写性；是否还有待迁移的旧 `~/.9router` | `cli/hooks/sqliteRuntime.js` 的 `getDataDir()` | 不可写；或旧目录仍在（yellow） |

## 实现要点

- 新文件 `cli/src/cli/doctor.js`，**复用**既有基建而不是重写：`staleServer.js` 的
  `probeServerVersion` / `pidFilePath` / `diskVersionPath` / `readPidFile`，
  `sqliteRuntime.js` 的 `getDataDir`。每个检查是一个纯函数（返回
  `{ id, status: "ok"|"yellow"|"red", detail, hint }`），由一个 assembler 汇总——
  这样单测不需要起进程、不需要真 DB。
- 三语文案（en / zh-CN / zh-TW）随实现补进 `cli/src/cli/i18n/locales/*/core.json`，
  沿用 `doctor.*` 前缀；`--json` 模式输出的是**检查 id**，不输出译文，保证机器可解析。
- `--json` 的字段名一旦发布就视为契约，加 `schemaVersion` 字段以便日后演进。
- 只读：**不得**触发 DB 初始化（沿用 §4 对 `/api/health` 的同一条规则）、不得写任何文件、
  不得重启/杀进程。

## 非目标

- **不做自动修复**（`--fix`）。每个修复的爆炸半径都不同（杀进程 / 重装依赖 / 迁移数据），
  该不该自动做是产品决策，另议；`doctor` 只负责「说清楚」。
- 不做遥测、不联网（npm 版本检查要显式 opt-in）。
- 不覆盖 `src/` 侧的运行时自检（那属于 `/api/health`）。

## 风险与测试

- 风险：Windows 下托盘会话探测不精确（仅 yellow 可接受）；`--json` schema 需要版本化承诺。
- 测试：每个检查函数的 ok/yellow/red 三态各一例；assembler 的退出码；
  `--json` 的稳定性（快照）。沿用 `tests/unit/` 既有手法：
  CJS 模块用 `createRequire(import.meta.url)` + 打桩 `child_process.spawnSync`
  （见 `tests/unit/stale-server-heal.test.js`），**不要**真的起进程或写真实 `~/.10router`。

---

## 实现记录（落地时的差异）

实现与上面的规格有三处不同，都是实现过程中被真实数据逼出来的：

### 1. `runtime-deps` 增加了 `broken-artifact`（red）

规格只要求查「既在 `node_modules` 又在 `runtime/package.json` 的 deps 里」。
在开发机上首次跑真实报告时发现这不够：`better-sqlite3` 的 `package.json` 在、
deps 里也登记了，但 `build/Release/better_sqlite3.node` **不存在**（编译产物从未生成）——
于是 `npm ls` 和本检查都说 OK，而 §4 的驱动层一直在降级。这正是 doctor 要抓的那类问题，
所以补了一项：装了但产物缺失 → red。判定直接复用 `hooks/sqliteRuntime.js` 的
`isBetterSqliteBinaryValid()` / `isSqlJsWasmValid()`（本次为 doctor 把这两个函数
**参数化 + 导出**，默认参数保持原行为，`ensureSqliteRuntime()` 不受影响）。

### 2. `data-dir` 的 legacy 判定用 `hasAppData()`，不是「旧目录存在」

`src/lib/dataDir.js` 的迁移是**一次性**的，且刻意**不删**旧目录（保留是为了让用户
能手动重试）。所以「`~/.9router` 存在」对老用户是**永久成立**的条件——照规格写法会
永远报 yellow，变成噪音。改成与 app 同款判定：旧目录存在 **且** 新目录还没有本应用的
数据（`db/data.sqlite` 或四个 pre-SQLite json 之一）才算 pending。文件清单与
`dataDir.js` 的 `LEGACY_JSON_FILES` 保持一致，两处不会对「是否已迁移」产生分歧。

### 3. `version` 不依赖「服务正在运行」

初版在没有服务应答时直接返回 OK，于是「启动器 ≠ 磁盘标记」这个真实信号被吞掉了
（`--port <空闲端口>` 时可见）。现在三者只要有分歧就 red，与是否有服务无关；
「端口有人应答但不是我们的 `/api/version`」单独给 yellow。

### 另有两点按规格但值得记下

- **托盘**：win32 视为 ok——Windows 的托盘是 Electron/app 进程内的，本来就不装
  `systray2`，把它当缺失会误报。
- **只读**：`tests/unit/doctor.test.js` 有一条源码守卫，断言 `doctor.js` 内不含
  `writeFileSync` / `mkdirSync` / `unlinkSync` / `ensureSqliteRuntime` / `npmInstall` /
  `killPid` / `spawnSync` / `exec(`；另有断言 `cli.js` 里 `doctor` 的分发**早于**
  `ensureSqliteRuntime()` 与 `writeDiskVersion()`（否则它会先「修好」再汇报）。
