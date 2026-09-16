# 安全中心 SP5：网络安全执行层 — 设计文档

## 1. 背景与范围

SP1 落了网络安全四配置（`domainAllow`/`domainDeny`/`blockAllNetwork`/`maliciousDomainProtection`）的持久化与 UI 骨架（SandboxCard 网络安全入口 disabled 占位），执行层全部留空——全仓无任何消费点。SP5 补执行层：

1. **主进程 HTTP 策略门**：全仓出站（模型调用/MCP http/SkillHub/连通性测试）统一走 Node 全局 fetch（undici），且 `proxy-dispatcher.ts` 已有唯一 `setGlobalDispatcher` 收口——在此组合策略 Dispatcher，一处覆盖 ~90% 出站点
2. **渲染/Chromium 层**：markdown `<img>`（追踪像素/数据外带）、SkillHub 图标、`window.open` 链接（main.ts 无 `setWindowOpenHandler`）——`session.webRequest.onBeforeRequest` + 窗口开放钩子同判定
3. **子进程代理层**：`run_command` 子进程与 MCP stdio 子进程不经主进程 undici——本地极简 CONNECT 代理 + `HTTPS_PROXY` 等 env 注入，使 `blockAllNetwork`/域名名单对 curl/node/pip 等主流工具有真实效果
4. **网络安全二级页**：两名单 CRUD + 两开关 + 内置恶意清单只读展示（SandboxCard 入口从「即将上线」转正）

**不做**（边界）：
- OS 级沙箱（Seatbelt/bubblewrap/sandbox-runtime）——run_command 深层规避（`nc`、raw socket、自定义 DNS、不尊重 proxy env 的程序）拦不住，记 SP6+ 候选；SP5 以 env 注入代理覆盖尊重代理的主流工具
- 恶意域云情报/实时黑名单——静态代码常量清单（初版固化子集），时效性边界见 §7
- MCP stdio 的 `command` 程序校验——用户自配命令属用户主权（对齐 Claude Code 的 MCP 准入模型：管 http 准入不管本地进程）
- 时间维度/速率限制/请求内容检查（HTTPS 内容不可见，仅域名级）
- 新 IPC 通道——配置读写 SP1 已齐；二级页走既有视图栈模式

## 2. 关键裁定

| # | 裁定 | 依据 |
|---|---|---|
| 1 | 判定序（deny 优先于 allow，allow 压过断网与恶意清单）：**豁免面 → domainDeny → domainAllow → blockAllNetwork → 内置恶意清单 → 缺省放行** | Claude Code "deny 压一切 allow"；用户显式 allow 是最强意图表达，压过断网与内置清单（用户主权） |
| 2 | 豁免面绝对优先（连 domainDeny 也不挡）：provider 表全部 baseUrl 域 + loopback（localhost/127.0.0.1/::1）+ UPGRADE_URL 域（如启用） | 模型 API 架构性豁免（Claude Code 主进程在沙箱外同理）；网络安全中心管 agent 生态流量，不管模型通道本身——想断模型=去关 provider |
| 3 | `sandboxEnabled=false` → 全门旁路（含渲染层判定） | 族语义一致（command-gate.ts:19 / file-gate.ts:17 同款）；仅 `setWindowOpenHandler` 的"拒绝 Electron 内开窗、一律外部浏览器"保留（应用卫生，非沙箱策略） |
| 4 | 子进程走本地 CONNECT 代理 + env 注入，不做 OS 沙箱 | Claude Code 哲学"文本层管意图，代理层管效果"的天枢版最大近似；零新二进制依赖 |
| 5 | deny 可观测：拒绝错误带 host 与规则回喂（`网络安全策略已拒绝 <host>（规则：<deny|malicious|offline>）`） | Claude Code `<sandbox_violations>` 哲学——模型看到被拒对象才能自我修正，拦截是对话的一部分 |
| 6 | MCP http 连接入口预判（URL 域名过判定，拒则不连+审计）；stdio 不校验 command | 单点收口（createDefaultClient）；本地进程用户主权 |
| 7 | 内置恶意清单 = 静态代码常量（永不落盘，三层防删同 SP1 先例），架构支持随版本更新 | 无云情报源；静态清单语义成立、判定点就位，清单内容可迭代 |
| 8 | 审计单事件族 `network.blocked`（detail.source 分层：fetch/proxy/renderer/mcp） | 事件语义统一"策略拒绝"，层与规则进 detail；放行不审计（默认开放，Claude Code 同哲） |

## 3. domain-policy 纯函数（`electron/domains/security/domain-policy.ts`）

无 I/O 的判定层（Vitest 直测）：

```ts
/** 判定输入：豁免域集合 + 四配置（从 SecurityConfig 取网络四项） */
export interface NetworkPolicyState {
  exemptDomains: string[];   // 归一化后：provider 域 + loopback + 升级域
  domainAllow: string[];
  domainDeny: string[];
  blockAllNetwork: boolean;
  maliciousDomainProtection: boolean;
}

/** 判定结果 */
export type NetworkVerdict =
  | { ok: true }
  | { ok: false; host: string; rule: "deny" | "offline" | "malicious" };

/** 域名归一化：小写、去尾点；支持 IP 字面量与 [::1] 形态 */
export function normalizeDomain(input: string): string;

/** 匹配：精确域 或 *.example.com（任意深度子域，不含 apex）；裸 * 全匹配 */
export function domainMatches(pattern: string, host: string): boolean;

/** URL → host（非法 URL 返回 null） */
export function hostFromUrl(url: string): string | null;

/** 判定序（§2 裁定 1/2 的落实，单入口） */
export function judgeDomain(host: string, policy: NetworkPolicyState): NetworkVerdict;

/** 豁免域集合构造：loopback 常量 + provider baseUrl 域 + 升级域（Application 装配用） */
export const LOOPBACK_DOMAINS: string[];
export function buildExemptDomains(providerBaseUrls: string[], upgradeUrl: string): string[];
```

## 4. 主进程策略 Dispatcher（network-gate.ts + proxy-dispatcher 组合）

```ts
/** 策略提供者：dispatch 时实时读（配置改动即刻生效，无需重装） */
export type PolicyProvider = () => NetworkPolicyState | null; // null = 门未装（旁路）

export class NetworkGate {
  /** 装配：向 proxy-dispatcher 注册策略提供者并立即重放一次 */
  install(provider: PolicyProvider, auditSink: SecurityEventSink): void;
  /** 渲染层判定（session.onBeforeRequest / setWindowOpenHandler 消费同一判定） */
  judgeUrl(url: string): NetworkVerdict;
  /** 供测试/MCP 入口复用 */
  judgeHost(host: string): NetworkVerdict;
}
```

- **组合方式**：`proxy-dispatcher.ts` 加模块级 `policyProvider` 槽（`setPolicyProvider()`）；`buildDispatcher` 产物外包 `PolicyDispatcher`（自定义 `Dispatcher` 子类：`dispatch(opts, handler)` 先取 origin hostname → `judgeDomain` → 拒则 `handler.onError` 同步拒绝 + 审计 + 返回；过则透传内层 Agent/ProxyAgent/EnvHttpProxyAgent）。`applyProxyDispatcher` 每次被调（代理设置变更/启动重放）都带策略重包——顺序无关、幂等
- **豁免域实时性**：`PolicyProvider` 内部读 `securityService.getConfigValue()` + provider 域缓存（provider.repo 变更点失效重读）——每次 dispatch 求值，零陈旧
- **性能**：空名单快路径（四配置全默认态仍需查恶意清单+豁免面，Set 查找 O(1)，忽略不计）
- **deny 反馈**：`onError(new Error("网络安全策略已拒绝 <host>（规则：<rule>）"))`——fetch 调用方（AI SDK/MCP/skillhub）收到异常文案，工具层既有错误回喂链路自然把 host 与规则带给模型（裁定 5）
- **审计**：block 时 `network.blocked`（decision=blocked，detail: `{ host, rule, source: "fetch" }`，host 截 200）+ winston warn；放行零开销不审计

## 5. 子进程本地代理（local-proxy.ts）+ env 注入

```ts
export class LocalConnectProxy {
  /** 启动 127.0.0.1 随机端口 http server；处理 CONNECT（及明文绝对 URI 转发） */
  async start(): Promise<number>; // 返回端口
  async stop(): Promise<void>;
}
```

- **判定**：CONNECT 目标 host → `NetworkGate.judgeHost`（同一判定序）；拒 → `HTTP/1.1 403 Forbidden\r\nX-Block-Reason: <rule>\r\n\r\n` 回写并断开（curl 等工具显示 403，模型可见，裁定 5）+ 审计（source: "proxy"）；放行 → 直连目标（若 app 配置了代理则经上游 CONNECT 链式转发）
- **生命周期**：Application 装配时按需启动——`sandboxEnabled=true` 且（`domainAllow/domainDeny` 非空 或 `blockAllNetwork=true` 或 `maliciousDomainProtection=true`，即默认态）即启动；常驻至退出（sandboxEnabled=false 不启动、不注入 env，裁定 3 族旁路）
- **env 注入点**：
  - `command-tool.ts` `runExec` 的 exec options 加 `env`（`CommandContext` 加可选 `commandProxyUrl?: string`——照 `commandWatchBlacklist` 装配快照注入先例）：`{ ...process.env, HTTPS_PROXY, HTTP_PROXY, ALL_PROXY, NO_PROXY: "<loopback>,localhost" }`；未启动代理时 undefined（零行为变化）
  - `mcp-manager.ts` `createDefaultClient` stdio 分支的 `env` 合并注入（同字段；http 分支入口预判见 §6）
- **绕过面**（文档化诚实边界）：不读 proxy env 的程序、raw socket、自带 DNS 解析——SP5 拦不住；防线退化为程序名单+审批（SP2）与 OS 沙箱（SP6+ 候选）

## 6. MCP 与渲染层接入

**MCP 入口预判**（`createDefaultClient` http 分支，依赖注入可测）：

```ts
export async function createDefaultClient(
  row: McpServerConfig,
  checkUrl?: (url: string) => { ok: true } | { ok: false; reason: string },
): Promise<McpClientLike>;
// 拒则抛错（状态机既有 error 路径承接）+ 审计 network.blocked（source: "mcp"）
```

**渲染/Chromium 层**（Application 装配，薄壳+纯函数，照 SP3 file-gate 的 Electron mock 测试模式）：

1. `session.defaultSession.webRequest.onBeforeRequest`：仅 http(s) 请求过 `NetworkGate.judgeUrl`，拒 → `{ cancel: true }` + 审计（source: "renderer"）。覆盖 markdown `<img>`、SkillHub 图标；dev server（localhost）天然在豁免面
2. `win.webContents.setWindowOpenHandler`：**恒拒 Electron 内开窗**；`shell.openExternal(url)` 前过判定——拒则不开 + 审计（source: "renderer"）；sandboxEnabled=false 时判定旁路（裁定 3）但"拒绝内开窗、走系统浏览器"保留
3. `will-navigate`：主窗口导航仅放行 file:// 与 dev server，http(s) 远程一律拒绝（防模型输出把主窗口导航走）

## 7. 内置恶意域清单

- `electron/domains/security/defaults.ts` 加 `BUILTIN_MALICIOUS_DOMAINS`（代码常量，初版 ~80-120 条，来源：URLhaus/PhishTank 公开 feed 固化子集，按域名聚合剔除合法大站误报；采集失败退化保守种子 ~30 条）
- 展示：二级页只读折叠区 + 「内置」标签（照 SP1 内置文件清单合并展示先例）；保存自动剔除（`stripBuiltinItems` 复用）
- 时效边界：静态清单不追新域名，防护面 = 清单命中；后续版本随发版更新，云情报属路线图外

## 8. 审计事件与 i18n

| eventType | decision | detail | 触发点 |
|---|---|---|---|
| `network.blocked` | blocked | host, rule(deny/offline/malicious), source(fetch/proxy/renderer/mcp) | 四层任一拒绝 |

- i18n key：`audit.events.network_blocked`（zh-CN/en-US 同步，插值 `{{host}}`/`{{rule}}`/`{{source}}`；rule/source 以局部化文案插值）
- 守卫测试 known 列表 +1；AuditCenter 兜底变量链补 host/rule/source
- `AuditCategory` 已含 `"network"`（SP1 就位），零 schema 变更

## 9. 错误处理

| 场景 | 处理 |
|---|---|
| PolicyDispatcher 判定抛异常 | fail-open：透传内层（策略层绝不制造断网）+ winston error |
| 本地代理启动失败 | 降级：不注入 env（子进程网络维持现状）+ winston error + 审计 failed；主进程 undici 层不受影响 |
| 代理转发连接失败 | 常规 socket 错误回写客户端（工具层既有错误链路承接） |
| MCP 入口 checkUrl 抛异常 | 视为放行（fail-open，预估/预判是增强非准入同理）+ winston error |
| provider 域缓存读取失败 | 豁免面退化为 loopback+升级域（fail-closed 方向对 provider 自身：模型调用可能被名单误伤，winston error 提示）+ 审计 failed |
| 恶意清单常量含非法形态条目 | normalizeDomain 归一化时静默剔除 |

## 10. 测试策略

- **纯函数单测**（`tests/security/domain-policy.test.ts`）：normalizeDomain（大小写/尾点/IP/IPv6）；domainMatches（精确/`*.` 子域不含 apex/裸 `*`/不匹配形态）；judgeDomain 判定序全路径（豁免压 deny、deny 压 allow、allow 压断网与恶意、断网压恶意、缺省放行）；buildExemptDomains
- **Dispatcher 集成**（`tests/security/network-gate.test.ts`，mock undici dispatcher）：`dispatch` 拒绝路径（onError 收到含 host/rule 文案、审计已发、返回 false）；放行路径透传；策略 null 旁路；代理重放不丢策略（applyProxyDispatcher 二次调用仍带 wrap）
- **本地代理集成**（`tests/security/local-proxy.test.ts`，真起 server）：CONNECT 拒（403+审计）/放行（管道通，用本地 echo 目标）；明文 HTTP 绝对 URI 拒/放；env 注入构造函数（NO_PROXY 含 loopback）
- **MCP 入口**（`tests/security/mcp-url-gate.test.ts`，fake transport 工厂）：http url 拒→抛错+审计、放→透传；stdio env 注入断言
- **渲染层薄壳**（照 SP3 electron mock 模式）：onBeforeRequest 取消逻辑（http 拒/file:// 放/localhost 放）；setWindowOpenHandler 恒拒内开窗 + openExternal 判定
- **守卫测试**：audit-event-message known +1
- **手工验收清单**：二级页名单 CRUD、断网模式端到端（对话内 SkillHub 图标挂、run_command curl 被拒 403、模型 API 仍通）、deny 域回喂文案、恶意清单只读展示、SP3/SP4 回归

## 11. 与 Claude Code / WorkBuddy 的对照

| 维度 | Claude Code | WorkBuddy | 天枢 SP5 |
|---|---|---|---|
| 主拦截点 | OS 沙箱外代理（Seatbelt/bubblewrap 逼流） | NetworkExtension 系统隧道 + CLI 沙箱 | undici 全局策略 Dispatcher（主进程天然收口）+ session 层 + 本地 CONNECT 代理 |
| 模型 API 豁免 | 主进程在沙箱外（架构性） | app 自身在隧道外 | 豁免面绝对优先（provider 域+loopback） |
| 子进程覆盖 | 全覆盖（OS 强制） | 全覆盖（系统隧道） | env 注入代理（尊重代理的工具，诚实边界） |
| 恶意域 | 云预检（api.anthropic.com 黑名单） | 腾讯安全情报 | 静态内置常量清单 |
| deny 反馈 | `<sandbox_violations>` 点名 host | — | 错误文案带 host+规则回喂 |
| 默认姿态 | 开放+首次审批（沙箱 opt-in） | — | 名单外放行（恶意清单默认开） |
