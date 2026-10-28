# 安全中心（SP2）— 手动验收清单（Electron GUI 走查）

> 适用分支：`worktree security-center-sp2`（f1a175f 设计 + 11f305d 计划 + 功能 8 个 commit：cc9e775 → 6400c93 + 本清单）；自动化验证：`npm run typecheck`/`lint` 零问题、`npm run test` 1549 全绿（143 文件；安全域 tests/security 十一件 73 例，SP2 新增四件——command-policy / child-monitor / command-gate / command-gate-integration）
> 对照文档：`docs/superpowers/specs/2026-09-16-security-center-sp2-design.md`（下称 spec）；实现计划 `docs/superpowers/plans/2026-09-16-security-center-sp2.md`（7 任务 TDD 拆解）
> 前置：`npm run dev` 启动应用并登录；需一个绑定了工作目录的 AI 会话（第 4–7 项触发工具调用）与一个 automation 定时任务（第 8 项）；沙箱总开关默认开启；判定配置每次工具调用现读 SecurityService 内存缓存（写时失效）——规则变更即刻生效，无需重启；审计写入经 500ms 缓冲批量落库——刚触发的记录若未即时出现，点「刷新」或等 30s 轮询

---

## 走查清单

## 一、命令安全二级页（入口 + 三名单 CRUD）

### 1. 沙箱卡片「命令安全」入口点入二级页

- **操作步骤**：点头像菜单 →「设置」→ 左栏「安全中心」，在「沙箱安全」分组点击「命令安全」入口；再点返回（面包屑/返回键）回到首页。
- **预期结果**（spec §7）：SP1 中禁用带「即将上线」角标的命令入口已启用，点击后视图切入命令安全二级页——顶部标题「命令安全」、优先级说明「程序黑名单（绝对禁止，含子进程）＞ 询问名单 ＞ 放行名单 ＞ 默认审批」、右上「重置为默认」按钮、下方依次渲染「程序黑名单」「放行名单」「询问名单」三个区块；返回后回到安全中心首页，文件/网络两个入口维持占位禁用。
- **Commit 区域**：9928771（CommandDetailView + 沙箱卡片入口启用）、6400c93（编辑交互修复）。

### 2. 三名单默认值 + 添加/删除/取消交互 + 黑名单非法输入校验

- **操作步骤**：① 进入二级页观察三名单初始列表；② 点「放行名单」的「添加」，输入 `docker compose` 后点对勾（或按回车）保存，再点「添加」输入任意内容后点叉号（或按 Esc）取消；③ 点任一列表项的删除图标移除一条，再把某一名单的条目全部删空；④ 点「程序黑名单」的「添加」，分别输入 `a/b` 与 `rm rf`（含空格）后确认。
- **预期结果**（spec §6/§7）：① 默认值——程序黑名单含 `rm`、放行名单含 `git push` 与 `npm install`、询问名单含 `curl` 与 `wget`（read-time fallback：此前自行存过名单的环境不受影响）；② 保存后新条目立即入列（放行/询问按空白分词，显示为 `docker compose`），取消则草稿清空且不落库、Esc 不冒泡误关设置框；③ 删除后条目即时消失并持久化；名单删空后显示「暂无条目」空态提示（进入添加态时提示让位给输入框）；④ 非法输入被拒并 toast「仅接受程序名（不含 / \ 或空白）」，不落库——黑名单仅接受裸程序名。
- **Commit 区域**：0502220（SECURITY_DEFAULTS 演进）、9928771（三名单 CRUD + 校验）、6400c93（Escape 阻止冒泡、取消清空草稿、分词去重）。

### 3. 「重置为默认」恢复三名单 + 审计留痕

- **操作步骤**：在第 2 项改动后的状态（新增/删除过条目）下点右上「重置为默认」并确认；然后到审计中心查看最新记录。
- **预期结果**（spec §7/§8）：三名单恢复默认值（黑名单 rm / 放行 git push、npm install / 询问 curl、wget），toast「已重置为默认名单」；审计中心出现一条「命令名单已重置为默认」（config.commandRules.reset，类别徽标「配置」）。
- **Commit 区域**：ac5ee04（security:resetCommandRules IPC + 双语文案）、f515423（事件 key 与 eventType 全点映射勘误）、9928771（按钮接线）。

## 二、人工会话判定门（default / full 模式）

### 4. default 模式：询问名单命中弹审批，批准执行 / 拒绝回喂

- **操作步骤**：在权限模式为 default（默认审批）的绑定目录会话中，让 AI 执行 `curl example.com`；弹审批后先点「允许」观察执行，再让 AI 执行一次 `curl example.com` 并点「拒绝」。
- **预期结果**（spec §4.2）：首次执行前弹审批弹层（询问名单命中，default 模式本就需审批；审计多一条「命令需审批: curl example.com」）；批准后命令执行、结果回喂模型，审计记「命令已获批准」；第二次拒绝后命令不执行，模型收到拒绝回喂，审计记「命令被拒绝」。
- **Commit 区域**：0686f48（runToolCall 判定门接入 + needs-approval 审计）。

### 5. full 模式：裁定 A 生效 + 放行跳审 + 黑名单直拒相对路径

- **操作步骤**：把会话切到完全访问（full）模式，依次让 AI 执行：① `curl example.com`；② `git push`（可加 `--dry-run`）；③ `rm somefile.txt`（工作目录内的相对路径形态）。
- **预期结果**（spec §2/§4.2）：① `curl` **仍然弹审批**——询问名单绝对优先，覆盖完全访问模式（裁定 A），批准才执行；② `git push` **不弹审批直接执行**（放行名单命中跳过常规审批，审计记「命令已放行: git push」）；③ `rm somefile.txt` **被直接拒绝**——危险命令正则只拦绝对路径形态（如 `rm -rf /Users/…`），相对路径由程序黑名单兜底，模型收到「错误: 该命令被命令安全策略禁止（程序黑名单）」，审计记「拦截危险命令: rm somefile.txt」（detail.source=blacklist）。
- **Commit 区域**：cc9e775（判定引擎优先级与基名匹配）、0686f48（ask 无条件审批 / allow 跳审批 / block 直拒）。

## 三、审计中心与 i18n

### 6. 三类新审计事件可见 + en-US 文案跟随

- **操作步骤**：完成第 4/5 项后打开审计中心（卡片态 + 「查看全部」全量视图），确认存在「命令需审批」「命令已放行」「拦截危险命令」记录；切语言到 en-US 重开审计中心与二级页，再切回 zh-CN。
- **预期结果**（spec §8）：三类事件（command-safety.needs-approval / allow-listed / blocked）均带「命令安全」类别徽标与时间戳；en-US 下事件文案跟随（如 "Command requires approval: …"/"Command allow-listed: …"/"Blocked dangerous command: …"），二级页三名单标题/说明/按钮全部切换，无硬编码中文残留。
- **Commit 区域**：ac5ee04（6 个审计事件 key + commandDetail 双语文案）、f515423（key 勘误）、0686f48（事件源写入）。

## 四、子进程穿透监控

### 7. 黑名单程序藏于 `sh -c` 内被终止

- **操作步骤**：先到二级页把 `sleep` 临时加入「程序黑名单」；回会话让 AI 执行 `sh -c 'sleep 30'`；观察命令的执行过程与最终输出，再到二级页把 `sleep` 从黑名单删除、到审计中心刷新查看。
- **预期结果**（spec §5）：数秒内（250ms 轮询快照）`sleep 30` 子进程被 SIGKILL 连同其子树终止——命令未等满 30s 即异常结束（输出异常退出而非正常返回），模型收到执行失败回喂；审计中心出现「已终止黑名单子进程: sleep」（command-safety.child-blocked）；`sh` 本身不在黑名单、不受黑名单拦截（仍走常规审批链），仅穿透的子进程被拦。
- **Commit 区域**：46e81aa（ps 快照进程树轮询 + SIGKILL 子树）、0686f48（黑名单经装配挂载到 command-tool）。

## 五、automation 无人值守

### 8. full 模式定时任务执行询问名单命令被强拒

- **操作步骤**：创建一个完全访问（full）模式的 automation 定时任务，指令让 AI 执行 `curl example.com`；手动触发一轮运行后打开该任务的 run 记录详情。
- **预期结果**（spec §2/§4.2）：任务虽为 full 模式，`curl` 命中询问名单且无人值守（unattended）——**不挂起审批直接拒绝**，模型收到「错误: 无人值守任务不可执行询问名单命令，请从询问名单移除或改为人工会话执行」；run 记录可见该拒绝反馈，审计记「命令被拒绝」（detail.reason=unattended）。无人值守下放行名单命令仍正常执行、其余审批分流行为不变。
- **Commit 区域**：0686f48（unattended 强拒分支 + automation-runner 装配）。

---

## 附录：已知边界与裁定（走查确认，非 bug）

- 子进程监控为**尽力检测**（`ps` 快照 250ms 轮询 + SIGKILL 子树），非内核级拦截——运行极短（<250ms）的黑名单子进程可能逃逸；win32 下 watchCommandTree 为 no-op（顶层拦截完整生效，子进程监控 SP6 评估 PowerShell CIM）。
- 程序黑名单按首 token 基名匹配（`/usr/bin/rm` 与 `rm` 同样命中）；危险命令正则与黑名单互补——前者拦绝对路径危险形态（与沙箱总开关无关、常开），后者拦相对路径裸程序名（随总开关旁路）。
- 询问名单绝对优先（裁定 A）：与放行名单同时命中时 ask 赢；覆盖 full 模式与免审记忆；automation 下 ask 命中一律视为拒绝。
- `sandboxEnabled=false` 时命令判定门整体旁路（回到 SP1 前行为：常规审批链与危险命令正则仍在）；判定引擎异常时装配闭包 fail-open 返回 default，不阻断命令执行。
- 审计事件经 500ms 缓冲批量落库（满 50 条立即 flush），高频操作下列表刷新有亚秒延迟属预期。
- ask 名单可被 shell 包装绕过：tokenize 仅看首 token，`sh -c 'curl …'` 或管道形态不触发询问门（黑名单类有子进程监控兜底，ask 类无）；后续 SP 可对引号内 payload 再扫 ask 前缀。
