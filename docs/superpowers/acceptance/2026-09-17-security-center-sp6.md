# 安全中心（SP6）— 手动验收清单（Electron GUI 走查）

> 适用分支：`worktree-security-center-sp6`（ef6a24c 设计 + a223199 计划 + 功能 commit 链依序：e12f9c8 T1 配置基座 → 76a5730 T1 勘误 → 30d7d98 T2 注入接入 → 68fe134 T3 系统授权 IPC → 52916a8 audit 词条 key 连字符勘误 → 681774a T4 前端二级页与系统授权卡 → b321873 开关 aria-label → 8de8b72 T5 cause 解包 + 代理加固 → b487b3f T5 fix 拒绝路径 socket 纳入 stop 清理 → 81bf75e 用例标题勘误 → 本清单）；自动化验证：`npm run typecheck`/`lint` 零问题、`npm run test` **1677 全绿（160 文件**；SP6 起点 1642（SP5 合并后 157 文件）归因账：T1 e12f9c8 +10（disabled-tools 新件 6 + config-store +2 + security-service +2）→ T2 30d7d98 +1（automation collectTools 集成）→ T3 68fe134 +8（permission-store 新件 1 + chat.service +7）→ T4 681774a +9（security-components：SandboxCard 第四入口 1 + SystemGrantCard 5 + RuntimeDetailView 3）→ T5 8de8b72 +6（error-message-with-cause 新件 2 + network-gate 1 + mcp-manager 1 + local-proxy 2）→ T5 fix b487b3f +1（被拒 CONNECT socket 兜底清理）；新增测试文件三件——disabled-tools / permission-store / error-message-with-cause，157+3=160）
> 对照文档：`docs/superpowers/specs/2026-09-17-security-center-sp6-design.md`（下称 spec）；实现计划 `docs/superpowers/plans/2026-09-17-security-center-sp6.md`（6 任务 TDD 拆解）
> 前置：`npm run dev` 启动应用并登录；需至少一个绑定了工作空间的 AI 会话（第 4/5/6 项经会话触发）；至少一个已配置模型 provider；技能市场外网可达用于第 7 项与第 8 项对照；二级页入口 = 设置 → 安全中心 → 沙箱安全卡片「运行时工具」；`disabledTools` 过滤为闭包实时读配置——开关改动自下一轮工具注入起生效，无需重启会话；审计写入经 500ms 缓冲批量落库——刚触发的记录若未即时出现，点「刷新」或等 30s 轮询；完全访问（full）与工具记忆的判定态在主进程，界面列表为打开设置对话框时拉取——其它会话新产生的授权需重开对话框刷新

---

## 走查清单

## 一、首页四卡结构与系统授权卡空态

### 1. 首页四卡齐整 + 系统授权卡两区块空态与禁用按钮

- **操作步骤**：打开设置 → 安全中心，自上而下核对卡片分组；观察系统授权卡两区块的空态文案与操作按钮可用态；切 en-US 重开设置对话框逐区块核对词条后切回。
- **预期结果**（spec §4/§1「收尾」）：首页自上而下四卡「沙箱安全 / 数据安全 / 系统授权 / 审计中心」；沙箱卡共四个二级入口行——文件安全 / 命令安全 / 网络安全 / **运行时工具**（新增，icon 扳手，说明「控制 AI 可用的内置工具」），四行均带右箭头可点、无「即将上线」占位；系统授权卡说明行「管理 AI 当前被授予的权限」，两区块：「活跃完全访问」（说明「以下会话已跳过文件写入与命令审批」）空态显「当前没有完全访问会话」+ 右下「一键收回全部」按钮**禁用**；「工作空间工具记忆」（说明「『允许并记住』产生的免审记录，撤销后回到逐次审批」）空态显「暂无工具记忆」+「全部撤销」按钮**禁用**（count=0 不触发 IPC 不审计，spec §4.1）；en-US 对应 "System grants" / "Active full access" / "No full-access sessions" / "No tool memories" 等（security.json systemGrant 块双语逐 key）。
- **Commit 区域**：681774a（SystemGrantCard 首页第四卡 + SandboxCard 第四入口行）。

## 二、运行时工具二级页

### 2. 四组 13 开关：分组、kind 徽标与说明文案；toggle 即存

- **操作步骤**：点「运行时工具」行进入二级页，自上而下核对四组与全部开关行；键盘聚焦任一开关核对可读名（读屏/aria-label）；关闭 `read_file` 开关再重新打开；点「返回」。
- **预期结果**（spec §5/§3.1）：页面 = 标题「运行时工具」+「返回」+ 说明「关闭的工具对本机所有 AI 会话与自动化隐藏，即刻生效」；按四组小标题分组，共 **13 行开关默认全开**——「文件」5 行（`read_file` 读 / `list_dir` 读 / `search_files` 读 / `write_file` 写 / `delete_file` 写）、「命令」1 行（`run_command` 写）、「技能」2 行（`read_skill` 读 / `create_skill` 写）、「计划」5 行（`plan_create_item` 写 / `plan_update_status` 写 / `plan_append_summary` 写 / `plan_list_items` 读 / `plan_get_item` 读）；每行 = 等宽工具名 + 徽标「读/写」+ 一句话说明（如 `delete_file`：「删除文件或目录（受数据安全保护）」）+ 开关；开关 aria-label 为**可见工具名本身**（label-in-name，非冗余描述）；toggle 即时经 setConfig 保存、数组保持注册表序，审计各落一条「安全配置已更新: disabledTools」（config 类）；返回回安全中心首页，其余卡片不受影响。
- **Commit 区域**：e12f9c8（BUILTIN_TOOLS 注册表——defaults.builtinTools 下发数据源）、681774a（RuntimeDetailView 四组渲染）、b321873（aria-label 改可见工具名）。

## 三、工具禁用端到端

### 3. 禁 `run_command` → 对话内模型无此工具 → 自动化同样 → 重开恢复

- **操作步骤**：运行时工具页关闭 `run_command`；回到 AI 会话让 AI「列出你当前可用的工具」或直接让它执行 `echo hello`；再建（或运行）一个含命令步骤的自动化任务观察；运行时工具页重新打开 `run_command`，同一会话再让 AI 执行 `echo hello`。
- **预期结果**（spec §3.2/§3.3/裁定 1/2/8）：对话内模型工具列表**不含 run_command**——模型自述无该工具/无法执行命令（转述不可用，不会报"工具调用失败"类错误）；自动化任务运行同样不注入该工具；其余 12 个内置工具与会话内 MCP 工具不受影响；重开开关后**下一轮对话即恢复**可执行（闭包实时读配置，无需重启会话/应用）；每次 toggle 审计「安全配置已更新: disabledTools」。注意禁用语义 = 注入层过滤（对模型不存在），被禁工具不存在"调用被拒回执"，也不产生执行类审计。
- **Commit 区域**：e12f9c8（filterDisabledTools + pickDisabledTools 白名单清洗）、30d7d98（chat `collectToolDefinitions` / automation `collectTools` 双注入点 + Application 三处装配 :290/:333/:337）。

## 四、full 会话管理

### 4. 对话切完全访问 → 卡片列表出现 → 一键收回 → 胶囊回默认 + 审计

- **操作步骤**：AI 会话输入区上方点权限胶囊 → 开「允许完全访问」→ FullAccessModal 勾选风险确认并确认；发一轮含文件写入或命令的消息体验免审直行；打开设置 → 安全中心 → 系统授权卡「活跃完全访问」；点「一键收回全部」→ 核对确认弹窗文案 → 确认；回会话页**切到别的会话再切回**观察胶囊；让 AI 再执行同类写操作观察审批回归；审计中心核对（点「刷新」；切 en-US 重开核对词条后切回）。
- **预期结果**（spec §4.1/§7）：切完全访问后胶囊显「完全访问」（解锁图标、主色）；系统授权卡列出该会话标题 +「完全访问」徽标，按钮转为可用；一键收回经 AlertDialog（「收回后这些会话回到逐次审批。继续？」destructive 确认按钮）→ 列表即时清空 + toast「已撤销」+ 审计「收回全部完全访问（1 个会话）」（info，类别徽标「配置」）；en-US 渲染 "Revoked all full access (1 sessions)"（词条 key 为**连字符保留形** `permission_full-revoked`——eventMessageKey 只把点替换为下划线；**若审计中心显示原始 eventType 字符串 `permission.full-revoked` 即为词条缺失缺陷**）；胶囊回显「默认权限」需会话页重挂载（切会话往返即可）——主进程侧收回**即时生效**：收回后下一轮文件写入/命令执行即恢复审批，不依赖胶囊显示；无 full 会话时按钮禁用、点击不可达、不产生审计（spec §8）。
- **Commit 区域**：68fe134（listFullGrants / revokeAllFull IPC + `permission.full-revoked` 审计）、681774a（SystemGrantCard 列表与收回 UI + 双语词条）、52916a8（audit 词条 key 连字符勘误）。

## 五、工具记忆管理

### 5. 「允许并记住」产生记忆 → 卡片列出 → 撤销后同工具回到审批弹窗 + 审计

- **操作步骤**：default 权限、绑定工作空间的会话让 AI 执行一条会弹审批的命令（如 `uname -a`）→ 审批横幅点「允许并记住」；再让 AI 执行同工具命令观察免审；打开系统授权卡「工作空间工具记忆」核对行内容；点该行「撤销」；再让 AI 执行同类命令观察审批弹窗回归；再造一条记忆后点「全部撤销」并确认；审计中心核对三条记录（zh + en-US）。
- **预期结果**（spec §4.2/§7）：「允许并记住」后本次放行 + 审计「工具已加入免审记忆: run_command」（SP2 既有行为）；后续同工作空间 run_command 免审直行；系统授权卡记忆行 = 工作空间名 + 等宽工具名 `run_command` + 时间（yyyy/M/d HH:mm:ss）；行内「撤销」→ 行即时消失 + toast「已撤销」+ 审计「撤销工具记忆：run_command（<工作空间名>）」；**撤销后同工具再次执行重新弹审批**（回到逐次审批流——免审记忆语义闭环）；「全部撤销」经 AlertDialog（「将撤销全部工具记忆，继续？」）→ 列表清空 + 审计「撤销全部工具记忆（N 条）」；en-US 渲染 "Revoked tool memory: run_command (…)" / "Revoked all tool memories (N)"（词条 key 同为连字符保留形 `permission_remembered-revoked` / `permission_remembered-revoked-all`；**显示原始 eventType 即词条缺失缺陷**）；三条 permission.* 记录类别徽标均为「配置」（落缺省 config category）。
- **Commit 区域**：68fe134（listRemembered / revokeRemembered / revokeAllRemembered IPC + 审计两事件）、681774a（记忆列表 UI + 双语词条）、52916a8（词条 key 勘误）。

## 六、SP5 发现项闭环：MCP 工具回喂策略文案（强制走查项）

### 6. deny 域 MCP 工具调用 → 模型回喂含「网络安全策略已拒绝 host（规则：deny）」

- **操作步骤**：连接器新增 http 类型 MCP 服务器（url 如 `https://api.skillhub.cn/mcp`）并**保持拒绝名单不含该域**，保存启用至状态「已连接」；再把该域加入拒绝名单（判定实时读配置，无需重连）；会话中（挂该 MCP）让 AI 调用该服务器的任一工具，观察工具回喂原文与审计中心；从拒绝名单移除该域后重试。
- **预期结果**（spec §6.1/裁定 6；SP5 清单第 3/6 项发现项闭环）：工具回喂可见策略文案全文——「错误: MCP 服务不可用（\<名称\>）：fetch failed：网络安全策略已拒绝 api.skillhub.cn（规则：deny）」（cause 解包后拼接，模型能点名被拒对象与规则、据此停止盲目重试——SP5 裁定 5 在 MCP 面落地）；审计新增「已拦截网络请求：api.skillhub.cn（规则：deny，层：fetch）」（调用期经 undici 策略层拦截；连接期预判拦的是层 mcp、tooltip 策略文案，为 SP5 第 6 项既有行为不受影响）；移出拒绝名单后同工具恢复正常回喂。**本项为强制走查项：回喂中见不到「网络安全策略已拒绝…」段即记为发现。**
- **Commit 区域**：8de8b72（error-message-with-cause 共享解包 + mcp-manager callTool 回喂接入）；网络判定层为 SP5 既有（cb504ff / 5f555f0）。

## 七、技能市场 deny 错误展示

### 7. deny `api.skillhub.cn` → 列表区错误卡 + 安装 toast 含策略文案

- **操作步骤**：拒绝名单加入 `api.skillhub.cn`；技能市场「发现」页刷新并搜索/换分类观察列表区；对缓存中可见的技能卡点「安装」观察 toast；审计中心核对；移出该域刷新验证恢复。
- **预期结果**（spec §6.1；SP5 清单第 3 项对照）：列表区不出卡片、显「市场加载失败」+「重试」按钮——该分支为通用文案，**不渲染**策略文案（边界见附录）；**策略文案的可见面 = 安装 toast**：点「安装」后（网络类失败重试 3 次退避后穷尽）toast 显「安装失败: fetch failed：网络安全策略已拒绝 api.skillhub.cn（规则：deny）」——cause 解包后的文案经 IPC 透传 + mapIpcError 未知消息原样透传直达渲染层，host 与规则可见；审计「已拦截网络请求：api.skillhub.cn（规则：deny，层：fetch）」最多可见 3 条（重试所致）；en-US 下 toast 为 "Install failed: " 前缀 + 透传的策略文案（策略文案为主进程中文常量，不随界面语言切换）；恢复后市场正常加载、安装成功。
- **Commit 区域**：8de8b72（skillhub-client 上抛处换 errorMessageWithCause；IPC handler 透传零改动）。

## 八、回归与旁路

### 8. SP2–SP5 四清单关键项抽查 + sandboxEnabled=false 旁路（含运行时开关独立性）

- **操作步骤**：① 回归抽查：full 模式会话让 AI 读 `/Users/<you>/.ssh/config`（内置敏感路径）；执行 `rm -rf bulk`（程序黑名单）；用 delete_file 删 ≥ 阈值目录（SP4 清单第 6 项手法）；default 模式执行 ask 名单内命令（如 `curl -sI https://example.com`）；② **旁路（强制走查项）**：关闭「沙箱安全」总开关 → 让 AI 执行 `curl -sI https://api.skillhub.cn`（拒绝名单仍含该域）与 `printenv HTTPS_PROXY`；刷新技能市场；同时观察第 3 项被禁的工具（若保持禁用）在对话内是否重新可见；核对审计中心无新增 network.blocked；③ 重开沙箱总开关，重复 ② 的 curl。
- **预期结果**（SP2/SP3/SP4/SP5 spec + spec §1 边界）：①四道门行为不变——内置敏感路径读弹审批、`rm` 命中黑名单绝对禁止（含 full 模式）、大目录删除弹批量审批、ask 命令弹审批；②旁路生效：deny 域 curl **直连成功**、`printenv HTTPS_PROXY` 为空、技能市场正常加载、审计无新增 network.blocked（policyProvider 返回 null 全网络门旁路）；**运行时工具开关不受沙箱总开关影响**——保持禁用的工具在旁路下依然对模型不可见（disabledTools 为注入层能力管理，独立于沙箱策略判定层）；③重开后同条 curl 立即恢复 403（判定实时读配置，本地代理按需自动重启）。
- **Commit 区域**：30d7d98（disabledTools 注入在旁路面之外独立生效）；旁路本身为 SP5 既有（cb504ff policyProvider null / f8d3743 sandboxEnabled 旁路），照 SP5 清单第 8 项复核。

---

## 附录：已知边界与裁定（走查确认，非 bug）

- **OS 级沙箱不做**（spec §1「不做」）：不读 proxy env 的程序、raw socket、自带 DNS 解析拦不住；SP6 维持 SP5 附录同款边界与现状防线（env 注入代理 + 程序名单 + 审批），OS 级沙箱仍为路线图候选。
- **MCP 动态工具不在开关面**（spec §1/裁定 3）：disabledTools 白名单只收 13 个内置名，`mcp__*` 一律不收——MCP 准入由连接器白名单 + http 入口预判两道门承担；历史脏名/拼错名读取时静默剔除（pickDisabledTools，防配置漂移）。
- **full 收回不中断进行中审批**（spec §4.1/§8）：revokeAllFull 只改主进程内存态，已挂起的审批卡片照常决议；PermissionStore 不持久化（P3 语义随进程生命周期），应用重启后 full 会话与卡片列表自然清空，无需手工清理。
- **permission.* 审计落 config category**（裁定 4，零 schema 变更）：三条事件类别徽标均显「配置」；守卫测试 known 事件表已登记三事件（防死键回退）；eventMessageKey 只把点替换为下划线、**连字符保留**——审计中心显示原始 eventType 字符串即为词条缺失缺陷（第 4/5 项走查判据）。
- **系统授权卡为挂载时拉取**：SecurityCenter 配置与授权列表在打开时一次拉取——设置对话框开着时其它会话新产生的 full/记忆不自动出现，重开对话框（或「返回」再进）即刷新；不会误显过期数据之外的状态。
- **胶囊显示与主进程实态可能短暂不一致**：ChatPane 权限胶囊为挂载时初始化的本地态、不轮询——一键收回后主进程已按 default 判定（下轮执行即审批），胶囊回显「默认权限」需会话重挂载（切会话往返）。
- **禁用语义 = 对模型不存在**（裁定 1）：被禁工具无"调用被拒"回执与执行类审计；会话进行中已注入的工具集到下一轮消息才刷新（切换即刻生效指下一轮注入）。
- **标题/空间名回落文案**（spec §8）：会话标题查询失败的行显「会话 #\<id\>」、工作空间查询失败显「#\<workspaceId\>」——单行回落不整表失败；撤销不存在的记忆 id 为幂等 no-op、不审计（正常 UI 不可达）。
- **回喂/上抛文案的解包边界**：errorMessageWithCause 无 cause 时仅顶层 message、非 Error 输入 String 化；undici 拒绝的拼接形态为「fetch failed：网络安全策略已拒绝 …」——顶层段保留（第 6/7 项预期文案即含两段）。
- **本地代理 stop 兜底清连接**（8de8b72 + b487b3f）：普通/在途明文连接经 closeAllConnections 终结；CONNECT 隧道（含 403 拒绝端）经隧道集显式 destroy——不依赖 Node 版本的连接追踪行为；closeAllConnections 之后新入 CONNECT 逃过本次 stop 的极窄竞态已知、留观。
- **FIN 断流防护**（8de8b72）：上游平滑关闭（aborted）主动销毁客户端连接——不再悬置；对应用户可见现象为请求以连接终结收尾而非无限等待。
