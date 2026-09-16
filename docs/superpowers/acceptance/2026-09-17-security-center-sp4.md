# 安全中心（SP4）— 手动验收清单（Electron GUI 走查）

> 适用分支：`worktree security-center-sp4`（c238fd0 设计 + b11dc68 计划 + 功能 5 个 commit：ffe583e → 9e37832 + 本清单）；自动化验证：`npm run typecheck`/`lint` 零问题、`npm run test` 1590 全绿（150 文件；安全域 tests/security 十八件 114 例，SP4 新增四件——backup-policy / file-history / delete-file-tool / bulk-delete-gate，合计 23 例）
> 对照文档：`docs/superpowers/specs/2026-09-17-security-center-sp4-design.md`（下称 spec）；实现计划 `docs/superpowers/plans/2026-09-17-security-center-sp4.md`（6 任务 TDD 拆解）
> 前置：`npm run dev` 启动应用并登录；需一个绑定了工作目录的 AI 会话（第 2–6、8 项触发工具调用，删除类操作请明确指示 AI「使用 delete_file 工具删除 …」）与一个 automation 定时任务（第 6 项②）；数据安全默认配置——自动备份开 / 备份总上限 3000MB / 删除保护开 / 批量删除阈值 50（设置 → 安全中心 → 数据安全卡片可调；备份开关、删除保护、阈值三项经闭包**实时读**配置——改动即刻生效，无需重启会话）；审计写入经 500ms 缓冲批量落库——刚触发的记录若未即时出现，点「刷新」或等 30s 轮询；工具层不展开 ~——实际操作时请让 AI 使用绝对路径（如 /Users/<you>/.ssh/config），`~` 字面形态会在工具层报"文件不存在"（read/write/delete 同理）

---

## 走查清单

## 一、自动备份（write_file 覆盖前快照）

### 1. 备份目录结构走查：会话目录 / 内容寻址快照名 / manifest 绝对路径 + 「打开备份目录」直达

- **操作步骤**：先做一遍第 2 项（产生至少一份快照），回到安全中心 → 数据安全卡片点「打开备份目录」；在打开的 `file-history` 目录观察会话子目录结构，用文本编辑器（或 `cat`）查看 `manifest.json`，查看快照文件内容；对被覆盖文件的**覆盖前内容**跑 `shasum -a 256` 比对快照文件名。
- **预期结果**（spec §4）：目录结构为 `file-history/<sessionId>/`——每会话一个子目录，内含 `manifest.json` 与快照文件两类；manifest.json 为可读 JSON 数组，每条 `{ path, hash, at, size }`——**path 为被备份文件的绝对路径**（resolveSafePath 解析后形态，非模型请求的相对路径）、hash 即快照文件名、at 为毫秒时间戳、size 为字节数；快照文件名 = 原文件内容 sha256 十六进制**前 32 字符**（与 `shasum -a 256` 输出前 32 位一致），快照文件内容为覆盖前原文件字节原文；同内容多次备份快照复用（内容寻址天然去重），manifest 各记一行。首次点「打开备份目录」即创建并直达（Finder 打开 userData/file-history）。
- **Commit 区域**：d4af61e（FileHistoryService——目录结构 / 内容寻址快照 / manifest 临时名+rename 原子写）；「打开备份目录」IPC 与按钮为 SP1 既有（security.service.ts openBackupDir——mkdir 后 shell.openPath）。

### 2. default 模式让 AI 覆盖写入既有文件 → 审批通过后快照 + 「文件已备份」审计

- **操作步骤**：在 default（默认审批）模式的绑定目录会话，让 AI 覆盖写入一个既有文件（如「把 notes.txt 内容整体替换为 hello」）；弹审批点「允许」；随后打开审计中心与「打开备份目录」核对。再让 AI 写一个此前不存在的文件（可拒绝该审批）。
- **预期结果**（spec §5/§7）：审批通过后写入正常完成（回喂「已写入 notes.txt（N 字节）」）；file-history 下**当前会话**目录出现 notes.txt 覆盖前内容的快照与 manifest 条目（path 为绝对路径）；审计中心多一条「文件已备份: <绝对路径>（<N> 字节）」（data-safety.backup-created，类别徽标「数据安全」，{{size}} 单位为字节）。新文件写入**不备份**——备份只挂"覆盖既有文件"这一个丢失点；覆盖前弹的写审批为既有 P4 行为（非本 SP 新增）。
- **Commit 区域**：4deba63（write_file 覆盖前 onBackupFile + backupAndAudit 审计）、d4af61e（快照落盘与 manifest 追加）。

### 3. 关闭自动备份开关 → 覆盖写入不再产生快照（审计无 backup-skipped 噪音）

- **操作步骤**：数据安全卡片关闭「自动备份」开关；回会话再让 AI 覆盖写入同一既有文件（审批通过）；核对备份目录与审计中心；重新打开开关再做一次覆盖写入验证恢复。
- **预期结果**（spec §6 装配）：写入照常完成（fail-open，备份缺席不阻塞）；file-history **不新增**快照与 manifest 条目；审计中心**无**「文件备份跳过」记录——备份关闭时装配闭包返回 `{ ok:false, reason:"disabled" }`，工具层对 disabled 静默（不产生 backup-skipped 审计噪音，无痕关闭而非记跳过）；重新打开后下一次覆盖写入恢复快照（闭包实时读，无需重启）。
- **Commit 区域**：71d2d46（Application 装配 backupFile 闭包 disabled 分支）、4deba63（backupAndAudit 对 disabled 静默）。

## 二、delete_file 结构化删除

### 4. `delete_file` 默认移入回收站（Finder 可找回）+ 审计「已移入回收站」

- **操作步骤**：保持删除保护开启（默认），让 AI「使用 delete_file 工具删除 t1.txt」；观察工具回喂后打开 macOS 废纸篓（Finder → 已删除项目）与审计中心；也可让 AI 直接执行 `rm t2.txt` 对照。
- **预期结果**（spec §5）：文件从工作目录消失、**在系统废纸篓可找回**（shell.trashItem 原生行为，不产生任何备份——系统回收站已是兜底，每个丢失点恰好一道兜底）；工具回喂「已将 t1.txt 移入回收站」；审计多一条「已移入回收站: t1.txt」（data-safety.delete-trashed，path 为模型请求的原始路径形态）。对照组 `rm` 走 SP2 程序黑名单被拦截（rm 在默认黑名单——黑名单引导模型改用结构化工具，裁定 #1）。delete_file 在 default 模式仍先弹写审批（kind=write，既有链路）。
- **Commit 区域**：4deba63（delete_file 工具 + trashDelete 分支 + delete-trashed 审计）。

### 5. 关闭删除保护 → 永久删除前逐文件快照 + 审计「已永久删除（N 个文件）」

- **操作步骤**：数据安全卡片关闭「删除保护」开关；让 AI 用 delete_file 删一个含若干文件的目录（如 docs/ 下 3 个文件）与一个单文件；核对备份目录、审计中心与废纸篓；随后**恢复开启**删除保护再删一个文件验证回到回收站模式。
- **预期结果**（spec §5/§7）：目录被递归永久删除（工作目录消失且废纸篓**无**该文件）；删除前树内每个文件先落快照（file-history 出现对应快照与 manifest 条目，审计逐文件一条「文件已备份」）；工具回喂「已永久删除 docs（3 个文件，已备份 3 个）」；审计多一条「已永久删除: docs（3 个文件）」（data-safety.delete-permanent，{{files}} 插值为实际文件数）。开关恢复后下一次删除回到「已移入回收站」（deleteProtection 闭包实时读，改动即刻生效）。若某文件备份失败，删除继续（fail-open）并另发「文件备份跳过: …（<原因>）」。
- **Commit 区域**：4deba63（permanentDelete 先备份后递归删 + delete-permanent 审计）、71d2d46（deleteProtection 装配闭包实时读）。

## 三、批量删除预估门

### 6. 批量阈值：≥ 阈值目录完全访问模式也弹审批；automation（unattended）同任务强拒

- **操作步骤**：① 准备一个 ≥ 阈值的目录（默认 50——终端在工作目录造 `bulk/` 下 60 个文件，或把卡片阈值临时调低到 5 后造 6 个）；把会话切到**完全访问（full）模式**，让 AI 用 delete_file 删该目录，先在审批弹层点「允许」，再对第二个 ≥ 阈值目录点「拒绝」；② 创建一个 full 模式 automation 定时任务，指令同为用 delete_file 删该目录，手动触发一轮运行后查看 run 记录详情与审计中心。
- **预期结果**（spec §6）：① 两次均**弹审批**——批量预估门追加进 needsApproval 组合首位，完全访问模式不豁免；每次弹审批前审计多一条「批量删除需审批: bulk（预估 60 个文件）」（data-safety.bulk-delete-needs-approval，{{estimated}} 为门层预估计数）；批准后照常执行（删除保护开 → 回收站，随后另见「已移入回收站」），拒绝则模型收到用户拒绝回喂。② automation（unattended）**不挂审批直接拒绝**——模型收到「错误: 无人值守任务不可执行批量删除，请调整安全中心阈值或改为人工会话执行」；run 记录可见该反馈；审计行「批量删除已拒绝: bulk（预估 60 个文件）」（data-safety.bulk-delete-rejected，decision=rejected）。低于阈值的目录删除不触发预估门（走常规审批链）。
- **Commit 区域**：71d2d46（resolveBulkDelete 预估门 + needsApproval 追加 + unattended 强拒 + automation 侧可选装配）、d4af61e（countFilesForEstimate 预估计数，达 10000 上限即停）。

## 四、审计 i18n 与 SP3 回归

### 7. en-US 切换后 7 事件渲染正确（插值 path/size/files/estimated）

- **操作步骤**：完成第 2–6 项后（审计中心已积累 7 类 data-safety 事件记录；delete-failed 需制造 trashItem 失败不易触发，可在核对时接受缺失，其余 6 类走查必现），切语言到 en-US 重开审计中心（卡片态 + 「查看全部」全量视图），核对 7 类事件文案与插值变量，再切回 zh-CN。
- **预期结果**（spec §7）：7 事件全部英文渲染且插值正确填充——"File backed up: {{path}} ({{size}} bytes)"、"File backup skipped: {{path}} ({{reason}})"、"Moved to trash: {{path}}"、"Permanently deleted: {{path}} ({{files}} files)"、"Delete failed: {{path}} ({{error}})"、"Bulk delete needs approval: {{path}} (~{{estimated}} files)"、"Bulk delete rejected: {{path}} (~{{estimated}} files)"；类别徽标显示「Data Safety」；无硬编码中文残留、无 {{var}} 悬空空档（AuditCenter entryText 兜底变量链已补 size/reason/files/error/estimated）。切回 zh-CN 文案复原。
- **Commit 区域**：9e37832（7 key 双语词条 + AuditCenter 兜底变量 + 守卫测试 known 列表登记 7 项）。

### 8. SP3 回归：命令门 / 文件门行为不变抽查

- **操作步骤**：① full 模式会话让 AI 读内置敏感路径（绝对路径如 /Users/<you>/.ssh/config）；② 文件安全二级页把工作空间子目录加入「用户白名单」后让 AI 写其下文件；③ 让 AI 执行 `rm -rf bulk` 对照第 4 项；④ 让 AI 用 delete_file 删黑名单路径（如 /Users/<you>/.netrc 绝对形态）。
- **预期结果**（SP3 spec §3/§4）：① 仍弹审批——内置清单最高优先级覆盖完全访问，审计「文件访问需审批: ~/.ssh/config」；② 白名单命中写**免审批**直接执行，审计「文件访问已放行: …」；③ rm 被程序黑名单拦截「拦截危险命令」——命令门行为不变；④ delete_file 已并入文件门 FILE_GATE_TOOLS 四件——黑名单路径删除弹审批（「文件访问需审批」，full 模式同样），unattended 下强拒（FILE_UNATTENDED_OUTPUT）。非 delete_file 工具且两门均 null 时执行链路逐字节不变——SP3 既有测试（file-policy / file-gate / file-gate-integration 等）全绿佐证。
- **Commit 区域**：71d2d46（FILE_GATE_TOOLS 加 "delete_file"——SP3 门语义自然延伸，其余门路径未动）。

---

## 附录：已知边界与裁定（走查确认，非 bug）

- **工具层不展开 ~**：read/write/delete 的路径参数中 `~` 字面形态报"文件不存在"（SP3 同款边界）——实际操作请让 AI 使用绝对路径，或工作空间相对路径。
- **rm 维持 SP2 黑名单语义，不做 rm 侧参数级预估**（spec §1 边界）：rm 在默认程序黑名单（引导模型改用 delete_file），但 `bash -c "rm …"`、`find -delete` 等形态防不住——批量预估只做在 delete_file 结构化工具这一条可信通道上。
- **批量门只对目录生效**：单文件删除 stat 非目录 → 不预估（resolveBulkDelete 返回 null，走常规审批链）；预估计数上限 10000（达限即停——≥ 阈值即触发，无需精确数）；预估失败（权限等）返回 null 走常规链 + winston error（预估是增强非准入）。
- **allow 不豁免批量门**：needsApproval 组合首位 `bulkEstimate !== null` 短路——文件白名单/命令放行名单命中时大目录删除**仍弹审批**（每道门职责单一：白名单只跳过常规写审批）。
- **单文件 >100MB 跳过备份**（reason=oversize，WorkBuddy 同构上限）——审计可见「文件备份跳过: …（oversize）」；备份读/写/manifest 任一失败均 fail-open（不阻塞写入/删除，reason 透传审计 + winston error）。
- **备份关闭 disabled 静默**：不产生 backup-skipped 审计噪音（无痕关闭，非记录跳过）——核对第 3 项时勿误判为审计缺失。
- **trashItem 模式不重复备份**（裁定 #3：每个丢失点恰好一道兜底——write_file 覆盖前 + 永久删除前各一道，回收站交系统兜底）；**trashItem 失败保留文件不降级硬删**（裁定 #6，回喂"移入回收站失败…（文件已保留）" + 「删除失败」failed 审计）。
- **共享快照磁盘双份**：同内容在两个会话目录各落一份快照文件、totalSize 保守求和——配额略提前触发，方向安全；配额 LRU 为跨会话全局淘汰（按 at 升序淘汰最旧至总量 ≤ 3000MB 可配）。
- **manifest 损坏丢弃重建**（快照成孤儿占配额不致损，LRU 下轮自然淘汰）；快照与 manifest 均临时名 + rename 原子落盘（写半途崩溃不留半文件）。
- **审计 path 形态分两种**：backup-created 的 path 为**绝对路径**（快照服务入参，便于按图索骥取回）；delete 系列与 bulk 系列及文件门事件的 path 为模型请求的**原始路径形态**（均截 200 字符）。
- **automation 侧数据安全装配缺省注入**（ExecuteTaskOptions.dataSafety 未传，裁定）：automation 流 deleteProtection 恒走回收站（缺省 true）、无备份回调、批量阈值按缺省 50 判定（非安全中心实时配置）——unattended 对 ≥50 文件目录已有强拒兜底，方向安全（用户调低阈值时 automation 仍按 50 判，不会更宽）。
- **恢复 UI 不做**（SP6 收尾候选）：恢复入口 = 「打开备份目录」手工取回（manifest.path 记录原绝对路径，可还原到任意位置）；**无时间维度清理**（如 30 天 retention 不做——先做已承诺的字节配额 LRU）。
- 配置三项（备份开关/删除保护/批量阈值）闭包实时读：改动即刻生效，无需重启会话（spec 勘误 #4——升级了 spec §5"装配时快照"的原裁定）。
- 审计事件经 500ms 缓冲批量落库（满 50 条立即 flush），高频连续删除下列表刷新有亚秒延迟属预期。
