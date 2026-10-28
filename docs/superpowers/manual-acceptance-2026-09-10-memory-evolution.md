# 记忆与进化模块 — 手动验收清单（Electron GUI 走查）

> 适用分支：`feature/memory-evolution`（10 个功能 commit：02b121c → ba74721）
> 对照文档：`docs/superpowers/specs/2026-09-09-memory-evolution-design.md`（下称 spec）
> 前置：`npm run dev` 启动应用（开发模式，userData = `~/Library/Application Support/tianshu`）

## 准备工作（可选，用于第 4/9 项造数）

- 开发库位置：`~/Library/Application Support/tianshu/database/local.db`
- 相关 option key（`option` 表）：
  - `personalization.memoryProfile` — 记忆全文（四节 markdown，上限 8000 字）
  - `personalization.memoryEnabled` — 开关（`true` / `false`，默认 true）
  - `personalization.memoryLastCompiledAt` — 上次整理时间（ISO 字符串）
- 造数示例（四节 markdown，含一条超 500 字长条目）：

  ```sql
  UPDATE option SET value = '## 工作背景
  前端工程师，负责 Electron 桌面应用开发
  ' || '很长的条目' || repeat('长', 520) || '
  ## 个人背景
  居住在厦门
  ## 当前关注
  正在做记忆与进化功能验收
  ## 近期动态
  - [2026-09-10] 完成记忆模块开发' WHERE key = 'personalization.memoryProfile';
  ```

  （改完重启应用生效；注意退出应用后再改库，避免覆盖）

---

## 走查清单

### 1. 设置导航入口

- **操作步骤**：打开设置面板（侧边栏「设置」或对应入口），查看左栏导航。
- **预期结果**（spec §6.1 / §8）：左栏出现「记忆与进化」页签（英文 locale 显示 "Memory & Evolution"），**灯泡图标**，位于「个性化」之后、「快捷键」之前（disabled=false 可点击）。
- **Commit 区域**：da25de7（SettingsDialog 导航接入）、4ea8e53（`nav.memory` 双语文案）。

### 2. 记忆开关

- **操作步骤**：进入「记忆与进化」页；确认开关初始状态；再关闭开关。
- **预期结果**（spec §6.1 / §6.2）：
  - 新装/未改配置时开关**默认开**（后端 `defaultPersonalization().memoryEnabled = true`）。
  - 关闭后：底部出现灰色提示条「已关闭对话记忆生成，记忆内容将不再自动更新」（Info 图标）；记忆内容仍展示（**只读**，不消失）。
  - 若在编辑态中关开关：直接退出编辑转只读，**无确认弹窗**（D3 裁决）。
- **Commit 区域**：9bc5349（默认值/option key）、da25de7（开关 + DisabledNotice）。

### 3. 空状态

- **操作步骤**：确保 `personalization.memoryProfile` 为空（新 profile 或已重置），打开「记忆与进化」页。
- **预期结果**（spec §6.2）：管理卡下方出现空状态卡——虚线边框卡片、中央 Brain 图标 + 「开启对话记忆后，AI 将自动为您整理使用偏好与背景信息」；开关关时另有「去开启」按钮，点击后开关被打开。
- **Commit 区域**：da25de7（EmptyMemoryCard）。

### 4. 四节展示与长条目折叠

- **操作步骤**：按准备工作的 SQL 写入四节 markdown（含一条 >500 字条目），重启应用，打开「记忆与进化」页。
- **预期结果**（spec §3.1 / §6.2）：
  - 四节标题（工作背景 / 个人背景 / 当前关注 / 近期动态）按固定顺序切分展示；缺节显示为空。
  - 近期动态条目行首有 `- ` 前缀。
  - **单条 >500 字的条目截断折叠**，尾部出现「展开」按钮（ChevronDown 图标），点击后显示全文；短条目不出现折叠按钮。
  - 内容区超高时右侧滚动（max-h 60vh）。
- **Commit 区域**：02b121c（parseMemoryMarkdown 切分）、da25de7（MemorySectionBlock 展示）、5b627d0（折叠粒度修正为单条 >500 字，spec §6.2）。

### 5. 编辑：保存 / 取消

- **操作步骤**：点「编辑」→ 四板块变为 Textarea；修改任一节文本 → 点「保存」；重开设置面板验证持久。再次进入编辑 → 修改文本 → 点「取消」。
- **预期结果**（spec §6.2）：
  - 编辑态头部按钮变为 重置 / 取消 / 保存，「导入」按钮隐藏。
  - 保存：落库 + Toast「记忆已保存」，退出编辑态；重开面板内容为新值。
  - 取消：丢弃修改恢复原内容（重新进入编辑时文本域为上次保存值）。
- **Commit 区域**：b5614fd（编辑模式 + draftTouched 竞态处理）。

### 6. AI 指令（需已配置模型）

- **操作步骤**：进入编辑态，在底部指令输入框输入「记住我在厦门」，点纸飞机按钮（或回车）。
- **预期结果**（spec §5.4）：
  - 发送按钮 loading（转圈）+ 「应用中」提示；期间取消/保存按钮禁用。
  - 成功：返回的整理结果**只刷新草稿文本域**（如个人背景出现厦门相关条目），**不直接落库**；指令输入框清空；点「保存」才持久化。
  - 未配模型：Toast 提示先配置模型（`error.MEMORY_MODEL_MISSING`）；空指令时发送按钮禁用。
- **Commit 区域**：de810b5（IPC `personalization:applyMemoryInstruction`）、b5614fd（前端指令输入框/草稿刷新）。

### 7. 重置

- **操作步骤**：点头部「重置」按钮（红边框样式）。
- **预期结果**（spec §6.3）：
  - 确认弹窗含**三行警告**：清空不可恢复 / 开关开启则后续仍会生成 / 需彻底停用请关闭功能；按钮为 取消（白底灰边）+ 重置记忆（destructive 实心）。
  - 确认：记忆清空 → 空状态出现 + Toast「记忆已重置」；开关状态与 `memoryLastCompiledAt` **不变**。
  - 编辑态点重置：先退出编辑丢弃草稿再清空。
- **Commit 区域**：ba74721（ResetMemoryDialog）、da25de7（MemoryGroup.confirmReset）。

### 8. 跨 AI 导入

- **操作步骤**：点「导入」打开两步弹窗；点「复制」按钮；将任意四节 markdown（可带 ``` 围栏）粘贴到第二步输入框，点「导入」；再试一次粘贴无任何四节标题的散文本。
- **预期结果**（spec §6.4）：
  - 第一步显示预置提示词（含四分类要求 + 日期格式 [YYYY-MM-DD]）；复制成功按钮短暂变「已复制」（约 2s 后复原）。
  - 粘贴四节文本：**合并追加**到现有记忆（同分类条目追加、近期动态按日期倒序重排），弹窗关闭 + Toast「记忆导入成功」。
  - 粘贴散文本（无四节标题）：Toast「未能识别分类标记，全部内容已存入工作背景」，内容全部进工作背景。
  - 输入框为空时「导入」按钮禁用。
- **Commit 区域**：ba74721（ImportMemoryDialog）、02b121c（mergeMemoryMarkdown / stripCodeFence）、4ea8e53（预置提示词双语文案）。

### 9. 定时整理（开发验证项）

- **操作步骤**：把 DB 中 `personalization.memoryLastCompiledAt` 改为 >24h 前的 ISO 时间（或调整系统时间），确保 `memoryEnabled=true` 且已配模型、库里有近期对话；重启应用，等待约 90 秒，观察主进程日志与记忆内容。
- **预期结果**（spec §5.2 / §5.3）：
  - 启动日志出现「记忆调度器已启动」；90s 补跑窗口到点后执行一轮整理（catchUp）。
  - 整理成功：`memoryProfile` 更新、`memoryLastCompiledAt` 刷新为当前时间。
  - 无对话材料 / 无可用模型：静默跳过，**不更新** LastCompiledAt。
  - 失败：日志 `Log.warn` 静默，等下一轮（30s tick），无 UI 打扰。
  - 正常运行时只在本地时间 02:00–04:00 窗口编译，每天最多一次（同日不重复）。
- **Commit 区域**：be959bd（MemoryScheduler：30s tick + 90s 补跑 + inflight 互斥）、66caf03（compiler 管线）、de810b5（memory-inflight 共享）。

### 10. 对话注入

- **操作步骤**：确保记忆非空且 `personalization.memory`（个性化总开关）开启，新开一个 AI 会话，提问「你知道我的工作背景吗」。
- **预期结果**（spec §3.2）：system prompt 末尾注入【用户画像记忆】段——格式为 `【用户画像记忆】\n以下是系统从对话中提炼的用户画像，请在对话中参考：\n<记忆全文>`；AI 回答能引用记忆中的背景信息。记忆为空时不注入该段。
- **Commit 区域**：9bc5349（personalization.prompt.ts 注入）。

---

## 汇总表

| # | 验证点 | spec | 主要 commit |
|---|---|---|---|
| 1 | 导航「记忆与进化」灯泡图标 | §6.1/§8 | da25de7, 4ea8e53 |
| 2 | 开关默认开 + 关闭提示条只读 | §6.1/§6.2 | 9bc5349, da25de7 |
| 3 | 空状态图标/文案/去开启 | §6.2 | da25de7 |
| 4 | 四节切分 + >500 字折叠 | §3.1/§6.2 | 02b121c, da25de7, 5b627d0 |
| 5 | 编辑保存持久 / 取消恢复 | §6.2 | b5614fd |
| 6 | AI 指令只刷草稿不落库 | §5.4 | de810b5, b5614fd |
| 7 | 重置三行警告 + Toast + 开关不变 | §6.3 | ba74721 |
| 8 | 导入复制反馈 + 合并追加 + 回退 | §6.4 | ba74721, 02b121c, 4ea8e53 |
| 9 | 24h 补跑 90s + 静默失败 | §5.2/§5.3 | be959bd, 66caf03, de810b5 |
| 10 | system prompt 注入【用户画像记忆】 | §3.2 | 9bc5349 |
