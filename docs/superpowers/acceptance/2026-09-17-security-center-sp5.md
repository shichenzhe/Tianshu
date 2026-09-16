# 安全中心（SP5）— 手动验收清单（Electron GUI 走查）

> 适用分支：`worktree security-center-sp5`（dd3f104 设计 + dfcfd60 计划 + 功能 7 个 commit：a3ca57e → 15612ae + 本清单）；自动化验证：`npm run typecheck`/`lint` 零问题、`npm run test` 1635 全绿（156 文件；安全域 tests/security 二十三件 157 例，SP5 新增五件——domain-policy / network-gate / local-proxy / mcp-url-gate / renderer-guard，合计 38 例，另 tests/ai/command-tool-proxy 新一件 2 例、既有 config-store / security-service 增补 5 例）
> 对照文档：`docs/superpowers/specs/2026-09-17-security-center-sp5-design.md`（下称 spec）；实现计划 `docs/superpowers/plans/2026-09-17-security-center-sp5.md`（7 任务 TDD 拆解）
> 前置：`npm run dev` 启动应用并登录；需一个绑定了工作目录的 AI 会话（第 4–8 项部分操作经会话触发，涉及 `run_command`）；至少一个已配置模型 provider（其 baseUrl 域自动进豁免面，第 4 项②依赖）；技能市场外网可达用于第 3/4 项对照；二级页入口 = 设置 → 安全中心 → 沙箱安全卡片「网络安全」；网络四配置判定层每次请求实时读配置——改动即刻生效，无需重启会话；审计写入经 500ms 缓冲批量落库——刚触发的记录若未即时出现，点「刷新」或等 30s 轮询

---

## 走查清单

## 一、二级页入口与结构

### 1. SandboxCard「网络安全」入口转正可点 → 二级页结构与返回

- **操作步骤**：打开设置 → 安全中心，观察沙箱安全卡片的三个二级入口行（文件安全 / 命令安全 / 网络安全）；点击「网络安全」行进入二级页，自上而下核对各区块；点「返回」。
- **预期结果**（spec §1/§6/§7）：「网络安全 / 管理网络出入站请求与域名名单」行不再带「即将上线」占位徽标——与文件/命令入口同款可点（hover 背景高亮 + 右箭头）；二级页自上而下：标题「网络安全」+「返回」按钮 → 优先级说明「判定优先级：内置豁免（模型服务/本机）> 拒绝名单 > 允许名单 > 断网模式 > 恶意域拦截；名单支持 \*.example.com 子域通配。」→ 两开关（「断网模式」默认关 /「恶意网站拦截」默认开，各带说明文案）→「拒绝名单」（说明「命中即拒（优先于允许名单）」）→「允许名单」（说明「命中即放行（断网模式下仍然放行）」）→「内置恶意域清单」只读区（默认折叠，点「展开 114 条」逐条展示域名 +「内置」徽标，无删除按钮）→ 底部覆盖边界提示（主进程请求/渲染层图片与链接/遵循代理环境变量的命令子进程；直连 socket 等深层绕过不在本层防护内）。返回回安全中心首页，其余卡片不受影响。
- **Commit 区域**：15612ae（NetworkDetailView 二级页 + SandboxCard 网络入口转正）、5204372（getConfig defaults 暴露内置恶意清单——「展开 114 条」数据源）。

## 二、域名单 CRUD 与归一化

### 2. 拒绝/允许名单增删改：`Example.COM.` 保存显示 `example.com`；`*.example.com` 通配形态

- **操作步骤**：拒绝名单点「添加」，输入 `Example.COM.` 点「保存」；观察列表显示形态；再添加 `*.evil-example.com`；对同一域名重复添加一次；清空输入直接点「保存」；点条目右侧垃圾桶图标删除；允许名单同样加一条（如 `*.trusted.example`）。每步后到审计中心核对。输入态按 Escape。
- **预期结果**（spec §3/§6.1）：`Example.COM.` 保存后列表显示归一化形态 `example.com`（小写、去尾点——服务端 pickDomainArray 逐条 normalizeDomain + 去重保序，界面读回即归一形态）；通配条目 `*.evil-example.com` 原样保存可命中任意深度子域（不含 apex，apex 需另列精确条目）；重复添加同形条目不落第二条（静默关闭编辑行）；空输入 toast「请输入有效内容」；删除即时生效；每次保存审计各一条「安全配置已更新: domainDeny / domainAllow」（config 类）——属 SP1 配置审计既有行为；Escape 仅取消本行编辑、不误关外层设置对话框。
- **Commit 区域**：15612ae（RuleSection 复用接入双名单）、5204372（pickDomainArray 写路径归一化）。

## 三、拒绝名单端到端（fetch 层）

### 3. deny `api.skillhub.cn` → 技能市场页报错 + 审计 network.blocked（source=fetch，rule=deny）

- **操作步骤**：拒绝名单加入 `api.skillhub.cn`（技能市场后端域）；打开 AI 模块技能页「发现」（技能市场）标签并刷新；观察页面加载结果与审计中心（点「刷新」）；切 en-US 重开审计中心核对词条后切回；从拒绝名单移除该域，再刷新技能市场验证恢复。
- **预期结果**（spec §4/§8/裁定 5/8）：技能市场列表区不出卡片、显示「市场加载失败」+「重试」按钮（主进程 fetch 被策略 Dispatcher 在 undici 层同步拒绝）；审计中心多「已拦截网络请求：api.skillhub.cn（规则：deny，层：fetch）」（类别徽标「网络安全」）——SkillHub 客户端对网络类失败重试 3 次（1s/2s 退避），最多可见 3 条；en-US 渲染 "Blocked network request: api.skillhub.cn (rule: deny, layer: fetch)"、徽标 "Network Security"，host/rule/source 插值正确无悬空；恢复后技能市场卡片正常加载、不再新增拦截审计。
- **【回喂文案强制走查】**（裁定 5）：deny 域触发时用户可见错误须含 host 与规则（如「网络安全策略已拒绝 api.skillhub.cn（规则：deny）」）。已知实现现状：undici 全局 fetch 被拒时的顶层错误为 `TypeError: fetch failed`，策略文案位于 `error.cause`——技能市场页仅显示通用「市场加载失败」，不透传 host/规则。**验收时若只见顶层/通用错误不见策略文案，记为发现**（需工具层解包 cause 后回喂），拦截与审计记录不受影响，仍可按本项核对。
- **Commit 区域**：cb504ff（PolicyDispatcher 包全局 undici dispatcher + network.blocked 审计）。

## 四、断网模式

### 4. 开 blockAllNetwork → 技能市场挂 / 模型对话仍通（豁免）/ `run_command` curl 403（source=proxy，rule=offline）

- **操作步骤**：二级页打开「断网模式」开关；①刷新技能市场；②同会话让 AI 正常对话一轮（如「介绍一下这个工作目录」）；③让 AI 用 run_command 执行 `curl -sI https://example.com`（default 模式 curl 在询问名单、先弹审批再放行）；④把 `example.com` 加入允许名单后再执行同条 curl 对照。走查完关闭「断网模式」。
- **预期结果**（spec §2 裁定 1/2、§4/§5/§8、§3 判定序）：①技能市场挂（「市场加载失败」）+ 审计拦截记录规则为 offline（层 fetch；页面内 SkillHub 图片若触发则层 renderer）；②模型 API 走豁免面绝对优先（provider baseUrl 域 + loopback + 升级域）——对话与工具调用不中断，模型无感知断网；③curl 经子进程 env 注入的本地 CONNECT 代理（127.0.0.1 随机端口）CONNECT 被拒——工具回喂含 curl 报错（如 "Received HTTP code 403 from proxy after CONNECT"，退出码非 0，响应头 `X-Block-Reason: offline`）+ 审计「已拦截网络请求：example.com（规则：offline，层：proxy）」；④允许名单命中放行（allow 压过断网——用户显式 allow 是最强意图表达），curl 正常返回。注意：provider 豁免域为 30s TTL 缓存，新配 provider 后最长 30s 或任一安全配置保存后生效；loopback（localhost/127.0.0.1/::1）恒在 NO_PROXY 不受影响。关闭开关后全部恢复。
- **Commit 区域**：a3ca57e（判定序单源——allow 压断网）、cb504ff（策略层实时读配置）、5f555f0（本地代理 + run_command env 注入）。

## 五、恶意拦截

### 5. 内置清单命中（massgravel.dev）→ 拦截 + 审计 rule=malicious；关开关放行

- **操作步骤**：保持「恶意网站拦截」开（默认开）；让 AI 用 run_command 执行 `curl -sI https://massgravel.dev`（内置清单条目）；核对审计中心；二级页点「展开 114 条」确认 massgravel.dev 在列且带「内置」徽标；关闭「恶意网站拦截」开关再执行同条 curl；重新打开开关再执行一次。
- **预期结果**（spec §7/§8/裁定 7）：开关开启时 curl 返回 403（`X-Block-Reason: malicious`）+ 审计「已拦截网络请求：massgravel.dev（规则：malicious，层：proxy）」；内置清单只读区可见该条目且不可编辑删除（永不落盘，代码常量三层防删同 SP1 先例）；关闭开关后同一 curl **直连成功**（判定点受开关控制，清单仍在但不生效）；重新打开恢复拦截。渲染层同理：markdown 链接/图片指向清单域名时被拒（层 renderer，见第 7 项操作法）。
- **Commit 区域**：a3ca57e（BUILTIN_MALICIOUS_DOMAINS 114 条 + judgeDomain 恶意分支）、5204372（defaults 接线）、cb504ff / 5f555f0（fetch 层与代理层判定消费）。

## 六、MCP http 入口

### 6. deny 域的 http MCP → 连接失败文案含「网络安全策略已拒绝」+ 审计 source=mcp

- **操作步骤**：AI 模块 → 专家·技能·连接器页 → 连接器 tab，新增 http 类型 MCP 服务器，url 填 `https://api.skillhub.cn/mcp`（第 3 项已 deny 该域；或对任意域先加入拒绝名单再配）；保存并启用（或点重连）；观察服务器列表状态列与审计中心；悬停状态文字；随后从拒绝名单移除该域再重连。
- **预期结果**（spec §6/裁定 5/6）：状态列显示「错误」，悬停 tooltip 文案为「网络安全策略已拒绝 api.skillhub.cn（规则：deny）」（assertMcpUrlAllowed 在 SDK transport 构造之前拦截，不发起任何网络请求）；审计多一条「已拦截网络请求：api.skillhub.cn（规则：deny，层：mcp）」；移出拒绝名单后重连状态转「已连接」、工具数正常。stdio 类型 MCP 不校验 command（用户主权），但其子进程 env 合并注入代理变量（`HTTP(S)_PROXY`/`ALL_PROXY`，`NO_PROXY` 恒含 loopback）——可用该 MCP 执行 `printenv HTTPS_PROXY` 间接验证。
- **【回喂文案强制走查同第 3 项】**：若在会话中调用该 MCP 服务器的工具，模型侧回喂为工具层统一文案「错误: MCP 服务不可用（\<名称\>）」——host 与规则以状态列 tooltip 与审计记录为准；策略文案未随工具回喂到达模型对话时，同样记为发现（回喂链路解包 cause）。
- **Commit 区域**：5f555f0（assertMcpUrlAllowed http 入口预判 + mergeStdioEnv）。

## 七、渲染层

### 7. markdown deny 域链接点击不响应 / `<img>` 破图（source=renderer）；普通链接系统浏览器打开

- **操作步骤**：拒绝名单加入一个测试域（如 `blocked.example`，或复用现有 deny 域）；让 AI 输出一段 markdown：含 `[点此](https://blocked.example/x)` 链接与 `![图](https://blocked.example/pixel.png)` 图片；点击该链接、观察图片渲染；再让 AI 输出 `[主页](https://example.com)` 并点击；核对审计中心。
- **预期结果**（spec §6/§8/裁定 3）：deny 链接点击后**无任何新窗口、也不打开系统浏览器**（window.open → setWindowOpenHandler 恒拒内开窗 + handleWindowOpen 判定拒绝）；deny 图片请求被 session.webRequest 判定取消、气泡内显示破图；两处各产生审计「已拦截网络请求：blocked.example（规则：deny，层：renderer）」；普通链接点击后经系统默认浏览器打开（shell.openExternal），**不产生审计**（放行不审计）。en-US 下审计词条同第 3 项（layer: renderer）。浏览器侧流量不设防（系统浏览器不经本层——防线边界如实呈现）。
- **Commit 区域**：f8d3743（session.webRequest 判定 + setWindowOpenHandler + will-navigate 白名单）、6be9891（导航白名单 origin 精确比较修复）。

## 八、回归与旁路

### 8. SP2 命令门 / SP3 文件门 / SP4 批量门抽查 + sandboxEnabled=false 全门旁路回归

- **操作步骤**：① 回归抽查（full 模式会话）：让 AI 读 `/Users/<you>/.ssh/config`；让 AI 执行 `rm -rf bulk`（SP4 清单第 6 项造的目录或任意目录）；让 AI 用 delete_file 删除一个 ≥ 阈值目录（照 SP4 清单第 6 项，阈值可临时调低）；② **旁路回归（强制走查项）**：设置 → 安全中心关闭「沙箱安全」总开关（sandboxEnabled=false），让 AI 用 run_command 依次执行 `curl -sI https://api.skillhub.cn`（拒绝名单仍含该域）与 `printenv HTTPS_PROXY`；刷新技能市场页；点击普通外链；核对审计中心无新增 network.blocked；③ 重新打开沙箱总开关，重复 ② 的 curl。
- **预期结果**（SP2/SP3/SP4 spec + SP5 spec §2 裁定 3）：①三道门行为不变——内置敏感路径读弹审批（「文件访问需审批」，full 模式同样）、`rm` 命中程序黑名单弹「拦截危险命令」（绝对禁止含 full 模式）、大目录 delete_file 弹「批量删除需审批」；②旁路生效：deny 域 curl **直连成功**（判定跳过——policyProvider 返回 null 全门旁路）；`printenv HTTPS_PROXY` 输出为空（本地代理停止且子进程 env 不注入——childProxyEnv 对 null 门返回 undefined）；技能市场正常加载；审计**无**任何新增 network.blocked 记录；点击外链仍经系统浏览器打开（内开窗恒拒保留——应用卫生非沙箱策略，旁路时外开不做判定也不审计）；③重开总开关后同条 curl 立即恢复 403（判定实时读配置，无需重启会话，本地代理按需自动重启）。
- **Commit 区域**：cb504ff（policyProvider null 旁路）、5f555f0（childProxyEnv undefined 零行为变化）、f8d3743（sandboxEnabled 旁路 + 内开窗恒拒保留）。

---

## 附录：已知边界与裁定（走查确认，非 bug）

- **OS 级沙箱不做**（spec §1「不做」/§5 绕过面）：不读 proxy env 的程序、raw socket、自带 DNS 解析拦不住；二级页覆盖边界提示已如实标注——防线退化为 SP2 程序名单 + 审批，OS 级沙箱记 SP6+ 候选。
- **恶意清单为 2026-09-16 静态快照**（114 条，abuse.ch URLhaus + OpenPhish 聚合，defaults.ts 头注/spec §7）：静态代码常量不追新域，未收录不代表安全；防护面 = 清单命中 + 用户 domainDeny；随发版更新，云情报在路线图外。
- **子进程代理无上游链式转发**（local-proxy.ts 头注/spec 自审勘误③——§5 原设计降级为 v1 不做）：app 自身配置了代理且子进程门同开时，子进程经本地代理**直连**目标（不经企业上游代理），域名判定仍然生效。
- **本地代理启动失败无审计 failed 事件**（Application.ts syncProxyLifecycle 仅 Log.error；spec §9 原拟「降级 + 审计 failed」，实现收敛为仅 winston 日志）：失败时子进程网络维持现状（不注入 env），主进程 undici 策略层不受影响。
- **session 守卫仅挂 defaultSession**；`installSessionGuard` 无单测（Electron 薄壳代码审视过——handleWindowOpen / shouldAllowNavigation 纯函数有单测覆盖，装配层零逻辑）；自定义 partition 的 session 不设防。
- **恶意域匹配为精确条目**（domainMatches 无隐式子域匹配）：`x.massgravel.dev` 不命中内置条目 `massgravel.dev`；需覆盖子域时在用户名单显式添加 `*.massgravel.dev`（用户 deny 名单可与内置清单互补）。
- **回喂文案顶层错误为 `TypeError: fetch failed`**（策略文案位于 error.cause）：技能市场页与 MCP 工具回喂均不透传 host + 规则——第 3/6 项强制走查记为**发现**，待工具层统一解包 cause（审计与判定不受影响）。
- **豁免面 provider 域为 30s TTL 缓存**（Application.ts）：新配置 provider 后其域名最长 30s 进豁免面，任一安全配置保存即提前刷新；读取失败豁免面退化为 loopback + 升级域并 winston error（方向安全，可能误伤 provider 自身，有日志可查）。
- **判定层 fail-open**（spec §9）：策略求值抛异常 / 非 URL origin（unix socket 等）/ 非法 URL 时透传放行——策略层绝不制造断网；审计发射失败不影响拦截路径。放行不审计（默认开放姿态，裁定 8）。
- **network_blocked 审计 host 截 200 字符**；事件经 500ms 缓冲批量落库（同 SP4），高频拦截下列表刷新有亚秒延迟属预期；守卫测试 known 事件表已登记 `network.blocked`（防死键回退）。
