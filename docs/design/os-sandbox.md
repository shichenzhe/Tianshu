# OS 级沙箱技术方案（security 子篇）

> 立项基线：2026-11-14，由 `security.md` §6 P1-2 挂账展开（原文预埋方向：macOS sandbox-exec / Linux Landlock / win32 诚实声明 / bash 工具 execute 处包启动器）。
> 关联篇：[security.md](security.md) §3.2（tool-gate 判定链）、§3.3（命令门禁分级）。本文只覆盖 bash 工具的 OS 级执行隔离，不动应用层既有防线。
> **状态：已落地（2026-11-15 首批，`worktree-os-sandbox` 分支 4f9258dc）**。实施批平台实测发现两处与本文初稿的偏差，已勘误并入：①§4.2 模板必带 `(allow default)` 头且 subpath 须 realpath 归一；②§4.5 exec 丢弃 detached，须 spawn 适配层。详见各节「2026-11-15 勘误」标注。

## 1. 定位与背景

### 1.1 挂账来历与对标

security.md 全局缺口表已列「OS 级沙箱缺位」。三家对标（2026-11-14 实况调研）：

| | 层级 | 默认 | 与审批的关系 |
|---|---|---|---|
| Claude Code | OS 级（macOS Seatbelt / Linux bubblewrap） | 按 permission mode 自动启用 | 沙箱内命令免逐条批准，越界走许可 |
| dsh（DeepSeek Harness） | 会话级 `sandbox/mode`（默认 workspace-write） | 初始化即注入 | permission preset × sandbox mode × approval policy 三层正交 |
| WorkBuddy | 应用层策略沙箱（网络代理 + 文件规则） | 默认开（未设置即 true，异常 fallback 也 true） | 沙箱路径跳过 8-Phase 审批，`autoAllowBashIfSandboxed` |
| **天枢（本方案）** | OS 级（首批仅 macOS Seatbelt） | **默认关，安全中心自开** | 判定链零改动，沙箱纯做兜底硬网 |

### 1.2 加法定位：防的是静态分析的固有极限

天枢现有 bash 防线（isDangerousCommand 七组正则、command-policy 词法判定、command-risk 分级、child-monitor ps 轮询）全部是应用层静态/事后分析，其精度边界在 security.md §3.3 已自我声明：**命令替换混淆（`$(rm -rf ~)`）、引号内分隔符误分、shell 隐式换壳**。沙箱的价值恰是把这些漏网兜成硬失败——越界写直接 EPERM，与命令怎么写无关。

因此本方案是**纯加法**：既有门禁一条不动、一项不豁免，沙箱作为执行前的最后一道硬网加在 `command-tool.ts` 执行处。

## 2. 裁定记录（2026-11-14）

1. **`osSandboxEnabled` 默认关**，安全中心自开。新特性灰度姿态，不动存量会话行为（WorkBuddy 默认开的姿态对本方案过激：它会改变网络/文件行为面）。
2. **沙箱内网络全放行**。沙箱只管文件写边界；网络面维持现状（S4 批收编的 13 类网络命令 cmdAsk 名单 + NetworkGate 进程内拦截 + local-proxy）。**知情代价：`curl` 直连绕域名白名单的洞保留**；将来收紧只改 profile 模板一处（§4.4），架构不用动。
3. **假设（未裁，按现状惯例推定）**：
   - full 档会话不进沙箱——full=显式免责强确认（FullAccessModal）语义，且 HIGH/CRITICAL 硬线本就不豁免，对齐天枢既有裁定而非 WorkBuddy 的强制沙箱姿态；
   - HIGH/CRITICAL 危险分级线在沙箱开启时**不豁免**（维持 2026-10-24「full 也不豁免」裁定，沙箱同理不加豁免）；
   - 沙箱不可用（未装/异常）fail-open 透传，回落现有审批链——对齐 command-gate 既有 fail-open 语义；
   - 存量配置 key `sandboxEnabled`（命令判定门总开关）语义不动，新开独立 key 消歧。

## 3. 架构

新增 `electron/domains/security/sandbox/`，模块结构与安装模式对齐 `command-gate.ts`（模块单例 + Application 装配时 install）：

```
sandbox/
  runner.ts     # SandboxRunner 接口 + 平台分发 + install/getSandboxRunner 单例
  seatbelt.ts   # macOS 实现：sandbox-exec 包装 + 进程组收割
  profile.ts    # sbpl profile 生成（纯函数，路径转义，vitest 直测）
```

接口（`runner.ts`）：

```ts
export interface SandboxWrapResult {
  /** 包装后的完整命令行（透传时 === 原命令） */
  command: string;
  /** 进程组收割句柄：命令结算后调用，杀透 sandbox-exec 全组（可选） */
  reapProcessGroup?: (pid: number) => void;
}

export interface SandboxRunner {
  /** 平台可用性：darwin 且 sandbox-exec 存在 */
  available(): boolean;
  /** 包装：不可用/未启用返回原命令（fail-open） */
  wrap(command: string, opts: { workspacePath: string; fullAccess: boolean }): SandboxWrapResult;
}
```

- 平台分发：`process.platform === "darwin"` → SeatbeltRunner；其余 → NoopRunner（`wrap` 恒等返回）。
- 启用判定不入 runner：由 `command-tool.ts` 装配处读 SecurityConfig（`osSandboxEnabled`）+ `available()` + `fullAccess` 三条件合成，runner 只负责包装。

## 4. macOS Seatbelt 实现（seatbelt.ts + profile.ts）

### 4.1 调用形态

```
sandbox-exec -p '<sbpl>' /bin/zsh -c '<原命令>'
```

- Seatbelt 为 macOS 系统内置，零依赖、零原生模块（不碰 allowScripts / 双 ABI / 原生自愈链）。
- 原命令经 `exec()` 已有 shell 转义链路不变；sbpl 经 `-p` 内联（profile 生成时对路径做 §4.3 转义）。

### 4.2 profile 模板（workspace-write 语义，每次执行按 workspace 动态生成）

```lisp
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "<WORKSPACE>"))
(allow file-write* (subpath "<TMPDIR resolved>"))
(allow file-write* (literal "/dev/null") (literal "/dev/tty"))
```

- **（2026-11-15 勘误）`(allow default)` 头必带**：macOS 26（Darwin 25）实测 sbpl 未提及的操作**不再默认放行**，缺它 sandbox-exec 装上 profile 后 execvp 直接 EPERM（exit 71），方案模板原样落地会全线跑不起来；带上后 deny 与子路径 allow 因更具体仍优先，workspace-write 组合成立。
- **（2026-11-15 勘误）subpath 必须 realpath 归一**：macOS 符号链接（`/tmp`、`/var` 实际落 `/private/tmp`、`/private/var`）下，sbpl 按真实路径匹配，未归一的白名单**静默失效**（workspace 与 TMPDIR 注入前均 `realpathSync`，失败回落 `/private` 前缀字符串归一）。
- 读全放行、进程执行放行、网络零约束（裁定 #2）——由 `(allow default)` 头承担，只限写。
- 写白名单 = workspace 子树（锚点与 `resolveCwd` 同源：`workspacePath || os.homedir()`）+ TMPDIR（macOS 实际落 `/private/var/folders/...`，须 resolve 后注入）+ 基础设备节点（`/dev/null`、tty——大量 CLI 工具隐式写这些）。
  - **锚点语义边界**：未绑定工作空间（workspacePath 空串）时锚定家目录，白名单即整个家目录——沙箱保护强度随绑定状态降级（此时家目录内敏感写如 `~/.ssh` 不受沙箱拦，见 §11.6）；这是与 resolveCwd 锚点同源的既有语义，不为沙箱单开特例。
- **不设读限制**：读面已有 file-gate 应用层管理；沙箱限读极易把正常工具（git status 扫仓库、编译器扫 SDK）弄坏，收益远小于可用性代价。
- 数据根 `~/.tianshu` 不在写白名单内：bash 工具不应写应用数据（写库走应用工具）。

### 4.3 路径转义（profile.ts 纯函数）

sbpl 字符串字面量中需转义 `"` 与 `\`；workspace 路径含空格/引号/中文（工作空间允许任意路径）必须全路径覆盖单测。生成函数签名 `buildSeatbeltProfile(workspacePath: string): string`，vitest 直测。

### 4.4 网络收紧的预留位（本批不实现）

将来若推翻裁定 #2：模板追加 `(deny network*)` + `(allow network-outbound (remote ip "127.0.0.1:<proxyPort>"))`，与 `buildChildEnv()`（command-tool.ts，HTTP_PROXY 注入）协同即成「沙箱内强制过代理」——改动收敛在 profile.ts 一处 + 装配处传 proxyPort。

### 4.5 进程组收割

sandbox-exec 是直接子进程，其下 zsh 及孙进程（编译器、测试器）在超时 kill 时可能残留（timeout 只 SIGTERM 直接子进程）。实现（**2026-11-15 勘误**：初稿「exec options 增 `detached: true`」不成立——Node 26 实测 `exec()` 会丢弃 detached 选项，spawn 对照组生效、exec 两组 ESRCH 定案）：

- **exec→spawn 适配层**：`spawn("/bin/sh", ["-c", command], { detached: process.platform !== "win32" })` 同语义重建（exec 本就是 spawn 的 /bin/sh -c 聚合包装）；maxBuffer/timeout 聚合语义在适配层手工重建（各流独立封顶，溢出即杀）；
- posix 上子进程自成新进程组组长，对 `-pid` SIGKILL 即收割全组；
- **收割时机限定**：仅超时 / 用户中止 / 输出溢出 / 启动异常四类结算时收割（防残留）；**正常退出不收割**——对齐现状语义（后台进程如 `npm run dev &` 命令返回后继续存活），避免误杀用户有意留下的后台任务；
- **收割挂 `exit` 事件而非 `close`**：孙进程持有 stdio 管道会拖延 close，先杀组才能加速结算；
- child-monitor 的 ps 轮询照常兜底（两层收割，不互斥）。

### 4.6 已知平台风险

- `sandbox-exec` 被 Apple 标记 deprecated（man 页声明），但 macOS 至今内置可用，Claude Code 生产同款；若未来移除，runner.available() 探测自动降级为透传（fail-open），不炸主链路。
- sbpl `(version 1)` 语义跨 macOS 版本稳定；profile 以测试锚定（§10）。

## 5. 嵌入点（command-tool.ts，一处）

`runExec()`（command-tool.ts:148）内：

```ts
// 装配处（ChatService/automation-runner 既有 CommandContext 注入点）新增：
// sandboxEnabled 判定 + wrap；runExec 内（spawn 适配层，见 §4.5 勘误）：
const wrapped = runner.wrap(command, { workspacePath: ctx.workspacePath, fullAccess: !!ctx.fullAccess });
spawn("/bin/sh", ["-c", wrapped.command], { cwd, env: buildChildEnv(), detached: process.platform !== "win32" })
```

- 包装只发生在执行前最后一刻，**判定链（tool-gate 七步）、isDangerousCommand、resolveCwd 钳制全部在前、全部保留**。
- `ctx.fullAccess` 为 true 时 `wrap` 恒等返回（裁定假设：full 不进沙箱）。
- `CommandContext` 增加 `osSandbox?: { wrap: SandboxRunner["wrap"] }` 注入面（保持 command-tool 纯 Node 可测：vitest 里 runner 可替换为桩）。

## 6. 配置与 UI

### 6.1 新 key 三处落点（单源惯例）

| 位置 | 改动 |
|---|---|
| `src-react/domains/security/model/types.ts` SecurityConfig（:8） | 加 `osSandboxEnabled: boolean` |
| `electron/domains/security/defaults.ts` SECURITY_DEFAULTS | `osSandboxEnabled: false`（裁定 #1） |
| `electron/domains/security/security.service.ts` NORMALIZERS（:41） | `osSandboxEnabled: (v) => v === true` |
| `electron/domains/security/config-store.ts` FIELD_PARSERS（read-time 回退） | `osSandboxEnabled: (raw) => parseBoolOption(raw, false)`（**2026-11-15 勘误**：初稿漏列的第四落点，option 表读侧解析，回退 false 与默认关裁定一致） |

### 6.2 命名消歧

存量 key `sandboxEnabled` 实为「命令判定门总开关」（cmdAsk/cmdAllow/黑名单的旁路开关，command-gate.ts:19），与本方案的 OS 沙箱无关且**语义不动**。安全中心 UI 文案区分两卡：「命令判定」（现状卡不动）与新增「系统沙箱（macOS）」卡：开关 + 一句能力说明（越界写将被系统级拒绝）+ 平台不可用时的置灰态（win32/Linux 显示「当前平台暂不支持」）。

### 6.3 粒度

首版全局开关，不做 per-workspace / per-session 粒度（dsh 的会话级 mode 留待有需求再议）。

## 7. 与既有门禁联动（全保留清单）

| 既有机制 | 沙箱开启后的关系 |
|---|---|
| tool-gate 七步判定链 | **零改动**；普通 bash 在 default 档仍走 auto-allowed 直执行（沙箱兜底） |
| HIGH/CRITICAL 危险分级 | 不豁免，照常强制审批（裁定假设） |
| isDangerousCommand 硬线 | 保留（拦截优先于沙箱，省一次无谓执行） |
| resolveCwd 钳制 | 保留（体验层回退 + 审计；沙箱是第二道硬网，越界写 EPERM） |
| child-monitor 子进程监控 | 保留（ps 轮询兜底 + 进程组收割互补） |
| full 档 | 不进沙箱（显式免责语义） |
| automation unattended | 照常（default 档只读语义不变；沙箱开启时其 bash 同样被包） |
| 数据安全兜底（快照/回收站） | 不相关（应用层 rm/write 工具不走 bash 沙箱） |

## 8. 审计

`eventType` 为自由字符串（types.ts，category 按前缀推导），无需改类型。新增事件：

- `command-safety.sandbox {decision: "info", mode: "workspace-write"}` ——沙箱包装执行时留痕（每命令一条，对齐 cwd-fallback 的 info 级形态；decision 取 `"info"`——`AuditDecision` 联合类型无 "executed"，初稿笔误已勘）；
- 沙箱违规（越界写）**无独立事件**：Seatbelt 违规表现为命令自身报错（EPERM/Operation not permitted）出现在工具输出里，模型可见、用户可见，审计链经既有 command 输出留痕即可——不为它做 sbpl 日志解析（`SYSCALL_LOG` 类机制复杂度高、收益低，不做）。

## 9. 平台矩阵与批次范围

| 平台 | 首批 | 说明 |
|---|---|---|
| macOS（桌面端） | ✅ Seatbelt | 开发主力平台，零依赖 |
| Windows（桌面端） | 诚实 no-op | P1-2 挂账既定；沿用 child-monitor win32 no-op 先例，现有防线不变，UI 置灰声明 |
| Linux（桌面端） | 诚实 no-op | 挂账预埋 Landlock 有实现难点：Landlock 是内核 LSM syscall，必须由被限进程自身调用，无法像 sandbox-exec 外部包装——需打包 C launcher（引入平台编译产物，与「平台 binding 永不硬声明」纪律冲突）；二批在 Landlock launcher vs bubblewrap 间裁定 |
| headless server | 不动 | Docker 部署已有容器边界；且 bash 工具双份文件会牵扯 drift manifest 基线；二批评估 |

## 10. 测试方案

- **profile.ts 纯函数单测**：workspace 普通路径 / 含空格 / 含引号 / 含中文 / TMPDIR 解析（`/var/folders` → `/private/var/folders`）各断言生成文本。
- **seatbelt 真跑集成**（`tests/security/sandbox-seatbelt.test.ts`，darwin only，`process.platform` 守卫跳过）：
  - workspace 内写文件成功；
  - 越界写（如 `$HOME/.tianshu-sandbox-probe`）返回 EPERM/失败；
  - 原命令含 `$(...)` 命令替换混淆时越界写仍被拒（静态分析极限的正面对照锚）；
  - 透传路径：runner 不可用时命令原样执行（fail-open）。
- **command-tool 桩测**：注入桩 runner 断言 wrap 调用条件（enabled × available × 非 full 三合成），复用现有 CommandContext 注入面。
- **runToolCall 集成**：command-gate-integration 同款挂链，断言沙箱开启不改变判定链行为（审批/拦截面零变化）。

## 11. 已知限制（诚实声明）

1. **网络面维持现状**：`curl evil.com` 直连绕域名白名单的洞保留（裁定 #2 知情代价），网络防线仍是 cmdAsk 名单 + NetworkGate 进程内拦截。
2. **win32/Linux 首批无沙箱**：两平台 bash 防线仍是应用层静态分析全量承担。
3. **沙箱不防读**：读敏感文件由 file-gate（应用层）管，OS 级不设读限制。
4. **sandbox-exec deprecated 风险**：Apple 若移除则自动降级透传（fail-open），沙箱保护静默消失——available() 探测 + 安全中心开关卡显示当前生效状态缓解可见性。
5. **首版全局开关**：无 per-workspace 差异化（多工作空间统一语义）。
6. **未绑定工作空间时保护降级**：锚点落家目录（§4.2 锚点语义边界），家目录内写（含 `~/.ssh` 等）不受沙箱拦；该面由 file-gate 应用层与审批链继续承担。
