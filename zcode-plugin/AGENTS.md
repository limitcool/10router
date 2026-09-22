# AGENTS.md — 10router-sync

把本机 AI 编码工具的用量账本导出并导入 [10Router](https://github.com/techysy/10router) 的用量统计，
以及只读查看 10Router 实例的实时状态。

**这只是一组 CLI 脚本**（`scripts/export-usage.mjs` 同步、`scripts/status.mjs` 状态监控），不依赖任何
特定 agent 宿主。本目录下的 `commands/` 和 `skills/` 是给 ZCode 用的可选包装；其他 agent
（Claude Code、Codex、Cursor 等）直接按本文的命令调用脚本即可，行为完全一致。

本机开发免 UI 直装：`~/.zcode/cli/config.json` 加
`plugins.dirs: ["<本目录绝对路径>"]`，重启 ZCode 后插件以 `10router-sync@inline` 身份默认启用
（README「方式二」是等价的 UI 操作）。注意在 Bash 里手写该 JSON 时 Windows 反斜杠路径会被
shell 转义吃掉——用 `\\` 双写、正斜杠，或 `String.fromCharCode(92)` 拼路径。

## 什么时候用

用户要求「同步/导出/导入用量到 10Router」「把 X 的使用量记到 10Router 统计里」，或想知道
某工具的用量并希望它出现在 10Router 仪表盘时。

用户问「10Router 现在什么状态」「哪个渠道被熔断了」「还有多久恢复」「今天用了多少」
「哪个账号被锁了」时，用 `scripts/status.mjs`（见下方「状态监控」）。

## 状态监控（`scripts/status.mjs`）

只读三段输出：**渠道熔断**（`settings.channelBlocks` 中仍在冷却期的 provider，含剩余时间/
strike/是否升级）、**账号健康**（按 provider 分组的启用状态与生效中的 `modelLock_<model>`）、
**用量**（今日 + 累计 + 最常用模型 + 缓存命中率 + 连续天数）。

```bash
node scripts/status.mjs                                    # 本机：零配置
node scripts/status.mjs --endpoint http://nas:20127 --password <面板密码>
node scripts/status.mjs --json                             # 机器可读
```

> ⚠️ **鉴权与 export-usage 完全不同，别混用**。`/api/settings`、`/api/providers`、
> `/api/usage/dashboard` 走 `dashboardGuard`，**只认 JWT 会话 Cookie 或本地 CLI Token**；
> 虚拟 `sk-` key 只开 LLM API（`/v1/*`）与 `import-usage` 路由，对这三个接口一律 401。
> 取凭据顺序：`--cli-token` → `--password`（`POST /api/auth/login` 换 Cookie）→
> loopback endpoint 时自动推导本地 CLI token（`sha256(machine-id + "9r-cli-auth" + auth/cli-secret).slice(0,16)`，
> 读 `%APPDATA%\10router|9router` 或 `~/.10router|~/.9router`）。
> 退出码：0 正常 · 1 不可达或部分读取失败（报告仍打印可读部分）· 2 参数/凭据问题。

## 环境要求

- **Node.js ≥ 24（推荐，与仓库 `.nvmrc` 和 CI 一致）**。脚本用内置的 `node:sqlite` /
  `DatabaseSync`，无第三方依赖，无需 npm install。
  Node 22.x 上 `node:sqlite` 属于实验特性，需要额外加 `--experimental-sqlite` 标志才能
  导入，否则报 `ERR_MODULE_NOT_FOUND`——若必须在 22.x 上跑，用
  `node --experimental-sqlite scripts/export-usage.mjs …`。
- 一个可连通的 10Router 实例，或一个虚拟 key（`sk-…`）／仪表盘密码

## 数据源

用 `--source` 指定，**只支持这五个值，且不会自动检测**（默认 `zcode`）：

| `--source` | 读取位置 | 导入后 provider 前缀 |
|---|---|---|
| `zcode`（默认）| `~/.zcode/cli/db/db.sqlite`（`model_usage` 表），另扫旧布局 `~/.zcode/projects/*/db.sqlite` | `zcode-<渠道名>` |
| `opencode` | `~/.local/share/opencode/opencode.db`，Windows 回退 `%LOCALAPPDATA%\opencode\opencode.db` | `opencode-<providerID>` |
| `mirasim` | `~/.mirasim/insights/usage-YYYY-MM.ndjson` | `mirasim-<协议>` |
| `mimo`（别名 `mimocode`）| `~/.local/share/mimocode/mimocode.db`（`message` 表，assistant 消息的 JSON `data`），Windows 回退 `%APPDATA%\Xiaomi MiMo\mimocode.db` | `mimo-<providerID>` |
| `10r`（别名 `10router` / `9r` / `9router`）| 另一个 10Router/9Router 实例的 `data.sqlite`（`usageHistory` 表）。自动发现 `%APPDATA%\10router\|9router\db\data.sqlite` / `~/.10router\|~/.9router/db/data.sqlite`（env `TENROUTER_DB` 优先），或 `--db <path>` 显式指定 | 无前缀，原样保留源实例 provider |

五个源互相独立，需要各自单独跑一次。ZCode 源会把扫到的多个库合并去重（按行 id 去重），
所以有多份 db 时不必手动挑。

## 固定套路

大多数情况照抄这四步即可（把 `<源>` 换成 `zcode` / `opencode` / `mirasim` / `mimo` / `10r`，
`<URL>` 换成 10Router 地址）：

```bash
# 1. 预览，确认有数据、provider 分组合理
node scripts/export-usage.mjs --source <源> --endpoint <URL> --key sk-… --dry-run

# 2. 正式导入
node scripts/export-usage.mjs --source <源> --endpoint <URL> --key sk-…

# 3. 想看全部来源就换 --source 各跑一次（互相独立）

# 4. 连不上 10Router 时改为两步：先 --export 出 JSON，再在能连的机器 --import
```

若用户已把 key/endpoint 配在环境变量 `TENROUTER_ENDPOINT` / `TENROUTER_KEY` 里，
命令行参数可全省。

## 用法

```bash
# 1) 先预览（只统计不导入）——每次都建议先跑
node scripts/export-usage.mjs --source <源> --endpoint <URL> --key sk-… --dry-run

# 2) 确认后导入
node scripts/export-usage.mjs --source <源> --endpoint <URL> --key sk-…
```

- `--endpoint` 默认 `http://127.0.0.1:20127`；10Router 在 NAS/局域网就填实际地址，如 `http://192.168.31.101:20127`
- 鉴权二选一：`--key sk-…`（虚拟 key，推荐，可在仪表盘单独吊销）或 `--password <仪表盘密码>`
- 环境变量等价写法：`TENROUTER_ENDPOINT` / `TENROUTER_KEY` / `TENROUTER_PASSWORD`
- 其他参数：`--limit N` 只取最新 N 条；`--quiet` 静默；`10r` 源专属：`--db <path>` 指定源实例库、
  `--tag <标签>` 写入 `meta.syncedFrom`（默认记库路径）、`--force` 越过同实例防护（见下）

### 离线模式（本机连不上 10Router）

```bash
# ① 在产生用量的机器上导出（不需要网络，也不需要凭据）
node scripts/export-usage.mjs --source <源> --export usage.json

# ② 在能连上 10Router 的机器上导入
node scripts/export-usage.mjs --import usage.json --endpoint <URL> --key sk-…
```

导出的 JSON 也能直接在 10Router 仪表盘导入（设置 → 数据库备份 → JSON 用量导入）。

**导出文件格式**（供跨机器搬运 / 自行生成时参考）：

```json
{ "source": "zcode-plugin", "exportedAt": "<ISO 时间>", "rowCount": 1513, "usageHistory": [ … ] }
```

`--import` 只取 `usageHistory`（或 `usage`）字段，其余字段仅作说明、不校验；
两者都不是数组则报 `error: file is not a usage export` 并以退出码 1 结束。

### 10Router 用量 API 速查（排查 / 脚本化）

- `GET /api/usage/request-details?page=N&pageSize=M&provider=<name>`——`pageSize` 范围
  **1–100，默认 20**（服务端 `route.js` 校验，超范围 400）；另支持 `model` /
  `connectionId` / `status` / `startDate` / `endDate` 过滤。
- **该接口只认仪表盘凭据**（session cookie / CLI token）——虚拟 `sk-` key 是代理链路的，
  打不开仪表盘 API。本机要脚本化取数时，可从 `~/.zcode/v2/config.json` 里匹配 baseURL
  含 `/20127` 或 `10router` 的 provider 取其 apiKey（CLI token），别拿虚拟 key 试。

## 退出码

脚本化调用时可据此判断失败类型，决定是重试还是改参数：

| 退出码 | 含义 | 例子 |
|---|---|---|
| `0` | 成功（含 0 行的空跑，此时只打印 `nothing to export/import`）| |
| `1` | 数据/环境/远端问题：可重试或换目标 | 找不到账本文件、导入文件读不了、HTTP 非 2xx |
| `2` | 参数错误：必须改命令行，重试无用 | `--source` 值非法、`--export` 与 `--import` 同时给、缺少 `--key`/`--password` |

## 关键行为（改动脚本前必读）

- **幂等去重**：10Router 服务端按行签名去重（时间戳 + provider + model + connectionId +
  apiKey + prompt/completion tokens 七字段）。重复运行安全，输出里的
  `imported X, skipped Y` 中 `skipped` 就是撞上已有行的数量。
  - **回归基线**（本机 2026-09-15 实测，全源重跑应 `imported 0`）：zcode skipped 9875、
    opencode 27、mirasim 2090（另跳 378 行无计数）、mimo 101（另跳 3 行无计数）。数字随
    数据增长，判据是 `imported 0` + skipped 等于全量。
  - **积压补齐就靠幂等**：历史事故——provider 被移除导致同步中断，修复凭据后一次重跑
    补齐 4000+ 条积压，无重复。遇到「漏同步了几天」直接重跑，不需要手工对账。
  注意服务端有**两条写入路径**，签名相同但关注点不同：
  代理实时写入走 `saveRequestUsage()`，其去重契参见
  [用量去重 usageKey 契约](../docs/zh-CN/usage-usageKey-contract.md)（含「同毫秒丢计数」的
  历史坑与 usageKey 修复）；本脚本走 `importUsageRows()` 分支——**该文档的同毫秒问题不适用
  于导入场景**，导入侧关心的是下面那条防双重计数。
- **防双重计数**：这是最容易踩的坑。
  - **ZCode 源：只导出官方渠道**（provider id 以 `builtin:` 或 `account:` 开头，如
    `builtin:bigmodel-*`、`builtin:zai-*`；`account:bigmodel-start-plan` 是 ZCode 大版本
    把套餐/赠送配额渠道改出的新形态，2026-09-20 核验）。其余 provider 一律是用户自行添加的
    自定义渠道，其流量在用户体系里都走本地网关（10Router 自身或兄弟中继），已由 10Router
    自身记账或别的同步源覆盖，再导出就会重复。这是**结构性判据**（不依赖名称/URL/模型名
    格式），能免疫 provider 删除重建导致的 id 变化——历史上一版基于「配置里 baseURL 匹配」
    的守卫就是这么漏掉旧 id 的 3810 行网关流量。**教训**：ZCode 大版本会改官方渠道的 id
    形态（builtin:→account:），漏判的表现是「某些渠道最近突然没新数据同步」——排查时先看
    跳过计数列表里有没有形似官方渠道的新前缀。逃生口：`--include-custom` 可恢复导出非官方
    渠道。跳过时脚本会打印按 provider 分组的计数，绝不静默丢数据。
  - mirasim 源会排除 `upstreamHost` 指向 10Router 实例的行——**必须在导出侧排除**，
    因为两侧行签名不同，服务端去重拦不住，漏掉就会双倍统计。判断逻辑见
    `isSelfHostedUpstream()`：私网/loopback 地址 + 常见端口（20127/20128/80/443），
    或 host 与目标 endpoint 同机。
  - mimo 源目前**没有**自指排除（mimocode 的 provider 体系里未发现可配置 baseURL 指向
    10Router 的路径；本机实测 providerID 只有 `mimo`/`xiaomi` 内置渠道）。若未来 mimocode
    支持自定义 provider baseURL 并指向 10Router，需要补一个同 mirasim 的排除逻辑。
  - `10r` 源的对应守卫是**同实例防护**：源库路径命中本机默认实例库、且 `--endpoint` 是
    loopback 时以退出码 2 拒绝——把实例导回自己时所有行都撞签名，而服务端撞签会给旧行补写
    `meta.imported=true`，把实时行标成导入行。**两条路径都覆盖**：在线直导（守卫在
    `collectRouterEntries()` 内）与离线文件回导（`--import` 分支按 `meta.sourceDbPath` 识别
    ——10r 导出每行都盖这个字段，与 `--tag` 标签无关）。`--force` 越过。
    反向的链式双计（源实例的上游是目标实例）签名两边不同、服务端拦不住，只能靠用户别这么用，
    文档里有明说。
  - 新增数据源时同样要先想清楚「这些调用是否已被 10Router 自己记过」。
- **只读快照，绝不原地打开数据库**：ZCode/OpenCode/MiMo/10r 源的 SQLite 都可能被其他进程
  正在写，脚本会把它（含 `-wal`/`-shm`）复制到临时目录再读（`snapshotDb()`）。改动时不要破坏这一点。
- **`10r` 源是原样透传**：provider/cost/status/tokens/meta 不做任何改写（只有 `connectionId`
  是源实例的外部 uuid——挪进 `meta.sourceConnectionId` 并置空，避免污染目标 byAccount 聚合；
  `meta.syncedFrom` 记来源库路径或 `--tag`）。源库里自己 import 进去的行 meta 原样带走
  （含 `imported`/`source` 标记），服务端会给新插入的行再盖 `imported: true`。
  另外源库**原生**行（meta 无 `imported` 标记）会加 `meta.gatewaySync = true`：目标侧的健康度
  评分对 `imported` 行默认排除，但网关同步行是源实例的真实观测（真实状态码），凭此标记豁免
  参与评分；源实例自己从客户端账本导入过的行**不打**标记，链式同步多远都保持排除。
  契约详见 [usage-import-rows.md](../docs/zh-CN/usage-import-rows.md) 的「gatewaySync 例外」节。
- **cost 一律记 0**：这些渠道是订阅/套餐制，不按量计费；若某源有真实计费数据再另议。
  `10r` 源是唯一例外——源实例可能有真实计费行，cost 原样透传。
- **仪表盘对导入前缀零特殊处理**：`src/(dashboard)/dashboard/usage/` 与 `src/shared/` 下
  grep `zcode-`/`opencode-`/`mirasim-`/`mimo-` 前缀零匹配（2026-09-15 核验）——provider 在
  仪表盘的呈现完全由导入行的 `provider` 字段决定；没有 UI 侧特判可依赖，也没有会被改坏的
  隐式约定。
- **插件无独立测试目录**：改动脚本后的验证手段 = `--dry-run` + 合成 sqlite 造行（10r 源首测
  即此法：建最小 `usageHistory` 表插几行，核对转换/meta/守卫/退出码）；导入链路的服务端
  契约由 10Router 仓库自身的单测覆盖。
- **失败调用跳过**：mirasim 源与 mimo 源会跳过无 token 计数的失败/空转记录，避免污染统计（日志会
  打印 `skipped N rows without token counts`）。

## 排查

| 现象 | 原因与处理 |
|---|---|
| `HTTP 401 Invalid password` | key 已吊销或密码错；去仪表盘新建虚拟 key |
| `HTTP 401 Unauthorized` | 请求被全局守卫拦下，key/密码头没送到；检查 `--key`/`--password` 是否传了 |
| `connection refused` | endpoint 填错或 10Router 没在运行 |
| `no db.sqlite found` | 该工具在本机从没记录过用量 |
| `no 10Router/9Router db found`（`--source 10r`）| 默认路径下没有实例库；用 `--db <path/to/data.sqlite>` 显式指定 |
| `looks like the database of the very instance behind <endpoint>` | 同实例防护触发（loopback endpoint + 本机默认库路径）；确实换别的实例时加 `--force`，否则检查 `--db`/`--endpoint` 填错 |
| 管道里退出码不对（如 NAS 上 `verify-usage-db.mjs … \| grep …; echo $?` 恒为 0） | 管道取的是**最后一个命令**的退出码；判断 verify/clean 成败用 `$PIPESTATUS[0]`，或先落盘再查 |

## 运维工具：10Router 用量库校验与清理

导入数据出错（如本插件的网关行重复导入）需要从 10Router 侧删除时，**不要手工 DELETE**：
`usageDaily` 日聚合是增量维护的，没有任何代码会从 `usageHistory` 重建它——裸删会让仪表盘
长期显示幽灵数字，而手写重建极易踩两个坑（**必须按服务器本地日期分桶**，不是 UTC 日期；
**五个维度都要重建**，不只是 byProvider/byModel）。`scripts/` 下三个工具把这套契约固化了：

| 工具 | 用途 |
|---|---|
| `usage-daily.mjs` | 聚合契约的共享实现（`aggregateEntryToDay` 的精确移植 + 本地日期分桶）。与 10Router 仓库 `src/lib/db/repos/usageRepo.js` 保持同步 |
| `verify-usage-db.mjs` | 只读校验：完整性 / 外键 / **usageDaily 与 usageHistory 逐日逐字段一致性** / lifetime 计数器。退出码 0=PASS、1=FAIL |
| `clean-usage-db.mjs` | 按 `--provider <名>` 或 `--where "<谓词>"` 删行并忠实重建受影响日桶 + 修正计数器；默认 dry-report，`--apply` 才写入；内置事后自检，失败返回 1 |

典型流程（**务必先停 10Router 服务**，它会持有数据库并发的写会损坏文件）：

```bash
# 1. 体检（可随时跑，只读）
node scripts/verify-usage-db.mjs /path/to/data.sqlite

# 2. 预览要删什么（不写入）
node scripts/clean-usage-db.mjs /path/to/data.sqlite --provider zcode-xxxx --export removed-rows.json

# 3. 执行（自带事后校验；失败会提示回滚）
node scripts/clean-usage-db.mjs /path/to/data.sqlite --provider zcode-xxxx --apply

# 4. 复检
node scripts/verify-usage-db.mjs /path/to/data.sqlite
```

实测：本机对同一份含 3810 条重复行的库执行 `clean-usage-db.mjs --apply`，与手工修复结果
**逐字节一致**（36917 行 / 56 桶 / 2026-09-12 桶 JSON 完全相同），`verify-usage-db.mjs`
在清理前后均 PASS。Node 22 需加 `--experimental-sqlite`（Node 24+ 不需要）。

## 结果汇报

跑完把 `imported X, skipped Y` 原样报给用户，并说明数据出现在 10Router 仪表盘 Usage 区的
`zcode-*` / `opencode-*` / `mirasim-*` / `mimo-*` 分组下；`10r` 源则落在源实例原有的
provider 名下（与目标同名 provider 合并）。

## 相关文档

**本插件**

- [README.md](./README.md) — 安装方式（插件市场 / 目录安装）、各数据源示例、虚拟 key 创建
- [CHANGELOG.md](./CHANGELOG.md) — 本插件各版本变更记录（版本号与 `.zcode-plugin/plugin.json` 同步）
- [commands/sync-usage.md](./commands/sync-usage.md) — ZCode 斜杠命令定义（用量同步）
- [commands/status.md](./commands/status.md) — ZCode 斜杠命令定义（实例状态监控）
- [skills/zcode-usage-sync/SKILL.md](./skills/zcode-usage-sync/SKILL.md) — ZCode 技能说明

**10Router 服务端（导入侧）**

- [用量去重 usageKey 契约](../docs/zh-CN/usage-usageKey-contract.md) — 服务端去重规则权威说明，
  含同毫秒丢计数的历史坑；新增数据源前值得一读
- [导入行展示契约 meta.imported](../docs/zh-CN/usage-import-rows.md) — usageHistory（记账）与
  requestDetails（payload 观测）的分工、打标/去重回填/读侧合成三件套、归并分页正确性证明、
  撞签打标的双显示边界
- [架构文档](../docs/zh-CN/ARCHITECTURE.md) — 10Router 整体架构与用量统计在其中的位置
- [SQLite 驱动链](../docs/zh-CN/sqlite-driver-chain.md) — 服务端 SQLite 驱动选择；
  本脚本用的是 Node 内置 `node:sqlite`，与该链路无关，但排查数据库问题时可作参照

**数据源侧**

- [mirasim 用量账本（数据源参考）](../docs/zh-CN/mirasim-usage-ledger.md) — insights 账本字段全表、
  其他 insights 文件辨析、ZCode agent 不在账本、「走了 10Router」的识别信号、mirasim 源防双计
  规则与已知边界
- [mirasim 工具调用丢失排查](../docs/zh-CN/mirasim-dsh-toolcall-loss.md) — mirasim 上游行为记录
- [ZCode 套餐代理可行性](../docs/zh-CN/archive/zcode-plan-proxy-feasibility.md) — ZCode 渠道与
  防双重计数策略的背景（已结案归档）

**仓库级**

- [CHANGELOG.md](../CHANGELOG.md) — 搜 `10router-sync` 可看插件各版本变更
- [CLAUDE.md](../CLAUDE.md) — 仓库贡献约定（提交信息规范等）
