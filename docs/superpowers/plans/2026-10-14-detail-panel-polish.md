# DetailPanel/browser_use 体验补齐批次（polish）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清偿三计划 deferred minors 中有用户可见价值/回归风险的项：终端探活与主题跟随、文件树与工作空间 tab 体验、拖拽落点语义、测试补齐与注释清理。

**Architecture:** 三独立任务——P1 终端体验（terminal:probe 通道 + xterm 主题刷新）；P2 面板交互（文件树重试/禁用、预览全屏、拖拽落点、W 防连关、无人值守文案）；P3 测试补齐与注释清理（纯测试/注释，零行为变化）。

**Tech Stack:** 既有栈；无新依赖。

**Spec:** 无独立 spec——各项均出自三计划 review 的 deferred minors 与其 ledger 裁定（用户持久授权免确认）；staleTime「新会话不上树」已定性为冒烟脚本伪问题（invalidate 链路完备），不在本批。

## Global Constraints

- 行为改动仅限本计划明列项；i18n 双语；Prettier 仓库口径；每任务 TDD（有行为变化处）；conventional commits
- 用户 6 个未提交 M 文件（chat.service.ts/MessageItem.tsx/truncate-messages-for-edit.ts + 3 测试）绝对不碰
- 主题色仅 CSS 变量；terminal 域契约（PtyProcess/manager）不动

---

### Task 1: 终端体验——探活与主题跟随

**Files:**
- Modify: `electron/domains/ai/terminal/terminal-ipc.ts`（+terminal:probe handler）
- Modify: `electron/domains/ai/terminal/terminal-core.ts`（+has(id) 方法）
- Modify: `electron/commons/ipc-channels.ts`（INVOKE 白名单 + "terminal:probe"）
- Modify: `src-react/domains/ai/terminal/api/terminal.api.ts`（+probe）
- Modify: `src-react/domains/ai/chat/components/detail-panel/TerminalTab.tsx`（挂载探活 + 主题刷新）
- Test: `tests/ai/terminal-core.test.ts`（+has 用例）、`tests/commons/ipc-channels.test.ts`（+probe 断言）

**Interfaces:**
- Produces: `TerminalManager.has(id: string): boolean`；invoke 通道 `terminal:probe`（参数 id，返回 boolean）；`TerminalApi.probe(id): Promise<boolean>`

**行为定义：**
1. **探活**：TerminalTab 挂载（含重挂续连）时若 `tab.terminalId` 存在——先 `TerminalApi.probe(id)`；false（pty 在挂起窗口已退出）→ 直接 `setExited(true)` 显示退出态（「重新打开」可恢复），不发 write/不空转
2. **主题跟随**：TerminalTab 内 `MutationObserver` 监听 `document.documentElement` 的 `data-theme` 属性变化 → 重读 CSS 变量 → `term.options.theme = readTheme()`（xterm 运行时更新 options.theme 官方支持）；卸载 disconnect

- [ ] **Step 1: 测试先行**：terminal-core 追加 `has` 用例（create 后 true/kill 后 false/未知 false）+ 白名单 probe 断言 → RED
- [ ] **Step 2: 实现 core.has + ipc handler + api.probe + TerminalTab 探活/主题**：

TerminalTab 探活 effect（放在「实例/订阅 effect」之前）：

```tsx
  // 续连探活（spec deferred）：pty 在挂起窗口退出时重挂即显示退出态，
  // 不空转发 write；probe false 的 id 同时清负载防复活旧 id
  useEffect(() => {
    if (terminalId === null || exited) return;
    let cancelled = false;
    TerminalApi.probe(terminalId)
      .then((alive) => {
        if (!cancelled && !alive) setExited(true);
      })
      .catch(() => {
        /* 探活失败按原续连语义走，不阻塞 */
      });
    return () => {
      cancelled = true;
    };
  }, [terminalId, exited]);
```

主题刷新（cssColor 抽 `readTheme()` 返回 ITheme 对象；实例 effect 内挂）：

```tsx
    const themeObserver = new MutationObserver(() => {
      term.options.theme = readTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    // cleanup: themeObserver.disconnect()
```

（若明暗切换改的是 `data-mode` 之类的其他属性——实现时以 `src-react/styles/skins.css` 实际开关属性为准，监听该属性；报告注明。）

- [ ] **Step 3: `npx vitest run tests/ai/terminal-core.test.ts tests/commons/ipc-channels.test.ts && npm run typecheck && npm run test`**
- [ ] **Step 4: Commit** `feat(detail-panel): 终端探活与主题跟随——挂起窗口退出即显退出态、data-theme 变更刷新配色`

---

### Task 2: 面板交互——文件树/预览/拖拽/快捷键/文案

**Files:**
- Modify: `src-react/domains/ai/chat/components/detail-panel/WorkspaceFileTree.tsx`
- Modify: `src-react/domains/ai/chat/components/detail-panel/FileTreeNode.tsx`
- Modify: `src-react/domains/ai/chat/store/detail-panel.store.ts`（reorderTab 落点语义）
- Modify: `src-react/domains/ai/chat/components/detail-panel/DetailPanel.tsx`（W e.repeat）
- Modify: `src-react/domains/ai/agent/web-tools.ts`（无人值守文案）
- Modify: `src-react/i18n/locales/{zh-CN,en-US}/chat.json`（新增词条）
- Test: `tests/ai/detail-panel-store.test.ts`（reorder 断言更新 + 双向用例）、`tests/ai/changes-panel-tab.test.tsx`（重试按钮，若结构允许）

**行为定义：**
1. **文件树根失败内联重试**：根（""）拉取失败且无缓存时，树区顶部显示错误行 + 「重试」按钮（toast 保留）；`rootFailed` state（loadDir 对 "" 失败置位）
2. **加载中禁用**：目录按钮 `disabled={loading.has(relPath)}`（视觉 `opacity-50`）
3. **预览全屏**：WorkspaceFileTree 自持 `previewFullscreen` state，FilePreview 的 `fullscreen/onToggleFullscreen` 真接（FilePreview 全屏为 Portal+fixed，已内建）
4. **拖拽落点**：`reorderTab` 修订为「拖到目标上 = 放到目标位置（目标及其后顺移）」：`to > from` 时删除后插入 `to - 1`；测试补 from<to 断言（[a,b,c] 拖 a→c 得 [b,a,c]）
5. **W 防连关**：keydown handler 首行 `if (e.repeat) return;`（T 幂等不受影响，统一挡）
6. **无人值守文案**：open_browser 的 `面板不可用（当前环境未开启会话面板联动）` → `当前环境无交互面板，无法展示页面（自动化/编排流不支持 open_browser）`

- [ ] **Step 1: 测试先行**：store reorder 用例更新（双向断言）→ RED（from<to 断言按旧实现失败）
- [ ] **Step 2: 实现六项**（i18n：`detailPanel.workspace.retryRoot` zh「重试」/en "Retry"；错误行文案复用 `changes.loadFailed` 风格新增 `workspace.rootFailed` zh「目录读取失败」/en "Failed to read directory"）
- [ ] **Step 3: `npx vitest run tests/ai/detail-panel-store.test.ts tests/ai/changes-panel-tab.test.tsx && npm run typecheck && npm run test` + eslint**
- [ ] **Step 4: Commit** `feat(detail-panel): 面板交互补齐——根重试/加载禁用/预览全屏/拖拽落点/W 防连关/无人值守文案`

---

### Task 3: 测试补齐与注释清理（零行为变化）

**Files:**
- Test: `tests/commons/ipc-channels.test.ts`（负向断言）、`tests/ai/detail-panel-store.test.ts`（EMPTY 不可变 + closeTab/syncTab 未知 id no-op）、`tests/ai/terminal-core.test.ts`（kill 后异步 exit 回调不误删新登记）、`tests/ai/changes-panel-tab.test.tsx`（双截断徽标/staged 徽标/返回按钮/untracked 提示）、`tests/ai/browser-tools.test.ts`（空 items「（无）」/无效 URL/快照非字符串/click NOT_FOUND）
- Modify（仅注释）: `src-react/domains/ai/chat/views/ChatView.tsx`（头注释「右列产物面板」→「右列 DetailPanel tab 面板」）、`src-react/domains/ai/chat/components/detail-panel/NewTabMenu.tsx`（四项→五项）、`src-react/domains/ai/browser/components/BrowserWebview.tsx`（deps 措辞）、`src-react/domains/ai/chat/components/artifacts/ArtifactsPanel.tsx`（过时全屏注释）

**要求：**
1. EMPTY 不可变断言：`expect(() => useDetailPanelStore.getStateOf(999).tabs.push(...)).toThrow()`（store 侧 `Object.freeze(EMPTY)` 若未冻结——**本任务允许加 freeze 这一行**，属测试要求的必要实现）
2. 其余各测试照各 ledger deferred 描述补；断言语义贴行为
3. 注释四处仅文字，diff 零逻辑
4. 全量 `npm run test` 全绿 + typecheck

- [ ] **Step 1: 补测试（各文件先跑确认新用例过/必要的 RED）**
- [ ] **Step 2: freeze + 注释**
- [ ] **Step 3: `npm run typecheck && npm run test`**
- [ ] **Step 4: Commit** `test(detail-panel): deferred 断言补齐与注释清理——EMPTY freeze/守卫分支/未测路径`

---

## Self-Review 结论

- 覆盖 ledger deferred 有价值项；纯措辞类 minor（如 ChatView 头注释外的零散文案）并入 Task 3 注释批；2000 上限断言维持原裁定跳过（成本失衡）；reload 丢右栏属 spec 设计（内存态不持久化）不改。✓
- 类型一致性：has/probe/readTheme 在 Task 1 内自洽；reorder 断言与实现同任务。✓
