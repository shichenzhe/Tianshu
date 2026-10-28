# 移动端「去 AI 味」美化批（GL，参照 iOS 26 + 排行榜前三）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 天枢移动端视觉与交互校准 iOS 26（Liquid Glass 语言：系统化轻 UI + 品牌色克制）——去 LLM 生成感（灰蓝主色/描边卡片堆/胶囊面板/小字密排），参照美区榜前三（Capital One/Muse/Vinted）与 ChatGPT 的 AI native 精简。

**Architecture:** 用户裁定**仅移动端校准**（桌面 globals.css 暂不动——colors.ts 对齐注释解除并标注待桌面跟随）；输入区胶囊堆收进 chips 行（推荐方案采纳）。四主题值映射 Apple 系统色板（机制不动）；中性语义色走 tailwind token（dark: 前缀配对）；组件去描边换实底。

**Spec:** 方案见会话记录（2026-10-25 美化方案）；本计划为 P1-P3 三批。

## 设计令牌（全程引用）

**四主题 → Apple 系统色**（colors.ts，HSL 写法）：
- blue: `hsl(211,100%,50%)`（#007AFF systemBlue）；hover 42% / active 36%；subtle `hsla(211,100%,50%,0.12)`；subtleDark `hsla(211,100%,60%,0.22)`
- red: `hsl(0,100%,59%)`（#FF3B30）同派生
- green: `hsl(145,63%,49%)`（#34C759）同派生
- orange: `hsl(37,100%,50%)`（#FF9500）同派生

**中性语义色**（tailwind.config theme.extend.colors）：
```
grouped #F2F2F7（页面底；暗色显式 dark:bg-black）
card    #FFFFFF（卡面；暗 dark:bg-[#1C1C1E]）
field   #E9E9EB（输入场/次级钮底；暗 dark:bg-[#2C2C2E]）
sep     rgba(60,60,67,0.12)（hairline；暗 dark:border-[#545458A6]）
label2  rgba(60,60,67,0.60)（次级文字；暗 dark:text-[#EBEBF599]）
label3  rgba(60,60,67,0.30)（三级文字；暗 dark:text-[#EBEBF54D]）
```

**排版**：列表标题 17 semibold、正文 15/22、辅文 13、徽标 11。**形状**：卡 rounded-2xl(16)、输入条 24、钮 44pt。**按压**：列表/次要钮按压变 `bg-field`（不再用主题 subtle——按压是状态非品牌）。

## Global Constraints

- 主干直接提交；cd 显式（cwd 漂移）；Edit 后盘上 node 验证再交（多会话冲突史——当前已清场，仍防复发）。
- 双闸阻断纪律：typecheck **失败必须终止链**（`;` 链教训——统一 `&&` 串联）。
- i18n 双语；nativewind reanimated 组件不用 className（既有裁定）；语义固定色（状态红橙等）保留原值。
- vitest 全量回归每批跑（nativewind 替身已由 cf5b4493 钉稳）。

---

### GL-P1: 设计令牌 + 首页 iOS 化

**Files:**
- Modify: `tailwind.config.js`（extend.colors 语义 token）
- Modify: `src/theme/colors.ts`（四主题 Apple 色板 + 注释解除桌面对齐）
- Modify: `src/app/index.tsx`（底色 grouped、连接行/搜索/筛选 pill 去描边换实底、FAB 圆角）
- Modify: `src/components/SessionRow.tsx`（描边卡→白实底 rounded-2xl、标题 17 semibold、时间 13 label2、chevron 灰、左滑钮纯图标 56 宽）
- Modify: `src/components/SkeletonSessionList.tsx`（骨架卡同步实底）
- Modify: `src/components/StateDot.tsx`（如涉及硬色微调则顺手，非必须）

- [ ] Step 1 令牌两文件（tailwind.config + colors.ts）落盘，typecheck 过
- [ ] Step 2 index.tsx 五处：底 `bg-grouped dark:bg-black`；连接切换器去 border 换 `bg-card dark:bg-[#1C1C1E]` rounded-2xl；工作流/设置图标钮 `bg-field dark:bg-[#2C2C2E]` 去描边；搜索框同 field 化；归档筛选 pill field 化
- [ ] Step 3 SessionRow：外层卡 `border border-black/10 dark:border-white/15` → 无 border + `bg-card dark:bg-[#1C1C1E]`（mb-2 保留）；标题 `text-[17px] font-semibold`；时间 `text-[13px] text-label2`（暗色配对）；左滑 ActionButton 去 label 纯图标（width 56）
- [ ] Step 4 骨架卡同步（border→实底）
- [ ] Step 5 双闸 + 全量 vitest + 提交 `feat(mobile): 去AI味 P1——Apple 系统色板+语义令牌+首页 iOS 化（GL 批）`

### GL-P2: 聊天页——输入区重构 + 消息排版

**Files:**
- Modify: `src/components/Composer.tsx`（底行胶囊堆 → 输入条上方轻 chips 行 + 一体大圆角输入条 [＋ 与发送内嵌]；条 `bg-field` 24 圆角）
- Modify: `src/app/session/[id].tsx`（chips 行组装：模型名/权限/模式三枚 13px 无边框灰胶囊——bottomLeft/bottomRight 槽位复用为 chips；附件 pill 样式微调）
- Modify: `src/components/MessageItem.tsx`（user 气泡 `bg-field` 圆角 18；正文 text-[15px] leading-[22]——MarkdownLite 层）
- Modify: `src/components/MarkdownLite.tsx`（正文/标题字号层级上调）
- Modify: `src/components/ToolCallCard.tsx` / `ApprovalBanner.tsx`（白实底卡去描边+hairline；Banner 图标区 systemOrange）
- Modify: `src/components/WidgetCard.tsx` / `MermaidView.tsx` / `CodeBlock.tsx`（卡面实底统一）

- [ ] 输入区重构（保留全部功能面：＋菜单/权限/模式/专家/用量/模型/附件 pill——收纳不改语义）
- [ ] 消息排版与卡片换装
- [ ] 双闸+全量+提交 `feat(mobile): 去AI味 P2——聊天页输入区重构+消息排版 iOS 化（GL 批）`

### GL-P3: 设置/编排/连接页 + 组件细节 + SF Symbols

**Files:**
- Modify: `src/app/settings.tsx` / `orchestration.tsx` / `connections.tsx`（grouped 底+实底分段卡+hairline）
- Modify: `src/components/GraphCard.tsx` / `AutomationCard.tsx` / `ConnectionCard.tsx`（实底卡）
- Modify: `src/components/toast.tsx`（半透明深色毛玻璃感 `rgba(28,28,30,0.78)`+hairline）
- Modify: `src/components/DetailSheet.tsx` / `PlusSheet.tsx`（把手加粗、菜单行图标 field 底方块）
- SF Symbols 渐进：核心三屏导航/操作图标 lucide → `expo-symbols`（chevron/plus/camera/folder/gauge 等常用面；expo-symbols 已在依赖）
- [ ] 双闸+全量+提交；真机验收清单随批输出

---

## Self-Review

- 范围：P1-P3 三批覆盖方案全部要点；P5 真毛玻璃（expo-blur）不纳入（新依赖，后续独立评估）。
- 决策已定：仅移动端（colors.ts 注释同步改写）；chips 行方案。
- 风险：桌面 globals.css 值与移动端将分叉（注释标注待桌面跟随时回同步）；Composer 重构动底行槽位契约（bottomLeft/bottomRight props 保留、仅视觉收纳——session 页接线零改动）。
