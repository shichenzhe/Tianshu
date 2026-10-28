# 移动端动效批（MA）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐交互对比结论中优先级 3 的剩余项——把已装未用的 reanimated/gesture-handler 用起来：消息流进入动效、审批到达动效、会话行左滑快捷操作，消灭「零动效」的静态观感。

**Architecture:** 全部收敛 `apps/tianshu-mobile` 单端。reanimated 4.5.1 / gesture-handler 2.32 已在依赖（SDK 57 内置 babel 支持，无需插件）；动效克制原则——短时长（≤200ms）、只挂进入（entering）不挂退出、live 流式行限定。执行顺序由简到难：T2 先验证 reanimated 链路跑通，T1 手势最后。

**Tech Stack:** react-native-reanimated 4.5.1（entering 动画）、react-native-gesture-handler 2.32（ReanimatedSwipeable）。

**Spec:** 本计划自含（源自 2026-10-24 交互对比报告优先级 3；前批 2026-10-24-mobile-presentation-input-modernization 已完成触觉部分）。

## 假设与范围裁定

1. **live→history 定稿重播可接受**：live 行流结束转定稿时 RowItem key 变化会重挂载，entering 重播一次 180ms FadeIn——极轻无碍，不做 key 稳定化（复杂度不值）。
2. **会话行只做左滑**（露出右侧操作钮，iOS Mail 式）；不做右滑。删除钮点击后仍走现有确认流程（破坏性操作必须确认，前批裁定沿用）。
3. **GestureHandlerRootView**：expo-router v3+ 根已内置包裹；若真机 swipe 无响应，退路是在 `_layout.tsx` 显式包一层（幂等）。
4. 动效不写 vitest（纯视觉）；验证闸 = typecheck + prettier + 全量 vitest 回归 + 真机验收清单。

## Global Constraints

- 主干直接提交；命令显式 `cd /Users/hjx/workspace/mirror/apps/tianshu-mobile`（cwd 漂移坑）。
- rtk 会吞 grep/ps 输出：存在性裁定用 node -e 全量复核；路径含 `[id]` 的 glob 坑加引号/绝对路径。
- **任何 npm/expo install 之后必须全量跑一次 vitest**（前批 R8 教训：hoisting 波及 nativewind 本地树致 vi.mock 失配）；本批零新依赖，理论无风险，T1 若需 install 仍执行此检查。
- 双引号+分号+printWidth 80（prettier）；提交信息 `feat(mobile): …（动效批）`。

---

### Task MA-1: live 消息行进入动效（reanimated 跑通验证）

**Files:**
- Modify: `apps/tianshu-mobile/src/components/MessageItem.tsx`
- Modify: `apps/tianshu-mobile/src/app/session/[id].tsx`（live 行标记 animateEnter）

**Interfaces:**
- Produces: `MessageItem` 新可选 prop `animateEnter?: boolean`（true 时外层 entering={FadeIn.duration(180)}）。

- [ ] **Step 1: MessageItem 加动效**

import 区加 `import Animated from "react-native-reanimated";`；`MessageItem` props 加 `animateEnter = false`；组件最外层：assistant 分支的 `<View className="mb-3">` 与 user 分支的 `<View className="mb-3 items-end">` 均换为 `<Animated.View entering={animateEnter ? FadeIn.duration(180) : undefined} className=...>`（`FadeIn` 一并 import）。memo 比较函数（如有）需放行 animateEnter——现状是裸 memo 无自定义比较，props 变化即重渲，无需处理。

- [ ] **Step 2: live 行标记**

`session/[id].tsx` rows 组装处：live 行（非定稿 id 的行）渲染 `<MessageItem ... animateEnter />`；定稿 history 行不传。定位方式：node 搜 `MessageItem` 的 JSX 调用处，live/history 两分支按 `row.id == null`（live 行缺省 id）判别。

- [ ] **Step 3: 三闸验证 + 提交**

```bash
npm run typecheck && npx vitest run && npx prettier --check <改动文件>
git add … && git commit -m "feat(mobile): live 消息行进入淡入动效（动效批）"
```

真机验收：流式回复期间新消息行淡入出现；滚历史无动画。

### Task MA-2: 审批 Banner 与错误行动效

**Files:**
- Modify: `apps/tianshu-mobile/src/components/ApprovalBanner.tsx`（外层 entering SlideInDown）
- Modify: `apps/tianshu-mobile/src/app/session/[id].tsx`（errorText 行 entering FadeIn）

- [ ] **Step 1: ApprovalBanner 外层 Animated.View entering={SlideInDown.duration(200)}**（import Animated + SlideInDown；key 已按 toolCallId 重建，队列推进时新 Banner 自然播进入）。

- [ ] **Step 2: 错误行** errorText 的 `<Text>` 外包 `<Animated.View entering={FadeIn.duration(180)}>`（import FadeIn）。

- [ ] **Step 3: 三闸验证 + 提交**（同 MA-1 Step 3，提交信息 `feat(mobile): 审批 Banner 滑入与流错误行淡入动效（动效批）`）。

真机验收：审批到达从上滑入；发送失败错误行淡入。

### Task MA-3: 会话行左滑快捷操作（置顶/归档/删除）

**Files:**
- Modify: `apps/tianshu-mobile/src/components/SessionRow.tsx`（ReanimatedSwipeable 包裹）
- Modify: `apps/tjanshu-mobile/src/app/index.tsx`（三个 action 接线——复用 SessionActionsSheet 现有 store action）

**Interfaces:**
- SessionRow 新 props：`onTogglePin: () => void; onToggleArchive: () => void; onDelete: () => void;`

- [ ] **Step 1: SessionRow 包 ReanimatedSwipeable**

```tsx
import { ReanimatedSwipeable, RectButton } from "react-native-gesture-handler";
```

左滑露右侧三钮（renderRightActions）：置顶（Pin 图标，色 colors.primary）、归档（Archive，#6b7280）、删除（Trash，#ef4444）；各钮 64 宽、圆角右侧。Swipeable 包住现有 Pressable；`overscrollLeft={false}` 防过度。按钮 onPress 内先 `swipeableRef.current?.close()` 再回调。

- [ ] **Step 2: index.tsx 接线**——SessionActionsSheet 现有置顶/归档/删除逻辑抽为三个 handler 传入（删除沿用其确认流程；置顶/归档直接执行 + tapLight）。node 搜 `setSheetSession` 周边 sheet 段定位现有 action。

- [ ] **Step 3: 根视图兜底**——若 typecheck 报 ReanimatedSwipeable 不存在（版本 API 差异），退回 `import { Swipeable } from "react-native-gesture-handler"`（旧 API 同 props 形状）；真机无响应再包 GestureHandlerRootView（假设 3）。

- [ ] **Step 4: 三闸验证 + 提交**（提交信息 `feat(mobile): 会话行左滑快捷操作——置顶/归档/删除（动效批）`）。

真机验收：左滑会话行露三钮；置顶/归档即时生效；删除仍需确认；点行进入会话不受影响。

---

## Self-Review

- 范围：优先级 3 剩余三项全覆盖；权限分级（优先级 5）与 widget 扩展（优先级 1 后半）明确不在本批。
- 占位符：MA-3 Step 2 的「现有 action」以 node 搜定位为指引（现场查证式，非 TBD）。
- 类型一致：`animateEnter` 定义与消费一致；SessionRow 新 props 在 Steps 1/2 一致。
