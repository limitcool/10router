# 设计方案：托盘就绪握手（只出方案，未动码）

> 归属：issue #24 §5.2 的延后项。本批只做「托盘初始化失败不再静默」+ `--no-tray`；
> 「父进程谎报已在托盘中运行」的握手改造需要跨平台取舍，先记方案。
> 建议另立 issue 并随 1.1.x 之后排期。

## 问题

Windows / Linux 上选择「后台运行（托盘）」时，父进程 `spawn` 一个 detached 的
`--tray` 子进程后**立刻**打印：

```
launcher.startingBackground   →  正在转入后台…
launcher.backgroundRunning    →  已在托盘中运行 (PID 12345)
launcher.closeTerminalHint    →  可以关闭本终端
```

然后 `cleanup(); process.exit(0)`。父进程对子进程是否真的起来了**一无所知**：

- 子进程拿不到端口（上一个 server 还占着、防火墙、权限）；
- 子进程托盘初始化失败（无桌面、systray2 没装上、Windows NotifyIcon 被策略拦）；
- 子进程启动即崩（standalone 缺失、依赖没装好）。

这些情况下用户已经被告知「已在托盘中运行，可以关终端」，关掉终端后再无任何反馈——
托盘没有图标、网关也没起来，用户只能以为「装坏了」。这正是 §5.2 提到的「谎报」。

根因是**没有跨进程就绪回执**。当前 spawn 形如：

```js
const bgProcess = spawn(process.execPath, [..., "--tray", "--skip-update", "-p", port], {
  detached: true,
  stdio: "ignore",     // ← 连管道都不给
  windowsHide: true,
  env: { ...process.env },
});
bgProcess.unref();
console.log(t("launcher.backgroundRunning", { pid: bgProcess.pid }));
```

`stdio: "ignore"` + `detached` + 立即 `unref()` 的组合是刻意为之（要能在终端关闭后存活），
代价就是父进程拿不到任何信号。所以**不能**简单改成 `ipc` 或读 stdout 就完事：
`stdio: ["ignore", "pipe", "pipe"]` 会给子进程留一个 pipe fd，父进程退出后读端关闭，
子进程再 `console.log` 会撞 EPIPE（Node 默认直接抛异常），得先保证子进程对 stdout 写失败免疫。

## 候选方案

| 方案 | 做法 | 好处 | 代价 / 风险 |
|---|---|---|---|
| A. IPC 回执 | spawn 时 `stdio: ["ignore","pipe","pipe"]`，子进程就绪后写一个 READY token，父进程读到再 `unref()` 退出 | 语义最直接 | 与 `stdio:"ignore"` 的存活语义冲突；需 EPIPE 免疫；Windows detached + pipe 的句柄继承要单独验证 |
| B. 就绪文件 + 存活检查 | 子进程在 `waitServerReady()` + `initTrayIcon()` 之后写 `<dataDir>/.tray-ready`（含 `{pid, version, trayOk}`），`cleanup()` 删除；父进程轮询 | 不动 spawn 的存活语义；能同时覆盖「子进程直接死了」；直接复用 #24 §3a 的 pidfile 基建 | 需要轮询 + 超时 + 文件残留清理 |
| C. 短暂等待退出码 | 父进程不 unref，先等子进程 exit 事件若干秒；没有 exit 就认为成功，再 unref 退出 | 改动最小 | 子进程「活着但托盘没起来」仍然骗过检测，只挡住立即崩溃这一种 |

**推荐 B**：它是唯一能回答「托盘真的起来了吗」而不是「进程还活着吗」的方案，
不改变子进程的独立存活语义，并且能顺带喂给 systemd / 进程监督器（就绪文件等于轻量
`Type=notify` 的替代），也能把 §5.2 那句 `console.warn` 的诚实报错延伸到父子两侧。

## B 的落地草图（供后续实现者）

1. `cli/src/cli/staleServer.js` 旁边新增 `trayReadyPath(dataDir)` /
   `writeTrayReady(dataDir, info)` / `readTrayReady(dataDir)` / `removeTrayReady(dataDir)`，
   与既有的 `pidFilePath` / `readPidFile` 同风格，便于单测（不触碰真实文件系统之外的东西）。
2. `--tray` 子进程：在 `waitServerReady(port).then(...)` 里，`initTrayIcon()` 之后写入
   `{ pid: process.pid, version: pkg.version, trayOk }`；`cleanup()` 里删除。
   注意写在前、删在后要成对，避免崩溃后留下「陈旧就绪」——读取端必须校验 pid 是否为本次 spawn 的
   子进程（复用 §3a 的 `probeServerVersion` 思路做活性校验）。
3. 父进程：spawn 前先删掉旧的 `.tray-ready`；spawn 后 200ms 轮询至多 10s，
   任一条件成立即结束等待：① 读到 pid 匹配的回执 → 按 `trayOk` 打印「已在托盘中运行」或
   「已转后台，但托盘图标不可用」；② 子进程 exit（非 0）→ 打印 `launcher.startFailed` 并**回落到 TUI**，
   不要 exit；③ 超时 → 打印「已转后台，但未收到就绪确认」并给出日志路径。
4. 三语文案（en / zh-CN / zh-TW）随实现补进 `cli/src/cli/i18n/locales/*/core.json`，
   与 §5.2 已加的 `launcher.trayUnavailable` / `launcher.traySkipped` 同一组。
5. 测试：就绪文件读写 / 陈旧回执被 pid 校验拒绝 / 超时分支 / 子进程立即 exit 分支，
   放 `tests/unit/`，用 `createRequire` + 打桩 `child_process.spawnSync` 的既有手法
   （见 `tests/unit/stale-server-heal.test.js`），**不要**真的起进程。

## 为什么不在本批做

- macOS 是**另一条代码路径**：detached 子进程会让 NSStatusItem 静默失效，所以 macOS 保留
  当前进程（`switchingToTray` 分支），握手方案必须分平台设计，不能一套通吃。
- 回落策略（失败时回 TUI 还是直接报错退出）会改变用户可见行为，值得单独 review。
- 本批的 `console.warn`（托盘初始化异常不再静默）已经把「完全无反馈」降级成「有一条明确告警」，
  风险敞口显著变小，可以不阻塞其余修复。
