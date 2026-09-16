# 安全中心（SP3）— 手动验收清单（Electron GUI 走查）

> 适用分支：`worktree security-center-sp3`（d965346 设计 + 4da4f97 计划 + 功能 6 个 commit 与 1 个走查期 fix：c3daef0 → b9e7a65 + 本清单同批 fix + 本清单）；自动化验证：`npm run typecheck`/`lint` 零问题、`npm run test` 1565 全绿（146 文件；安全域 tests/security 十四件 89 例，SP3 新增三件——file-policy / file-gate / file-gate-integration）
> 对照文档：`docs/superpowers/specs/2026-09-16-security-center-sp3-design.md`（下称 spec）；实现计划 `docs/superpowers/plans/2026-09-16-security-center-sp3.md`（6 任务 TDD 拆解）
> 前置：`npm run dev` 启动应用并登录；需一个绑定了工作目录的 AI 会话（第 4–7 项触发工具调用）与一个 automation 定时任务（第 8 项）；沙箱总开关默认开启；判定配置每次工具调用现读 SecurityService 内存缓存（写时失效）——名单变更即刻生效，无需重启；审计写入经 500ms 缓冲批量落库——刚触发的记录若未即时出现，点「刷新」或等 30s 轮询

---

## 走查清单

## 一、文件安全二级页（入口 + 内置只读区 + 两名单 CRUD）

### 1. 沙箱卡片「文件安全」入口点入二级页 + 内置敏感路径只读区

- **操作步骤**：点头像菜单 →「设置」→ 左栏「安全中心」，在「沙箱安全」分组点击「文件安全」入口；观察二级页内容后点返回（返回键）回到首页。
- **预期结果**（spec §5）：SP1/SP2 中禁用带「即将上线」角标的文件入口已启用，点击后视图切入文件安全二级页——顶部标题「文件安全」、优先级说明「优先级：内置敏感路径（不可删，含应用数据目录）＞ 用户白名单 ＞ 用户黑名单；命中黑名单的读写均需审批（完全访问模式下同样生效）」、右上「重置为默认」按钮、下方依次渲染「内置敏感路径」「用户黑名单」「用户白名单」三个区块；返回后回到安全中心首页，网络入口维持占位禁用。内置区块为只读清单（macOS 17 条：`~/.ssh/`、`~/.aws/`、`~/.gnupg/`、`~/.kube/config`、`~/.docker/config.json`、`~/.netrc`、`~/.npmrc`、`~/Library/Keychains/` 等），每条带「内置」描边徽标、**无删除钮**；说明文案「系统预置的敏感配置路径（SSH 密钥、云凭证等），不可删除或编辑；读写命中即弹审批」。
- **Commit 区域**：b9e7a65（FileDetailView + SandboxCard 入口启用 + SecurityCenter 视图栈 "file" + defaults 透传）、4491087（fileDetail 双语文案）。

### 2. 用户黑/白名单 CRUD 交互 + 空输入校验

- **操作步骤**：① 点「用户黑名单」的「添加」，输入 `~/secrets` 后点对勾（或按回车）保存，再点「添加」输入任意内容后点叉号（或按 Esc）取消；② 点任一列表项的删除图标移除一条，再把某一名单的条目全部删空；③ 点「添加」后不输入直接点对勾。
- **预期结果**（spec §5）：① 保存后新条目立即入列（等宽字体展示），取消则草稿清空且不落库、Esc 不冒泡误关设置框；② 删除后条目即时消失并持久化；名单删空后显示「暂无条目」空态提示（进入添加态时提示让位给输入框）；③ 空输入被拒并 toast「请输入有效命令」，不落库——文件名单仅做非空校验（无程序名格式限制，与命令黑名单不同）；重复条目（空白差异变体）静默去重不入列。
- **Commit 区域**：b9e7a65（RuleSection 自 CommandDetailView 提取共享 + 两名单接线）、6400c93（RuleSection 既有交互语义：Escape 阻止冒泡、取消清空草稿）。

### 3. 「重置为默认」恢复两名单 + 审计留痕

- **操作步骤**：在第 2 项改动后的状态（新增/删除过条目）下点右上「重置为默认」并确认；然后到审计中心查看最新记录。
- **预期结果**（spec §5/§6）：用户黑名单与用户白名单恢复默认值（均为空），内置敏感路径不受影响；toast「已重置为默认名单」；审计中心出现一条「文件名单已重置为默认」（config.fileRules.reset，类别徽标「配置」）。
- **Commit 区域**：4491087（security:resetFileRules IPC + resetDone 文案 + config_fileRules_reset 词条）、b9e7a65（按钮接线）。

## 二、人工会话判定门（default / full 模式）

### 4. full 模式：读内置敏感路径仍弹审批，批准可读 / 拒绝回喂

- **操作步骤**：把绑定目录会话切到完全访问（full）模式，让 AI 读 `~/.ssh/config`（或任一内置路径，如 `~/.netrc`）；弹审批后先点「允许」观察读取，再让 AI 读一次并点「拒绝」。
- **预期结果**（spec §3/§4）：两次读取前均**弹审批弹层**——内置清单命中裁定 block，覆盖完全访问模式，且 read 类文件工具首次进入审批流（此前 read 一律免审）；批准后文件内容回喂模型、审计记「文件操作已获批准」；拒绝后文件不读取，模型收到「用户拒绝了此操作」回喂。每次弹审批前审计多一条「文件访问需审批: ~/.ssh/config」（file-safety.needs-approval，`{{path}}` 为模型请求的原始路径形态）。
- **Commit 区域**：0e38800（runToolCall 文件门——block 无条件审批 + needs-approval 审计）、a713a96（file-gate 单例装配）、c3daef0（判定引擎）。

### 5. 用户黑名单路径读写均弹审批（full 模式同样）；白名单不可绕过内置

- **操作步骤**：① 二级页「用户黑名单」添加 `~/secrets`，回会话（full 模式）让 AI 读 `~/secrets` 下任一文件，再让它往 `~/secrets` 写一个文件；② 再往「用户白名单」添加 `~/.ssh`，让 AI 读 `~/.ssh/config`。
- **预期结果**（spec §2/§3）：① 读写均弹审批——block 对 read/write 无差别（write 本就需审批、read 由文件门拉进审批流），批准才执行、拒绝回喂同第 4 项，default 模式同样弹审批；② `~/.ssh` 虽入白名单，读取 `~/.ssh/config` **仍弹审批**——内置清单优先级最高，用户白名单不可绕过（裁定：内置 ＞ 用户白 ＞ 用户黑）。
- **Commit 区域**：0e38800（文件门接入执行链）、c3daef0（优先级矩阵：内置最高）。

### 6. 用户白名单放行工作空间子目录：写操作免审批

- **操作步骤**：① 在 default（默认审批）模式的会话让 AI 写工作空间下新子目录 `build/out.js`，观察弹审批（可拒绝）；② 二级页「用户白名单」添加 `build`（工作空间相对形态）；③ 再让 AI 写 `build/out2.js`。
- **预期结果**（spec §3/§4）：① 写 `build/out.js` 弹审批（default 模式写操作本就需审批的现状行为）；② 白名单命中后写 `build/out2.js` **不弹审批直接执行**——allow 跳过常规写审批（亦无需免审记忆），审计多一条「文件访问已放行: build/out2.js」（file-safety.allow-listed）；③ 相对条目按工作目录解析（`build` → `<工作目录>/build`），清单更新即刻生效无需重启。
- **Commit 区域**：0e38800（allow 跳审批分支 + allow-listed 审计）、c3daef0（相对条目 workspace resolve）。

## 三、审计中心与 i18n

### 7. 三类新审计事件可见 + {{path}} 渲染 + en-US 文案跟随

- **操作步骤**：完成第 3–6 项后打开审计中心（卡片态 + 「查看全部」全量视图），确认存在「文件访问需审批」「文件访问已放行」「文件名单已重置为默认」记录并核对 `{{path}}` 渲染内容；切语言到 en-US 重开审计中心与文件二级页，再切回 zh-CN。
- **预期结果**（spec §6/§8）：文件事件带「文件安全」类别徽标（重置事件为「配置」）与时间戳；`{{path}}` 显示模型请求的原始相对路径（如 `~/.ssh/config`、`build/out2.js`），非解析后的绝对路径；en-US 下事件文案跟随（"File access requires approval: …"/"File access allow-listed: …"/"File lists reset to defaults"），二级页标题/优先级说明/三区块标题/按钮全部切换，无硬编码中文残留。
- **Commit 区域**：4491087（3 个审计事件 key + fileDetail 双语词条）、0e38800（AuditCenter entryText 兜底变量加 path + 事件源写入）。

## 四、automation 无人值守

### 8. full 模式定时任务读取黑名单路径被强拒

- **操作步骤**：创建一个完全访问（full）模式的 automation 定时任务，指令让 AI 读取黑名单路径（如 `~/secrets/k.pem` 或 `~/.ssh/config`）；手动触发一轮运行后打开该任务的 run 记录详情。
- **预期结果**（spec §2/§4）：任务虽为 full 模式，路径命中黑名单且无人值守（unattended）——**不挂起审批直接拒绝**，模型收到「错误: 无人值守任务不可访问黑名单路径，请调整名单或改为人工会话执行」；run 记录可见该拒绝反馈；审计行显示「文件操作被拒绝: <被拒路径>」（file-safety.rejected，detail.reason=unattended；词条插值 `{{summary}}` 经兜底链回退渲染 detail.path，如 `secret/k.pem`）。无人值守下白名单命中仍正常执行、其余审批分流行为不变。
- **Commit 区域**：0e38800（unattended 强拒分支 + automation-runner 装配 decideFileAccess）、本清单同批 fix（AuditCenter entryText summary 兜底回退 path——无该回退时本事件 detail 仅 path/reason，`{{summary}}` 为空悬空冒号）。

---

## 附录：已知边界与裁定（走查确认，非 bug）

- 名单匹配**不做 glob**（spec §1 已知边界）：条目仅做「去尾 `*` 清洗」——`/dir/*` 归一化为 `/dir`（效果为整目录保护），不解析任何通配符语义；`*.pem` 这类通配符开头的条目清洗后为空串，恒不命中（等效无效条目）。归一化为循环剥离至稳定（c3daef0 初版单次剥离会留下 `/dir/*` 形态死规则，0cec111 修复）。
- **search_files 不受名单约束**：文件门仅覆盖 read_file / write_file / list_dir 三件（FILE_GATE_TOOLS），search_files 不经门——黑名单路径内的文件名可能经搜索结果回喂模型（后续 SP 评估纳入）。
- 审计 **detail.path 记录模型请求的原始相对路径**（截 200 字符），非 resolveSafePath 解析后的绝对路径——核对命中情况时需自行换算绝对形态。
- unattended 文件拒绝审计行的词条插值 `{{summary}}` 在该事件下为空（detail 只有 path/reason）——AuditCenter entryText 的 summary 兜底链已回退 path 修复此悬空冒号（渲染为「文件操作被拒绝: <被拒路径>」），修复前形态为『文件操作被拒绝: 』冒号后为空。
- 内置清单 macOS 17 条 / win32 16 条（剔除 `~/Library/Keychains/`）；「不可删」为三层防删——UI 只读区无删除钮、判定引擎静态内置优先、用户黑名单保存时自动剔除与内置清单相同的条目（stripBuiltinItems 双保险）。
- needs-approval 事件 detail.source 统一为 `"blocklist"`（spec 勘误，计划期裁定）：判定引擎不返回命中来源，无法区分内置/用户黑名单。
- `sandboxEnabled=false` 时文件判定门整体旁路（回到 SP2 前文件行为：常规审批链仍在）；fail-open 三层——getConfigValue 抛错、decider 抛错、gate 未安装均回落 `"default"`，不阻断文件操作。
- list_dir 无 path 参数不判定（直执行）；路径解析失败（resolveSafePath 工作目录越界抛错）同样不经门——越界防护由既有 resolveSafePath 兜底，行为与 SP3 前逐字节一致。
- 名单匹配为「精确文件或目录前缀」双匹配（偏安全两段式）：条目 `~/secrets` 同时保护同名文件与其下任意子路径，同级同名变体（如 `~/secrets2`）不误伤。
- 审计事件经 500ms 缓冲批量落库（满 50 条立即 flush），高频操作下列表刷新有亚秒延迟属预期。
