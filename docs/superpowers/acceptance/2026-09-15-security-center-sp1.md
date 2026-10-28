# 安全中心（SP1）— 手动验收清单（Electron GUI 走查）

> 适用分支：`worktree security-center-sp1`（082dc84 设计 + 86bd930 计划 + 功能 14 个 commit：9aba195 → 本清单前序共 13 个 + 本事件源接入 commit + 本清单）；自动化验证：`npm run typecheck`/`lint` 零问题、`npm run test` 1514 全绿（安全域 tests/security 六件 38 例，本任务 +3 command-tool-audit）
> 对照文档：`docs/superpowers/specs/2026-09-15-security-center-sp1-design.md`（下称 spec）；实现计划 `docs/superpowers/plans/2026-09-15-security-center-sp1.md`（11 任务 TDD 拆解）
> 前置：`npm run dev` 启动应用并登录；需一个绑定了工作目录的 AI 会话（第 4/5 项触发工具调用）；数据库升级到 v9（首次启动自动执行 `securityAuditLog` 迁移）；审计写入经 500ms 缓冲批量落库——刚触发的记录若未即时出现，点「刷新」或等 30s 轮询

---

## 走查清单

## 一、设置入口与沙箱

### 1. 设置 → 左栏「安全中心」tab

- **操作步骤**：点头像菜单 →「设置」，观察设置面板左栏。
- **预期结果**（spec §9）：左栏出现「安全中心」tab（Shield 盾牌图标），点击后右侧依次渲染「沙箱安全」「数据安全」「审计中心」三个分组；首次进入配置拉取期间显示「加载中…」短暂过渡。
- **Commit 区域**：9400c3d（SettingsDialog security tab + 首页骨架）、5ccc809（SecurityApi + 双语词条）。

### 2. 沙箱总开关默认开 + 切换持久化

- **操作步骤**：全新环境进入安全中心，观察「沙箱安全」总开关初值；切换一次开关后完全退出应用重启，再次进入观察。
- **预期结果**（spec §5.2）：总开关默认开启；切换后重启保持新值（option 表 type=security 持久化）；同时审计中心出现一条「安全配置已更新: sandboxEnabled」（config.updated 事件，Task 7 接线）；下方文件/命令/网络三个二级入口为禁用态并带「即将上线」角标（SP2–SP5 占位）。
- **Commit 区域**：50c3acd（14 项默认值 read-time fallback）、177ac19（SecurityService 读写）、9400c3d（开关卡片）。

## 二、数据安全

### 3. 数据安全三配置项 + 备份目录

- **操作步骤**：依次切换「自动备份」「删除保护」开关、把「批量删除审批阈值」改为 20 后失焦；再输入 0（非法）失焦；点「打开备份目录」按钮。
- **预期结果**（spec §9.2）：开关切换即时生效并持久化（重启保持）；阈值合法值保存后按服务端归一化回显、非法值（0/abc）还原旧值并 toast「阈值需为 1–99999 的整数」；点打开目录会创建并打开系统文件管理器中的 `userData/file-history` 目录（首次为空目录）；配额行显示「备份总上限 N MB」。
- **Commit 区域**：57985f3（数据安全卡片）、177ac19（openBackupDir IPC）。

## 三、审计中心（事件源 + 查询）

### 4. 审批决议与危险命令拦截落审计

- **操作步骤**：在绑定工作目录的 AI 会话中——① 让 AI 创建一个文件（如"在工作目录创建 hello.txt"），在审批弹层点「允许」；② 再让 AI 执行一次删除类危险命令（如"帮我执行 rm -rf /Users/<某绝对路径>"形式），点「允许」；③ 让 AI 再写一个文件，这次点「拒绝」；④ 让 AI 以界外 cwd 执行普通命令（如"在 /etc 目录下执行 echo hi"）。
- **预期结果**（spec §6/本任务事件源接入）：设置 → 安全中心 → 审计中心依次出现——
  - 「文件操作已获批准: write_file → …」（file-safety.approved，detail 含工具名与参数摘要）；
  - 「拦截危险命令: rm -rf /Users/…」（command-safety.blocked，命令本体被拦截不执行，模型收到"安全策略拦截"回喂）；
  - 「文件操作被拒绝: write_file → …」（file-safety.rejected——内部 denied 决议对外记 rejected，与 i18n 词汇对齐）；
  - 「工作目录越界已回退: /etc」（command-safety.cwd-fallback，命令仍以工作空间根执行）。
  每条左侧带类别徽标（文件安全/命令安全）与时间戳；aborted（中止）不产生审计记录。
- **Commit 区域**：本任务 commit（command-tool/chat.service/Application 事件源接线）、24e9d6b（AuditLogService 缓冲落库）。

### 5. 查看全部：分页 / 搜索 / 导出 / 清空

- **操作步骤**：审计卡片点「查看全部」进入全量视图；keyword 框输入「write_file」回车观察过滤；清空 keyword 后翻页（上一页/下一页边界禁用）；分别点「导出 CSV」与卡片态「导出 JSON」并在保存框选路径；最后点「清空记录」→ 确认框「取消」再「确认」。
- **预期结果**（spec §9.2/§12）：全量视图每页 100 条、页脚显示「第 x / y 页 · 共 n 条」、30s 自动轮询 + 手动「刷新」；keyword 命中 detail/commandPreview 的记录；导出成功 toast 展示文件路径并自动在文件管理器中定位（JSON 含全字段、CSV 按列展开）；清空需二次确认，确认后列表只剩一条「审计记录已清空」（audit.cleared 留痕为新链头）。
- **Commit 区域**：fc0f518（审计中心两态 UI）、ade3180（导出流式写出）、9e52428（清空串行化消除竞态）。

### 6. 中英文切换（审计与配置文案）

- **操作步骤**：语言切 en-US，重开设置 → 安全中心，浏览沙箱/数据安全/审计三组与全部条目文案，再切回 zh-CN。
- **预期结果**（spec §10）：tab 名（Security Center）、分组标题、开关描述、审计类别徽标与事件文案（如 "File operation approved: …"/"Blocked dangerous command: …"）全量跟随语言切换，无硬编码中文残留；未知 eventType 回落显示原始 eventType 串（向前兼容）。
- **Commit 区域**：5ccc809（security 命名空间双语词条）。

---

## 附录：已知边界与裁定（走查确认，非 bug）

- 危险命令拦截为静态正则（spec §3 五类形态），命令替换混淆（`$(pwd)` 等）由审批层兜底——审批弹层仍会弹出，不静默执行。
- 审计事件经 500ms 缓冲批量落库（满 50 条立即 flush），高频操作下列表刷新有亚秒延迟属预期。
- 沙箱三个二级入口（文件/命令/网络）SP1 仅占位禁用，名单配置 SP2/SP3/SP5 接入；数据安全的备份/回收站执行层 SP4 接入（当前仅持久化配置）。
- `denied` 审批决议在审计侧记为 `rejected`（AuditDecision 词表与 UI i18n key 对齐，语义一致）。
