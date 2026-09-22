# 10router-sync 更新日志

10router-sync 插件的版本变更记录（仓库级日志见 [`../CHANGELOG.md`](../CHANGELOG.md)）。
版本号写在 [`.zcode-plugin/plugin.json`](./.zcode-plugin/plugin.json) 与
[`marketplace.json`](./marketplace.json)，两者保持一致。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
本插件尚未发布 1.0.0——0.3.0 之后直接进入 1.1.0（首次支持多数据源）。

## [1.5.0] — 2026-09-20

### 修复

- **适配 ZCode 大版本的套餐渠道 id 变更**：官方判据从「仅 `builtin:` 前缀」扩为
  「`builtin:` 或 `account:`」——新版把套餐/赠送配额渠道（如智谱 Start Plan）的 provider id
  从 `builtin:bigmodel-start-plan` 改为 `account:bigmodel-start-plan`，旧判据把它当自定义
  渠道跳过，导致 09-18 起的套餐流量漏同步。剥前缀规则同步扩展，新旧行在目标侧同名合并为
  `zcode-bigmodel-start-plan`（本机实测补导 343 行到 NAS）。

### 新增

- **gatewaySync 标记**（配合服务端数据口径例外）：`--source 10r` 源库**原生**行（meta 无
  `imported` 标记）导出时加 `meta.gatewaySync = true`，目标侧健康度评分凭此豁免「导入行
  排除」；源实例自己从客户端账本导入过的行不打标，链式同步多远都保持排除。服务端配套见
  仓库 CHANGELOG「数据口径」条。
- **同实例防护扩展到离线回导**：10r 导出的每行盖 `meta.sourceDbPath`（与 `--tag` 标签无关
  的机器可查来源），`--import` 分支识别「文件来自本机默认实例库 + loopback endpoint」同样
  以退出码 2 拒绝，堵上离线路径的同实例回导口子。

## [1.4.0] — 2026-09-17

### 新增

- **实例状态监控命令 `/10router-sync:status`**（`scripts/status.mjs`）：只读查看一个
  10Router 实例的实时状态，分三段输出——
  - **渠道熔断**：`settings.channelBlocks` 里仍在冷却期的 provider，含剩余时间、strike
    次数与是否已升级（60s → 10min）。这是判断「CodeBuddy 11128 之类渠道级风控是否正在
    生效」最直接的入口。
  - **账号健康**：按 provider 分组，列出各连接的启用状态与**当前生效的 per-model 锁**
    （`modelLock_<model>` 未过期项，含剩余时间）——能一眼看出「某个模型被锁了多久」。
  - **用量**：今日请求数/tokens/成本 + 累计请求/tokens + 最常用模型 + 缓存命中率 + 连续
    活跃天数。
  - 支持 `--json` 输出机器可读结果，便于脚本消费。

- **鉴权（与 sync-usage 不同，务必注意）**：本命令读的 `/api/settings`、`/api/providers`、
  `/api/usage/dashboard` 由 `dashboardGuard` 保护，**只认 JWT 会话 Cookie 或本地 CLI
  Token，虚拟 `sk-` key 在这里无效**（sk- 只开 LLM API 与 import-usage 路由）。因此脚本
  按以下顺序取凭据：
  1. `--cli-token <t>` 显式指定；
  2. `--password <面板密码>` → `POST /api/auth/login` 换取会话 Cookie；
  3. **endpoint 为 loopback 时自动推导本地 CLI token**（读数据目录的 `machine-id` +
     `auth/cli-secret`，算法与服务端 `getConsistentMachineId('9r-cli-auth')` 一致）——
     本机零配置即可用。

- **失败语义**：`/api/health` 先探活，不通直接以退出码 1 报「无法访问」；三个数据接口各自
  独立 catch，单个失败只让该段显示「无法读取」而其余照常输出（退出码仍为 1，便于调用方
  感知部分失败）。退出码 2 保留给参数错误与凭据缺失/失效。

### 文档

- 新增 `commands/status.md`；`plugin.json` / 根 `marketplace.json` / `zcode-plugin/marketplace.json`
  三处版本号与描述同步至 1.4.0（Discover 索引是根 `marketplace.json`，勿只改其一）。

## [1.3.0] — 2026-09-15

### 新增

- **10Router/9Router 实例用量同步**（`--source 10r`，别名 `--source 10router` / `9r` /
  `9router`）：读另一个 10Router（或遗留 9Router）实例的 `data.sqlite`（`usageHistory` 表），
  原样透传导入目标实例——provider/cost/status/tokens/meta 全保留（同名 provider 在目标侧
  自然合并），适用于把 NAS 实例、兄弟中继、9Router 老安装的用量汇总进一处仪表盘。
  - 源库发现：`--db <path>` 显式指定（NAS 拷贝/挂载盘），否则自动发现
    `%APPDATA%\10router|9router\db\data.sqlite` / `~/.10router|~/.9router/db/data.sqlite`
    （env `TENROUTER_DB` 优先），多库共存时提示并取第一个。
  - 转换约定：源实例的 `connectionId` 是外部 uuid——挪进 `meta.sourceConnectionId` 并置空
    （避免污染目标的按账户聚合）；`meta.syncedFrom` 记来源库路径，`--tag <标签>` 可自定义；
    原 meta（含 `imported`/`source` 标记）原样带走。
  - **同实例防护**：源库路径命中本机默认实例库且 `--endpoint` 为 loopback 时以退出码 2 拒绝
    ——把实例导回自己时所有行都撞签名，服务端撞签会给旧行补写 `meta.imported=true`，把
    实时行标成「导入行」；确实是另一个实例时用 `--force` 越过。反向链式双计（源实例上游
    是目标实例）签名两边不同、服务端拦不住，文档明示不可这么用。
  - 读运行中的库为快照式复制（含 `-wal`/`-shm`），不必停源实例（可能缺最后几秒流量）。
  - 沿用服务端既有兼容面：列集与 `readUsageFromSqlite()`（9router 备份导入路径）一致，
    旧库缺列时自动降级为最小列集。
  - 两处加固（同日审查补）：**无 scheme 的 endpoint**（如 `127.0.0.1:20127`）也能被同实例防护
    正确识别（否则守卫静默失效开）；**NULL 时间戳行导出侧跳过**——服务端会给空时间戳回填
    `new Date()`，每次重跑签名都不同，幂等破防会重复插入。

### 文档

- SKILL.md / README / AGENTS.md / 命令描述补 `10r` 源用法、发现规则、同实例防护与排查表；
  README 标题与「脚本一览」同步为五源。
- **根 `marketplace.json`（Discover 页市场索引）同步 1.3.0 与新描述**——此前只改了
  `zcode-plugin/marketplace.json`（本地开发变体），审查发现漂移后补齐。
- AGENTS.md 另补：仪表盘对导入前缀零特殊处理（grep 核验结论）、幂等回归基线与积压补齐
  事故、10Router 用量 API 速查（pageSize 1–100 默认 20，仅认仪表盘凭据）、NAS 管道退出码
  陷阱、inline 安装说明；修复 `zcode-plan-proxy-feasibility.md` 失效链接（已归档至 archive/）。

## [1.2.0] — 2026-09-15

### 新增

- **小米 MiMo 桌面版用量导出**（`--source mimo`，别名 `--source mimocode`）：读
  `~/.local/share/mimocode/mimocode.db` 的 `message` 表，取每轮 assistant 消息的
  `input`/`output`/`reasoning`/`cache.read`/`cache.write` 五项 token 计量（附
  `modelID`/`providerID`/`agent`/`mode`/`time`），粒度比 OpenCode 的 session 级汇总更细。
  实现沿用既有安全惯例：WAL 活库先快照再读、按 `message.id` 去重、0-token 空转/中断轮次
  跳过、provider 落 `mimo-<providerID>`、cost 记 0、`meta` 带 messageId/sessionId/agent/mode。
  Windows 回退路径 `%APPDATA%\Xiaomi MiMo\mimocode.db`。
- **运维工具三件套**（`scripts/`）：
  - `usage-daily.mjs` — 10Router `usageDaily` 聚合契约的共享实现（本地日期分桶 + 五维聚合），
    与 10Router 仓库 `src/lib/db/repos/usageRepo.js` 保持同步。
  - `verify-usage-db.mjs` — 只读体检：完整性 / 外键 / **usageDaily 与 usageHistory 逐日逐字段
    一致性** / lifetime 计数器。退出码 0=PASS、1=FAIL。
  - `clean-usage-db.mjs` — 按 `--provider <名>` 或 `--where "<谓词>"` 删行并忠实重建受影响日桶
    + 修正计数器；默认 dry-report，`--apply` 才写入；内置事后自检，失败返回 1。
- `--include-custom` 选项（见下方"变更"）。

### 变更

- **ZCode 源改为结构性「仅官方渠道」**：只导出 provider id 以 `builtin:` 开头的行
  （`builtin:bigmodel-*`、`builtin:zai-*` 等）。非 `builtin:` 的 provider 一律是用户自加的
  自定义渠道，其流量都走本地网关（10Router 自身或兄弟中继），已由 10Router 记账或别的同步源
  覆盖，导出即重复。跳过时按 provider 分组打印计数（不静默丢数据）。
  `--include-custom` 可恢复旧的"全部导出"行为。

  改动原因：旧守卫基于「当前配置里 baseURL 指向 10Router 的 provider id」，而 provider 删除
  重建会换 id——实测旧 id `bd97d057-…` 的 3810 行网关流量因此漏网并被导入，与 10Router 自记的
  `bai` 渠道形成双份统计；随后加的启发式补丁（UUID + 网关寻址模型名）又被第三个自定义
  provider（`1fd00800-…`，90 行，模型名不含前缀）绕过。前缀判据结构性覆盖全部三种情况。

### 修复

- 无（本次未发现旧版本的其他缺陷）

### 文档

- README 补「运维工具：用量库校验与清理」章节与小米 MiMo 用法；AGENTS.md 补运维工具说明与
  新的防双重计数规则；SKILL.md 补数据源、工具用法与故障处理；命令描述与 manifest 同步至 v1.2.0。

## [1.1.0] — 2026-09-11

### 新增

- **mirasim 桌面端用量同步**（`--source mirasim`）：读 `~/.mirasim/insights/usage-YYYY-MM.ndjson`
  逐调用账本（`input`/`output`/`cacheRead`/`cacheWrite`/`reasoning`），provider 落
  `mirasim-<协议>`，失败调用（无 token 消耗）自动跳过。E2E 验证导入/重导入
  `imported:20 → skipped:20`。
- 逐调用账本跨月去重（按调用 id）。

### 修复

- **mirasim 导出防双重计数**：`upstreamHost` 指向 10Router 实例的行自动跳过——判断逻辑为
  「loopback/私网地址 + 常见端口（20127/20128/80/443）」或「host 与目标 endpoint 同机」。
  必须在导出侧排除：两侧行签名永不碰撞，服务端去重拦不住，漏掉就会双倍统计。
  配套 12 例 matcher 单测。

### 文档

- 新增 `AGENTS.md`（面向非 ZCode agent 的复用说明），后续校正 Node 版本说法、补退出码表与
  导出文件格式说明。
- 命令描述补中文（i18n）。

## [0.3.0] — 2026-09-08

### 新增

- **OpenCode 桌面端用量导出**（`--source opencode`）：读
  `~/.local/share/opencode/opencode.db` 的 `session` 表（Windows 回退
  `%LOCALAPPDATA%\opencode\opencode.db`），provider 落 `opencode-<providerID>`。

## [0.2.0] — 2026-09-07

### 新增

- **离线导出/导入模式**：`--export <file>` 在本机导出 JSON（无需网络与凭据），
  `--import <file>` 在能连通 10Router 的机器导入；导出的 JSON 也可直接在 10Router 仪表盘导入
  （设置 → 数据库备份 → JSON 用量导入）。适用于 ZCode 与 10Router 不在同一网段的场景。

### 文档

- 仓库根新增 `marketplace.json`，ZCode 用户可在 Discover 页添加 `techysy/10router` 直接安装
  本插件（npm/桌面/源码安装用户通用，无需单独仓库）。

## [0.1.0] — 2026-09-05

首个版本。

### 新增

- **ZCode 本地用量同步**：读 `~/.zcode/cli/db/db.sqlite` 的 `model_usage` 表，转为
  usageHistory 经 `/api/settings/database/import-usage` 导入 10Router。WAL 活库先快照再读
  （绝不原地打开正在写的库）。
- **防双重计数**：自动排除 baseURL 指向 10Router 自身的 provider（那些调用 10Router 已记账）。
- **幂等**：依赖 10Router 服务端的行签名去重，重复执行不产生重复数据。
- **鉴权**：Bearer 虚拟 key（`sk-…`）或仪表盘密码（`x-9r-password`），亦支持环境变量
  `TENROUTER_ENDPOINT` / `TENROUTER_KEY` / `TENROUTER_PASSWORD`。
- 交付形态：skill + slash 命令（`/10router-sync:sync-usage`）+ 插件 manifest。
- 已装本机 ZCode（`plugins.dirs` inline）并端到端验证。

[1.3.0]: #130--2026-09-15
[1.2.0]: #120--2026-09-15
[1.1.0]: #110--2026-09-11
[0.3.0]: #030--2026-09-08
[0.2.0]: #020--2026-09-07
[0.1.0]: #010--2026-09-05
