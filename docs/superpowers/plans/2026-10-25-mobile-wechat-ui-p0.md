# 天枢移动端微信范式界面改造 P0 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 纯前端落地移动端界面微信化：底部四 Tab 信息架构、会话列表/聊天页微信范式改造、主机/编排/我的视觉统一、基础组件沉淀，现有功能零丢失。

**Architecture:** Expo Router 单层 Stack 改为「根 Stack + `(tabs)` 四 Tab」；沉淀 `Avatar`/`GroupSection`/`ListItem`/`AppActionSheet` 基础组件；可测逻辑（头像取色、时间分隔）抽纯函数走 vitest TDD；组件改造以 typecheck + 全量 vitest 回归 + prettier 为验收环。

**Tech Stack:** Expo Router(file routes)、NativeWind 4、Zustand、vitest(node 环境，无组件渲染器)、TypeScript。

**Spec:** `docs/移动端界面改进方案-微信范式.md`（§9 功能不丢失核对表是验收基准）

## Global Constraints

- **禁止在仓库根目录跑 `npm install`**：nativewind 必须留在 `apps/tianshu-mobile` 本地树，根 install 会毁（恢复脚本 `apps/tianshu-mobile/scripts/restore-local-nativewind.sh`）。只跑 `npm run <script> -w apps/tianshu-mobile`。
- **i18n**：所有用户可见文案走 `t()`；新 key 必须 `zh-CN` 与 `en-US` 同命名空间 JSON 同步添加；禁止顶层 key 与嵌套对象 key 重名。`src/i18n/locales.test.ts` 会做双语 parity 校验。
- **验收三件套**（每任务收尾必跑，lint 环境态全红不可用，见 memory）：
  ```bash
  cd /Users/hjx/workspace/mirror
  npm run typecheck -w apps/tianshu-mobile
  npm run test -w apps/tianshu-mobile
  npx prettier --check apps/tianshu-mobile/src/<本任务触碰的文件>
  ```
- **RN 动画值必须经 Animated 包装组件**（裸组件传动画值 Android 真机红屏）。
- **不改主题色值**（`src/theme/colors.ts` 两端有意分叉注释保持）；**不碰 `packages/*`**（纯 mobile 仓内改动）。
- 命名：文件名 kebab-case、组件 PascalCase、CSS 类 kebab-case。
- 提交：全部直接提交 `main`（用户自管分支，不开新分支），信息风格 `feat(mobile): ...` / `refactor(mobile): ...`。
- 路由迁移后 URL 不变：`expo-router` 的 `(tabs)` 组段不进 URL，`/connections`、`/settings`、`/orchestration`、`/session/[id]` 路径全部保持。

---

### Task 1: 头像取色纯函数 `logic/avatar-color.ts`（TDD）

**Files:**
- Create: `apps/tianshu-mobile/src/logic/avatar-color.ts`
- Test: `apps/tianshu-mobile/src/logic/avatar-color.test.ts`

**Interfaces:**
- Produces（后续 Task 2/7/9 消费）:
  - `AVATAR_THEME_ORDER: readonly ThemeName[]` — `["blue","red","green","orange"]`（顺序固定，存量会话取色稳定）
  - `hashSeed(input: string): number` — djb2，结果非负（`>>> 0`）
  - `avatarThemeIndex(seed: string): number` — `hashSeed(seed) % AVATAR_THEME_ORDER.length`
  - `avatarInitial(title: string | null | undefined): string` — 去空白取首字符大写；空/无字符返回 `"?"`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";

import {
  AVATAR_THEME_ORDER,
  avatarInitial,
  avatarThemeIndex,
  hashSeed,
} from "./avatar-color";

describe("avatar-color（微信范式头像批）", () => {
  it("hashSeed 稳定且非负（djb2）", () => {
    expect(hashSeed("42")).toBe(hashSeed("42"));
    expect(hashSeed("42")).toBeGreaterThanOrEqual(0);
    expect(hashSeed("a")).not.toBe(hashSeed("b"));
  });

  it("avatarThemeIndex 恒落在四主题范围内", () => {
    for (const seed of ["1", "42", "hello", "工作空间甲", ""]) {
      const idx = avatarThemeIndex(seed);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(AVATAR_THEME_ORDER.length);
    }
  });

  it("avatarInitial 取首字符大写，空标题兜底问号", () => {
    expect(avatarInitial("周报助手")).toBe("周");
    expect(avatarInitial("  abc")).toBe("A");
    expect(avatarInitial(null)).toBe("?");
    expect(avatarInitial("   ")).toBe("?");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/hjx/workspace/mirror && npm run test -w apps/tianshu-mobile -- avatar-color`
Expected: FAIL（`Cannot find module './avatar-color'`）

- [ ] **Step 3: 最小实现**

```ts
import type { ThemeName } from "@/theme/colors";

/** 头像取色顺序（固定——存量 seed 的取色结果不随数组重排漂移） */
export const AVATAR_THEME_ORDER: readonly ThemeName[] = [
  "blue",
  "red",
  "green",
  "orange",
];

/** djb2 字符串散列（>>> 0 保非负——取模索引的前提） */
export function hashSeed(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return hash >>> 0;
}

/** seed → 四主题色索引（会话 id/工作空间名等稳定 seed 得稳定配色） */
export function avatarThemeIndex(seed: string): number {
  return hashSeed(seed) % AVATAR_THEME_ORDER.length;
}

/** 标题首字符（头像内显字）；空白/空标题兜底 "?" */
export function avatarInitial(title: string | null | undefined): string {
  const trimmed = (title ?? "").trim();
  if (trimmed === "") return "?";
  return trimmed[0].toUpperCase();
}
```

- [ ] **Step 4: 跑测试确认通过 + 验收三件套**

Run: `npm run test -w apps/tianshu-mobile -- avatar-color` → PASS；再跑 typecheck 与 prettier（见 Global Constraints）。

- [ ] **Step 5: Commit**

```bash
git add apps/tianshu-mobile/src/logic/avatar-color.ts apps/tianshu-mobile/src/logic/avatar-color.test.ts
git commit -m "feat(mobile): 头像取色纯函数——seed 散列取四主题索引+首字兜底（微信范式 P0-T1）"
```

---

### Task 2: 基础组件 `Avatar` / `GroupSection` / `ListItem`

**Files:**
- Create: `apps/tianshu-mobile/src/components/Avatar.tsx`
- Create: `apps/tianshu-mobile/src/components/GroupSection.tsx`
- Create: `apps/tianshu-mobile/src/components/ListItem.tsx`

**Interfaces:**
- Consumes: Task 1 的 `AVATAR_THEME_ORDER` / `avatarThemeIndex` / `avatarInitial`；`THEME_PRESETS`（`@/theme/colors`）
- Produces（Task 3/7/12/13/14 消费）:
  - `<Avatar seed={string} title={string | null} size={number?} />` — 默认 size 44
  - `<GroupSection label={string?}>{children}</GroupSection>` — 灰字小组头 + 圆角组卡；`React.Children.map` + `cloneElement` 给每个子元素注入 `isLast: boolean`
  - `<ListItem icon={ReactNode?} title={string} subtitle={string?} right={ReactNode?} onPress={() => void?} showChevron={boolean?} isLast={boolean?} />` — 默认 showChevron true；`isLast` 由 GroupSection 注入（末行无 hairline）

- [ ] **Step 1: 写 `Avatar.tsx`**

```tsx
import { Text, View } from "react-native";

import {
  AVATAR_THEME_ORDER,
  avatarInitial,
  avatarThemeIndex,
} from "@/logic/avatar-color";
import { THEME_PRESETS } from "@/theme/colors";

/** 微信式圆形头像：seed 散列取四主题色之一作底（会话 id/空间名等稳定
 *  seed 得稳定配色），内显标题首字符；size 默认 44（会话行大头像） */
export function Avatar({
  seed,
  title,
  size = 44,
}: {
  seed: string;
  title: string | null;
  size?: number;
}) {
  const themeName = AVATAR_THEME_ORDER[avatarThemeIndex(seed)];
  const bg = THEME_PRESETS[themeName].primary;
  return (
    <View
      className="items-center justify-center rounded-full"
      style={{ width: size, height: size, backgroundColor: bg }}
    >
      <Text
        className="font-semibold text-white"
        style={{ fontSize: size * 0.42 }}
      >
        {avatarInitial(title)}
      </Text>
    </View>
  );
}
```

- [ ] **Step 2: 写 `ListItem.tsx`**

```tsx
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { ChevronRight } from "lucide-react-native";

/** 微信式通用行：左图标/头像 + 标题(+副标题) + 右槽 + chevron；
 *  hairline 分隔，isLast（GroupSection 注入）末行去线 */
export function ListItem({
  icon,
  title,
  subtitle,
  right,
  onPress,
  showChevron = true,
  isLast = false,
}: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  right?: ReactNode;
  onPress?: () => void;
  showChevron?: boolean;
  isLast?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={onPress == null}
      className={`flex-row items-center gap-3 bg-card px-3 py-3 dark:bg-[#1C1C1E] ${
        isLast ? "" : "border-b border-sep dark:border-[#545458A6]"
      }`}
    >
      {icon}
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="text-[15px] text-black dark:text-white">
          {title}
        </Text>
        {subtitle != null && (
          <Text numberOfLines={1} className="mt-0.5 text-[13px] text-label2 dark:text-[#EBEBF599]">
            {subtitle}
          </Text>
        )}
      </View>
      {right}
      {showChevron && onPress != null && (
        <ChevronRight size={16} color="#C7C7CC" />
      )}
    </Pressable>
  );
}
```

- [ ] **Step 3: 写 `GroupSection.tsx`**

```tsx
import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { Text, View } from "react-native";

/** grouped 分组卡（微信「发现/我」范式）：灰字小组头 + 圆角白卡组；
 *  子元素为 ListItem 时自动注入 isLast（末行去 hairline） */
export function GroupSection({
  label,
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  const items = Children.toArray(children);
  return (
    <View className="gap-1.5">
      {label != null && (
        <Text className="px-1 text-[13px] font-medium text-label2 dark:text-[#EBEBF599]">
          {label}
        </Text>
      )}
      <View className="overflow-hidden rounded-2xl">
        {items.map((child, index) =>
          isValidElement(child)
            ? cloneElement(child as ReactElement<{ isLast?: boolean }>, {
                isLast: index === items.length - 1,
              })
            : child,
        )}
      </View>
    </View>
  );
}
```

- [ ] **Step 4: 验收三件套**

typecheck + 全量 vitest + prettier 检查三个新文件（命令见 Global Constraints）。无组件渲染测试——以类型与全量回归为准。

- [ ] **Step 5: Commit**

```bash
git add apps/tianshu-mobile/src/components/Avatar.tsx apps/tianshu-mobile/src/components/GroupSection.tsx apps/tianshu-mobile/src/components/ListItem.tsx
git commit -m "feat(mobile): 微信范式基础组件 Avatar/GroupSection/ListItem（P0-T2）"
```

---

### Task 3: 通用操作面板 `AppActionSheet` + 两个既有 Sheet 改接

**Files:**
- Create: `apps/tianshu-mobile/src/components/AppActionSheet.tsx`
- Modify: `apps/tianshu-mobile/src/components/SessionActionsSheet.tsx`（整体替换为薄封装）
- Modify: `apps/tianshu-mobile/src/components/MessageActionsSheet.tsx`（同上）

**Interfaces:**
- Produces（Task 10 消费）:
  - `interface ActionSheetItem { key: string; label: string; Icon: ComponentType<{ size?: number; color?: string }>; danger?: boolean; onPress: () => void }`
  - `<AppActionSheet visible={boolean} title={string?} items={ActionSheetItem[]} onClose={() => void} />`
- 两个既有 Sheet 的对外 props **完全不变**（SessionActionsSheet 仍收 `session/onTogglePin/onToggleArchive/onDelete/onClose`；MessageActionsSheet 仍收 `target/onCopy/onEdit/onRegenerate/onClose`），仅内部容器换成 AppActionSheet。

- [ ] **Step 1: 写 `AppActionSheet.tsx`**

把 SessionActionsSheet 第 61–103 行的 Modal 容器骨架（把手条/遮罩/press 关闭/stopPropagation/行渲染）抽为通用组件：

```tsx
import type { ComponentType } from "react";
import { Modal, Pressable, Text, View } from "react-native";

import { useThemeColors } from "@/store/theme";

export interface ActionSheetItem {
  key: string;
  label: string;
  Icon: ComponentType<{ size?: number; color?: string }>;
  danger?: boolean;
  onPress: () => void;
}

/** 删除等破坏性操作的标准红（跨组件同语义色） */
export const ACTION_DANGER = "#FF3B30";

/** 微信式底部操作面板（微信范式批抽取）：圆角组卡 + 把手 + 遮罩点关；
 *  SessionActionsSheet/MessageActionsSheet 及后续 SessionOptionsSheet 共用 */
export function AppActionSheet({
  visible,
  title,
  items,
  onClose,
}: {
  visible: boolean;
  title?: string;
  items: ActionSheetItem[];
  onClose: () => void;
}) {
  const colors = useThemeColors();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable className="flex-1 justify-end bg-black/60" onPress={onClose}>
        <Pressable
          onPress={(e) => e.stopPropagation()}
          className="rounded-t-2xl bg-white px-4 pb-8 pt-3 shadow-lg shadow-black/25 dark:bg-neutral-900"
        >
          <View className="mb-2 h-[5px] w-9 self-center rounded-full bg-black/20 dark:bg-white/25" />
          {title != null && (
            <Text numberOfLines={1} className="mb-1 px-1 text-xs text-label3 dark:text-[#EBEBF54D]">
              {title}
            </Text>
          )}
          {items.map(({ key, label, Icon, danger, onPress }) => (
            <Pressable
              key={key}
              onPress={() => {
                onClose();
                onPress();
              }}
              className="flex-row items-center gap-3 rounded-lg px-3 py-3"
              style={({ pressed }) => ({
                backgroundColor: pressed ? colors.subtle : "transparent",
              })}
            >
              <View
                className="h-8 w-8 items-center justify-center rounded-lg"
                style={{ backgroundColor: colors.subtle }}
              >
                <Icon size={15} color={danger ? ACTION_DANGER : colors.primary} />
              </View>
              <Text
                className={`flex-1 text-sm ${danger ? "" : "text-black dark:text-white"}`}
                style={danger ? { color: ACTION_DANGER } : undefined}
              >
                {label}
              </Text>
            </Pressable>
          ))}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
```

- [ ] **Step 2: `SessionActionsSheet.tsx` 改薄封装**

保留文件头注释与 items 构建逻辑，删除自绘 Modal 容器与 `DANGER` 常量，渲染改为：

```tsx
  if (!session) return null;
  const pinned = session.pinnedAt != null;
  const archived = session.archivedAt != null;
  const items = [
    {
      key: "pin",
      label: pinned ? t("unpin") : t("pin"),
      Icon: pinned ? PinOff : Pin,
      onPress: () => onTogglePin(!pinned),
    },
    {
      key: "archive",
      label: archived ? t("unarchive") : t("archive"),
      Icon: archived ? ArchiveRestore : Archive,
      onPress: () => onToggleArchive(!archived),
    },
    {
      key: "delete",
      label: t("delete"),
      Icon: Trash,
      danger: true,
      onPress: onDelete,
    },
  ];
  return (
    <AppActionSheet
      visible
      title={session.title ?? t("untitled")}
      items={items}
      onClose={onClose}
    />
  );
```

（`Modal/Pressable/View` 等不再用的 import 清掉；`useThemeColors` 删除。）

- [ ] **Step 3: `MessageActionsSheet.tsx` 改薄封装**

items 构建逻辑（user → copy/edit；assistant → copy/regen）原样保留，自绘容器删除，渲染改为：

```tsx
  return (
    <AppActionSheet
      visible={target != null}
      title={target?.text}
      items={items}
      onClose={onClose}
    />
  );
```

- [ ] **Step 4: 验收三件套**

typecheck + 全量 vitest（行为不变，既有测试应全绿）+ prettier 检查三个文件。

- [ ] **Step 5: Commit**

```bash
git add apps/tianshu-mobile/src/components/AppActionSheet.tsx apps/tianshu-mobile/src/components/SessionActionsSheet.tsx apps/tianshu-mobile/src/components/MessageActionsSheet.tsx
git commit -m "refactor(mobile): 抽取 AppActionSheet 通用底部面板，会话/消息操作 Sheet 改薄封装（P0-T3）"
```

---

### Task 4: 底部四 Tab 路由骨架

**Files:**
- Create: `apps/tianshu-mobile/src/app/(tabs)/_layout.tsx`
- Modify: `apps/tianshu-mobile/src/app/_layout.tsx`（收敛为 (tabs)+session+smoke）
- Move: `src/app/index.tsx` → `src/app/(tabs)/index.tsx`（`git mv`）
- Move: `src/app/connections.tsx` → `src/app/(tabs)/connections.tsx`（`git mv`）
- Move: `src/app/orchestration.tsx` → `src/app/(tabs)/orchestration.tsx`（`git mv`）
- Move: `src/app/settings.tsx` → `src/app/(tabs)/settings.tsx`（`git mv`）
- Modify: `apps/tianshu-mobile/src/i18n/locales/zh-CN/common.json`（新增 4 个 Tab key）
- Modify: `apps/tianshu-mobile/src/i18n/locales/en-US/common.json`（同上）

**Interfaces:**
- Produces（Task 5/6 依赖）: 四个 Tab 路由 `index`/`connections`/`orchestration`/`settings` 挂到 `(tabs)` 下，URL 不变；Tab 标题 key：`common:tabChats`/`common:tabHosts`/`common:tabOrchestration`/`common:tabMe`。

- [ ] **Step 1: i18n Tab 标题（双语）**

`zh-CN/common.json` 新增（顶层，注意不与既有嵌套 key 重名）：

```json
  "tabChats": "聊天",
  "tabHosts": "主机",
  "tabOrchestration": "编排",
  "tabMe": "我的"
```

`en-US/common.json` 对应：

```json
  "tabChats": "Chats",
  "tabHosts": "Hosts",
  "tabOrchestration": "Orchestration",
  "tabMe": "Me"
```

- [ ] **Step 2: 四个页面 `git mv` 入 `(tabs)`**

```bash
cd /Users/hjx/workspace/mirror/apps/tianshu-mobile/src/app
mkdir -p "(tabs)"
git mv index.tsx connections.tsx orchestration.tsx settings.tsx "(tabs)/"
```

（页面内容本步不改；它们原样依赖 Stack 提供的头部，下一步由 Tabs 头部接管。）

- [ ] **Step 3: 写 `(tabs)/_layout.tsx`**

```tsx
import { Tabs } from "expo-router";
import { useTranslation } from "react-i18next";

import { useThemeColors } from "@/store/theme";

/**
 * 底部四 Tab（微信范式 P0）：聊天/主机/编排/我的。Tab 图标用 SF Symbols
 * 命名（AppIcon 同款），选中态主题 primary；「我的」无大标题栏（微信
 * 「我」范式），页面自带安全区。
 */
export default function TabsLayout() {
  const { t } = useTranslation("common");
  const colors = useThemeColors();
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: "#8E8E93",
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t("tabChats"),
          headerRight: () => null, // Task 5 接入 ChatsHeaderActions
        }}
      />
      <Tabs.Screen name="connections" options={{ title: t("tabHosts") }} />
      <Tabs.Screen
        name="orchestration"
        options={{ title: t("tabOrchestration") }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: t("tabMe"), headerShown: false }}
      />
    </Tabs>
  );
}
```

- [ ] **Step 4: 根 `_layout.tsx` 收敛**

`Stack` 子项改为（其余启动装配逻辑不动）：

```tsx
        <Stack
          screenOptions={{ headerShown: true, animation: "slide_from_right" }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen
            name="session/[id]"
            options={{ title: t("session.title") }}
          />
          <Stack.Screen name="smoke" options={{ title: t("smoke.title") }} />
        </Stack>
```

删除 `index`/`connections`/`settings`/`orchestration` 四个 Stack.Screen 注册及其不再用的 `t()` key 引用（`connections:title` 等改由 Tabs 消费，根布局的 `useTranslation("common")` 若仅 smoke/session 仍用到则保留）。

- [ ] **Step 5: 验收三件套**

typecheck + 全量 vitest（`locales.test.ts` 校验新 key 双语 parity）+ prettier。

- [ ] **Step 6: Commit**

```bash
git add apps/tianshu-mobile/src/app
git add apps/tianshu-mobile/src/i18n/locales/zh-CN/common.json apps/tianshu-mobile/src/i18n/locales/en-US/common.json
git commit -m "feat(mobile): 底部四 Tab 路由骨架——(tabs) 组迁移四页面，URL 不变（微信范式 P0-T4）"
```

---

### Task 5: 聊天 Tab 顶栏（连接点 + 新建）+ 首页瘦身

**Files:**
- Create: `apps/tianshu-mobile/src/components/chats-header-actions.tsx`
- Modify: `apps/tianshu-mobile/src/app/(tabs)/_layout.tsx`（chats headerRight 接线）
- Modify: `apps/tianshu-mobile/src/app/(tabs)/index.tsx`（删切换器行/设置编排钮/FAB/smoke 页脚）
- Modify: `apps/tianshu-mobile/src/i18n/locales/zh-CN/chat.json`（`newSession`）
- Modify: `apps/tianshu-mobile/src/i18n/locales/en-US/chat.json`（同上）

**Interfaces:**
- Produces: `<ChatsHeaderActions />`——右槽两个图标钮：连接状态点（StateDot，点击 `router.push("/connections")`）+ 新建会话（点击 `create()` 成功后 `router.push(/session/{id})`，失败 `toast.error(t("chat:createFailed"))`）。
- Consumes: `useConnectionsStore`（`activeConnId`/`states`）、`useSessionsStore`（`create`）、`StateDot`、`tapLight`、`toast`、`useRouter`、`AppIcon`、`Plus`。

- [ ] **Step 1: i18n `chat:newSession`**

`zh-CN/chat.json`：`"newSession": "新建会话"`；`en-US/chat.json`：`"newSession": "New Chat"`。

- [ ] **Step 2: 写 `chats-header-actions.tsx`**

```tsx
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import { Plus } from "lucide-react-native";

import { AppIcon } from "@/components/AppIcon";
import { StateDot } from "@/components/StateDot";
import { tapLight } from "@/lib/haptics";
import { toast } from "@/lib/toast-bus";
import { useConnectionsStore } from "@/store/connections.store";
import { useSessionsStore } from "@/store/sessions.store";
import type { TransportState } from "@/transport/types";

/** 聊天 Tab 顶栏右槽（微信范式 P0）：连接状态点（点击进主机 Tab 管理）+
 *  新建会话「+」（原首页 FAB 上移——微信顶栏 + 范式）。 */
export function ChatsHeaderActions() {
  const { t } = useTranslation("chat");
  const router = useRouter();
  const activeConnId = useConnectionsStore((s) => s.activeConnId);
  const states = useConnectionsStore((s) => s.states);
  const create = useSessionsStore((s) => s.create);
  const activeState: TransportState | undefined = activeConnId
    ? (states[activeConnId] ?? "idle")
    : undefined;

  async function handleCreate() {
    tapLight();
    const created = await create();
    if (created) {
      router.push(`/session/${created.id}`);
    } else {
      toast.error(t("createFailed"));
    }
  }

  return (
    <View className="mr-2 flex-row items-center gap-3">
      <Pressable
        onPress={() => router.push("/connections")}
        hitSlop={8}
        accessibilityLabel={t("noConnection")}
      >
        <StateDot state={activeState} />
      </Pressable>
      <Pressable
        onPress={() => void handleCreate()}
        hitSlop={8}
        accessibilityLabel={t("newSession")}
      >
        <AppIcon name="plus" fallback={Plus} size={20} color="#007AFF" weight="semibold" />
      </Pressable>
    </View>
  );
}
```

（图标色注意：iOS 导航栏图标惯例用系统蓝或随主题——本稿先用 `#007AFF` 与 `AppIcon` 兜底；实现时若导航栏渲染主题色需改 `useThemeColors().primary`，以真机效果为准，不留双标。）

- [ ] **Step 3: `(tabs)/_layout.tsx` 接线**

`import { ChatsHeaderActions } from "@/components/chats-header-actions";`，chats 的 `headerRight: () => <ChatsHeaderActions />`。

- [ ] **Step 4: `(tabs)/index.tsx` 瘦身**

删除（功能全部由 Tab/顶栏承担，不丢失）：
1. 连接切换器整行（`{/* 连接切换器…*/}` 起至该行 `</View>`，含 StateDot/Workflow/Settings 三个 Pressable）；
2. 文件底部「新建 FAB」`Pressable`（含 `handleCreate`/`creating` state）；
3. `ListFooterComponent` 里的 smoke 入口 Pressable（改 Task 13 深埋「我的→关于」）；
4. 随之不再用的 import：`Settings`/`Workflow`/`Plus`/`StateDot`/`AppIcon`（若 GroupChevron 仍用则保留 AppIcon）/`tapLight`（若组头仍用则保留）/`relativeTimeLabel`（Task 7 改行后可能由 SessionRow 自管——本步先保留）。

保留：搜索框、归档筛选 chip、分组折叠列表、下拉刷新/分页/骨架屏/空态（无连接 CTA 仍 `router.push("/connections")`，路径不变）。

- [ ] **Step 5: 验收三件套 + Commit**

```bash
git add apps/tianshu-mobile/src/components/chats-header-actions.tsx apps/tianshu-mobile/src/app/\(tabs\) apps/tianshu-mobile/src/i18n/locales/zh-CN/chat.json apps/tianshu-mobile/src/i18n/locales/en-US/chat.json
git commit -m "feat(mobile): 聊天 Tab 顶栏右槽（连接点+新建），首页瘦身去 FAB/切换器/smoke 入口（P0-T5）"
```

---

### Task 6: 会话列表行微信化（SessionRow 改造）

**Files:**
- Modify: `apps/tianshu-mobile/src/components/SessionRow.tsx`（行结构重写）
- Modify: `apps/tianshu-mobile/src/app/(tabs)/index.tsx`（传 `summary` + 组头样式微调）

**Interfaces:**
- Consumes: Task 2 的 `Avatar`。
- Produces: `SessionRow` 新增可选 prop `summary?: string | null`（P0 降级摘要：搜索态传 workspace 组名；组态不传时第二行回退相对时间——信息不丢）。

- [ ] **Step 1: `SessionRow.tsx` 行结构重写**

外观目标（微信会话行范式）：

```
┌──────────────────────────────────────┐
│ ┌────┐ 标题(17 semibold)      相对时间 │
│ │Avatar│ 摘要/时间(13 label2)          │
│ └────┘                               │
└──────────────────────────────────────┘
```

保留不动：`ReanimatedSwipeable` 整段（含 `ActionButton`/`closeAnd`/friction/animationOptions）、`onPress`/`onLongPress`、hairline 外层 wrapper 结构。Pressable 内部改为：

```tsx
        <Pressable
          onPress={onPress}
          onLongPress={onLongPress}
          className="flex-row items-center gap-3 bg-card px-4 py-3 dark:bg-[#1C1C1E]"
          style={({ pressed }) => ({
            backgroundColor: pressed
              ? colors.subtle
              : session.pinnedAt != null
                ? "#F2F2F7" // 微信式置顶灰底（暗色下用 field 深灰）
                : undefined,
          })}
        >
          <Avatar seed={String(session.workspaceId ?? session.id)} title={session.title} />
          <View className="min-w-0 flex-1">
            <View className="flex-row items-center gap-2">
              <Text
                numberOfLines={1}
                className="flex-1 text-[17px] font-semibold text-black dark:text-white"
              >
                {session.title ?? t("untitled")}
              </Text>
              <Text className="text-xs text-label3 dark:text-[#EBEBF54D]">
                {relativeTimeLabel(formatRelative(session.updatedAt), t)}
              </Text>
            </View>
            <View className="mt-0.5 flex-row items-center gap-2">
              {session.pinnedAt != null && (
                <Pin size={12} color={colors.primary} />
              )}
              {session.archivedAt != null && (
                <View
                  className="rounded px-1.5 py-0.5"
                  style={{ backgroundColor: colors.subtle }}
                >
                  <Text className="text-xs" style={{ color: colors.primaryActive }}>
                    {t("archived")}
                  </Text>
                </View>
              )}
              <Text
                numberOfLines={1}
                className="flex-1 text-[13px] text-label2 dark:text-[#EBEBF599]"
              >
                {summary ?? relativeTimeLabel(formatRelative(session.updatedAt), t)}
              </Text>
            </View>
          </View>
        </Pressable>
```

删除旧布局中的 `AppIcon chevron.right`（微信行无 chevron）及其 import。置顶暗色底：pressed 优先级最高，非 pressed 时暗色用 `"#2C2C2E"`——把底色判断写成助手：

```tsx
const pinnedBg = (pressed: boolean) => {
  if (pressed) return colors.subtle;
  if (session.pinnedAt == null) return undefined;
  return colorScheme === "dark" ? "#2C2C2E" : "#F2F2F7";
};
```

（`colorScheme` 经 `useColorScheme()`（nativewind）获取；顶部加 import。）

- [ ] **Step 2: `(tabs)/index.tsx` 传 summary**

`renderRowContent(session)` 无组上下文，改造为 `renderRowContent(session, summary?)`：搜索态调用处传 `item.title`（workspace 组名）；组态展开列表不传（回退时间）。搜索态 `item.data.map((session) => renderRowContent(session))` 改为 `renderRowContent(session, item.title)`。

组头样式微调（微信式灰字小组头）：组头 `Pressable` 的标题 Text 样式 `text-[13px] font-semibold` 改 `text-[13px] font-normal`（灰字不加粗），其余不动。

- [ ] **Step 3: 验收三件套 + Commit**

```bash
git add apps/tianshu-mobile/src/components/SessionRow.tsx "apps/tianshu-mobile/src/app/(tabs)/index.tsx"
git commit -m "feat(mobile): 会话行微信化——首字头像+标题/时间双行+置顶灰底，搜索态摘要降级 workspace 名（P0-T6）"
```

---

### Task 7: 消息时间分隔纯函数 + `ChatMessage.createdAt` 透传（TDD）

**Files:**
- Create: `apps/tianshu-mobile/src/logic/time-separators.ts`
- Test: `apps/tianshu-mobile/src/logic/time-separators.test.ts`
- Modify: `apps/tianshu-mobile/src/store/stream.store.ts`（`ChatMessage` 增 `createdAt`；`toChatMessages` 透传）

**Interfaces:**
- Produces（Task 8 消费）:
  - `TIME_GAP_MS: number` — `5 * 60 * 1000`
  - `timeSeparatorKeys(items: Array<{ key: string; createdAt?: string }>): Set<string>` — 按**时间正序**输入，返回需显示时间分隔的 key 集合；首条有效消息必标；与上一条间隔 >5min 标；`createdAt` 缺失/非法则跳过该条且**重置锚点**（其后首条有效消息必标）。
- 服务端事实（已核实，两被控端同口径）：`apps/tianshu-server/src/modules/session/dto/session-detail.dto.ts` 与 `electron/domains/server-face/routes.ts` 的 getById `messages[]` 均带 `createdAt`（ISO 字符串）——纯透传，无协议改动。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";

import { TIME_GAP_MS, timeSeparatorKeys } from "./time-separators";

const iso = (min: number) => new Date(min * 60_000).toISOString();

describe("time-separators（微信范式时间分隔批）", () => {
  it("首条必标，间隔未超 5 分钟不标", () => {
    const marks = timeSeparatorKeys([
      { key: "a", createdAt: iso(0) },
      { key: "b", createdAt: iso(3) },
    ]);
    expect(marks.has("a")).toBe(true);
    expect(marks.has("b")).toBe(false);
  });

  it("间隔超 5 分钟标记", () => {
    const marks = timeSeparatorKeys([
      { key: "a", createdAt: iso(0) },
      { key: "b", createdAt: iso(6) },
    ]);
    expect(marks.has("b")).toBe(true);
  });

  it("非法 createdAt 跳过并重置锚点", () => {
    const marks = timeSeparatorKeys([
      { key: "a", createdAt: iso(0) },
      { key: "live", createdAt: undefined },
      { key: "b", createdAt: iso(1) },
    ]);
    expect(marks.has("b")).toBe(true); // live 重置锚点，b 成为新首条
    expect(TIME_GAP_MS).toBe(5 * 60 * 1000);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -w apps/tianshu-mobile -- time-separators` → FAIL（模块不存在）。

- [ ] **Step 3: 最小实现**

```ts
/** 相邻消息时间分隔阈值（微信范式：间隔超 5 分钟插时间戳） */
export const TIME_GAP_MS = 5 * 60 * 1000;

/** 按时间正序的消息 key 集合计算时间分隔标记：首条有效消息必标；
 *  createdAt 缺失/非法（live 流式行）跳过并重置锚点——其后首条有效消息必标 */
export function timeSeparatorKeys(
  items: Array<{ key: string; createdAt?: string }>,
): Set<string> {
  const marks = new Set<string>();
  let prev: number | null = null;
  for (const item of items) {
    const t = Date.parse(item.createdAt ?? "");
    if (Number.isNaN(t)) {
      prev = null;
      continue;
    }
    if (prev === null || t - prev > TIME_GAP_MS) marks.add(item.key);
    prev = t;
  }
  return marks;
}
```

- [ ] **Step 4: `stream.store.ts` 透传 createdAt**

`ChatMessage` 接口加字段：

```ts
export interface ChatMessage {
  id: number;
  role: "user" | "assistant" | "system";
  blocks: MessageBlock[];
  /** getById 消息行创建时间（ISO——微信范式时间分隔；旧被控端缺省 undefined） */
  createdAt?: string;
}
```

`WireMessage` 类型加 `createdAt?: unknown`；`toChatMessages` 的 push 改：

```ts
    out.push({
      id: m.id,
      role: m.role,
      blocks: parseBlocks(m.blocks),
      ...(typeof m.createdAt === "string" ? { createdAt: m.createdAt } : {}),
    });
```

- [ ] **Step 5: 验收三件套 + Commit**

全量 vitest（stream.store 既有测试应不感知新可选字段）+ typecheck + prettier。

```bash
git add apps/tianshu-mobile/src/logic/time-separators.ts apps/tianshu-mobile/src/logic/time-separators.test.ts apps/tianshu-mobile/src/store/stream.store.ts
git commit -m "feat(mobile): 消息时间分隔纯函数 + getById createdAt 透传（微信范式 P0-T7）"
```

---

### Task 8: 消息流微信化（气泡 + 助手头像 + 时间分隔渲染）

**Files:**
- Modify: `apps/tianshu-mobile/src/components/MessageItem.tsx`
- Modify: `apps/tianshu-mobile/src/app/session/[id].tsx`（分隔标记注入 + 时间戳渲染）
- Modify: `apps/tianshu-mobile/src/i18n/locales/zh-CN/chat.json`（无新 key——时间文案复用 `lib/relative-time-label`；如缺「刚刚」类兜底以现有 key 为准）

**Interfaces:**
- Consumes: Task 7 的 `timeSeparatorKeys`；Task 2 的 `Avatar`（仅会话行用——助手头像此处用主题色 Logo 风格独立实现，见 Step 1）；`ChatMessage.createdAt`。
- Produces: `MessageItem` 新增可选 prop `showTimestamp?: boolean`（默认 false，不改变既有调用方）；时间戳文案经 `formatRelative`（`@/logic/time`）+ `relativeTimeLabel`（`@/lib/relative-time-label`）。

- [ ] **Step 1: `MessageItem.tsx` 气泡与头像**

用户气泡（原 `bg-field` 灰底）改主题 subtle（浅色 primary 12% tint / 暗色亮相 22% tint——`useThemeColors().subtle` 已按明暗取套）：

```tsx
          <View
            className="max-w-[85%] rounded-[18px] px-3.5 py-2"
            style={{ backgroundColor: userColors.subtle }}
          >
```

（`userColors = useThemeColors()`；`MarkdownLite` 内文字保持 `text-black dark:text-white`，在 12% tint 底上两态对比均达标。引用卡片/图片块维持原序不动。）

助手消息从全宽改为「头像 + 白底气泡」行：

```tsx
  return (
    <Animated.View entering={entering} style={{ marginBottom: 12 }}>
      <View className="flex-row items-start gap-2.5">
        <View
          className="mt-0.5 h-8 w-8 items-center justify-center rounded-full"
          style={{ backgroundColor: assistantColors.primary }}
        >
          <AppIcon name="sparkles" fallback={Sparkles} size={15} color="#fff" />
        </View>
        <View
          className="flex-1 rounded-[18px] bg-card px-3.5 py-2 dark:bg-[#1C1C1E]"
          style={{ backgroundColor: /* 浅色 */ "#FFFFFF" }}
        >
          {blocks.map((block, i) => (
            <BlockView key={i} block={block} />
          ))}
        </View>
      </View>
    </Animated.View>
  );
```

要点：
- 头像 = 主题 primary 圆形 + `AppIcon sparkles`（App Logo 风格，与 spec §4.2 一致）；`Sparkles` 从 `lucide-react-native` import，作 Android 兜底。
- 气泡 `flex-1` 占满剩余宽——`WidgetCard`/`MermaidView`/`ToolCallCard` 等全宽富内容块不压缩。
- 助手气泡浅色底用纯白（页面底已是 `bg-white`，气泡靠圆角+内边距分界）；暗色维持 `#1C1C1E`。
- 新增 import：`AppIcon`、`Sparkles`、`useThemeColors`（用户气泡已 import 则复用）。

- [ ] **Step 2: `session/[id].tsx` 分隔标记 + 时间戳渲染**

`RowItem` 增字段 `createdAt?: string`；`rows` memo 的 history 映射带 `createdAt: m.createdAt`。在 `rows` 之后算标记（正序→rows 是倒置的，先对正序算再随数组反转对应 key）：

```tsx
  const separatorKeys = useMemo(() => {
    const chronological = [...rows].reverse(); // rows 倒置，翻回正序
    return timeSeparatorKeys(
      chronological.map((r) => ({ key: r.key, createdAt: r.createdAt })),
    );
  }, [rows]);
```

`renderItem` 里 MessageItem 包一层列布局：

```tsx
      <View>
        {separatorKeys.has(item.key) && item.createdAt != null && (
          <Text className="mb-2 mt-1 text-center text-xs text-label3 dark:text-[#EBEBF54D]">
            {relativeTimeLabel(formatRelative(item.createdAt), t)}
          </Text>
        )}
        <Pressable onLongPress={...} delayLongPress={350}>
          <MessageItem ... />
        </Pressable>
      </View>
```

（新 import：`timeSeparatorKeys`、`formatRelative`、`relativeTimeLabel`。live 行无 createdAt 天然不标。）

- [ ] **Step 3: 验收三件套 + Commit**

```bash
git add apps/tianshu-mobile/src/components/MessageItem.tsx "apps/tianshu-mobile/src/app/session/[id].tsx"
git commit -m "feat(mobile): 消息流微信化——用户主题色气泡、助手头像+白底气泡、超 5 分钟时间分隔（P0-T8）"
```

---

### Task 9: 聊天页 ⋯ 面板收纳 chips（SessionOptionsSheet）

**Files:**
- Create: `apps/tianshu-mobile/src/components/SessionOptionsSheet.tsx`
- Modify: `apps/tianshu-mobile/src/app/session/[id].tsx`（headerRight 改 ⋯、chips 移入面板、Composer 槽位置空）
- Modify: `apps/tianshu-mobile/src/components/Composer.tsx`（chips 行条件渲染）
- Modify: `apps/tianshu-mobile/src/i18n/locales/zh-CN/chat.json` + `en-US/chat.json`（`moreOptions` 及行标签 key：`optModel`/`optMode`/`optPermission`/`optExpert`/`optUsage`/`optFiles`）

**Interfaces:**
- Consumes: Task 3 的 `AppActionSheet`（本任务不用——改为自绘行面板，因行右槽需嵌既有 chip 组件）；既有 `PermissionChip`/`ModeChip`/`ExpertChip`/`UsageChip`/`ModelPicker`（**原样嵌入，零改动**——ModeChip/PermissionChip 是即时切换钮、ModelPicker/ExpertChip/UsageChip 自带弹层，直接放行右槽）。
- Produces: `<SessionOptionsSheet visible sessionId sessionMode usageRefresh modelId onPickModel onOpenFiles filesAvailable onClose />`。

**设计说明（为何不用 AppActionSheet）**：模式/权限是即时切换（无弹层），模型/专家/用量点开各 chip 自带弹层——统一自绘「标签 + chip 右槽」行面板，五个 chip 零改动全量复用，行为（乐观切换/失败回滚/能力门禁）原封不动。

- [ ] **Step 1: i18n key（双语）**

`zh-CN/chat.json`：`"moreOptions": "会话选项"`，`"optModel": "模型"`，`"optMode": "模式"`，`"optPermission": "工具权限"`，`"optExpert": "专家"`，`"optUsage": "上下文用量"`，`"optFiles": "产物文件"`。
`en-US/chat.json`：`"moreOptions": "Chat Options"`，`"optModel": "Model"`，`"optMode": "Mode"`，`"optPermission": "Tool Permission"`，`"optExpert": "Expert"`，`"optUsage": "Context Usage"`，`"optFiles": "Artifacts"``。

- [ ] **Step 2: 写 `SessionOptionsSheet.tsx`**

```tsx
import { useTranslation } from "react-i18next";
import { Modal, Pressable, Text, View } from "react-native";
import { FolderOutput } from "lucide-react-native";

import { ExpertChip } from "@/components/ExpertChip";
import { ModeChip } from "@/components/ModeChip";
import { ModelPicker } from "@/components/ModelPicker";
import { PermissionChip } from "@/components/PermissionChip";
import { UsageChip } from "@/components/UsageChip";
import { useThemeColors } from "@/store/theme";

type SessionMode = "agent" | "ask" | "plan";

/** 会话 ⋯ 面板（微信范式 P0）：收纳原输入区上方 chips 行——五个 chip
 *  原样嵌入行右槽（模式/权限即时切换、模型/专家/用量自带弹层，行为零
 *  改动）；产物文件行有产物时才出现。 */
export function SessionOptionsSheet({
  visible,
  sessionId,
  sessionMode,
  usageRefresh,
  modelId,
  onPickModel,
  filesAvailable,
  onOpenFiles,
  onClose,
}: {
  visible: boolean;
  sessionId: number;
  sessionMode: SessionMode;
  usageRefresh: number;
  modelId: number | null;
  onPickModel: (id: number) => void;
  filesAvailable: boolean;
  onOpenFiles: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("chat");
  const colors = useThemeColors();
  const rows = [
    { key: "mode", label: t("optMode"), node: <ModeChip sessionId={sessionId} initialMode={sessionMode} /> },
    { key: "perm", label: t("optPermission"), node: <PermissionChip sessionId={sessionId} /> },
    { key: "expert", label: t("optExpert"), node: <ExpertChip onPick={() => {}} onPromptsChange={() => {}} /> },
    { key: "usage", label: t("optUsage"), node: <UsageChip sessionId={sessionId} refreshKey={usageRefresh} /> },
    { key: "model", label: t("optModel"), node: <ModelPicker modelId={modelId} onPick={onPickModel} /> },
  ];
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable className="flex-1 justify-end bg-black/60" onPress={onClose}>
        <Pressable
          onPress={(e) => e.stopPropagation()}
          className="rounded-t-2xl bg-white px-4 pb-8 pt-3 shadow-lg shadow-black/25 dark:bg-neutral-900"
        >
          <View className="mb-2 h-[5px] w-9 self-center rounded-full bg-black/20 dark:bg-white/25" />
          <Text className="mb-1 px-1 text-xs text-label3 dark:text-[#EBEBF54D]">
            {t("moreOptions")}
          </Text>
          {rows.map(({ key, label, node }) => (
            <View key={key} className="flex-row items-center justify-between px-3 py-2.5">
              <Text className="text-sm text-black dark:text-white">{label}</Text>
              {node}
            </View>
          ))}
          {filesAvailable && (
            <Pressable
              onPress={() => {
                onClose();
                onOpenFiles();
              }}
              className="flex-row items-center justify-between px-3 py-2.5"
              style={({ pressed }) => ({
                backgroundColor: pressed ? colors.subtle : "transparent",
              })}
            >
              <Text className="text-sm text-black dark:text-white">{t("optFiles")}</Text>
              <FolderOutput size={17} color={colors.primary} />
            </Pressable>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
```

注意：`ExpertChip` 的实际 props 以源码为准（session 页现用法是 `selectedId={expertId} onPick={setExpertId} onPromptsChange={setExpertPrompts}`）——面板需要与页面共享 expertId/expertPrompts 态：本面板直接收 props 透传（`expertId/onPickExpert/onPromptsChange` 三个 prop 加进面板签名，由 session 页传入），实现时以 ExpertChip 现有签名为准，不得丢 `onPromptsChange`（专家快捷提示数据源）。

- [ ] **Step 3: `session/[id].tsx` 接线**

1. `Stack.Screen` 的 `headerRight`：folder 图标（`sessionFiles.length > 0` 时才渲染）改为常驻 ⋯（`Ellipsis` icon，lucide）→ `setOptionsOpen(true)`。header import 增 `Ellipsis`。
2. 新增 state `const [optionsOpen, setOptionsOpen] = useState(false);`，文件底部挂 `<SessionOptionsSheet … />`（props 全部从页面既有状态取：`sessionMode={entry?.sessionMode ?? "agent"}`、`usageRefresh`、`modelId`、`onPickModel={handlePickModel}`、`filesAvailable={sessionFiles.length > 0}`、`onOpenFiles={() => setFilesSheetOpen(true)}`；expert 三件套透传）。
3. Composer 的 `bottomLeft`/`bottomRight` 两个 prop 不再传（删除这两个 prop 传入）；`expertPrompts`/`expertId`/`setExpertId`/`setExpertPrompts`/`handlePickModel`/`usageRefresh` 等 state 保留（面板在用）。

- [ ] **Step 4: `Composer.tsx` chips 行条件渲染**

chips 行（`{/* chips 行… */}` 起那个 `View`）改为仅在有内容时渲染：

```tsx
      {(bottomLeft != null || bottomRight != null) && (
        <View className="flex-row flex-wrap items-center gap-1.5 px-3 pb-1.5 pt-2">
          {bottomLeft}
          {bottomRight}
        </View>
      )}
```

（props 类型保留——槽位契约不破，其他潜在调用方不受影响。）

- [ ] **Step 5: 验收三件套 + Commit**

```bash
git add apps/tianshu-mobile/src/components/SessionOptionsSheet.tsx apps/tianshu-mobile/src/components/Composer.tsx "apps/tianshu-mobile/src/app/session/[id].tsx" apps/tianshu-mobile/src/i18n/locales/zh-CN/chat.json apps/tianshu-mobile/src/i18n/locales/en-US/chat.json
git commit -m "feat(mobile): 会话 ⋯ 面板收纳 chips 行（模型/模式/权限/专家/用量/产物），输入区回归干净底栏（P0-T9）"
```

---

### Task 10: `PlusSheet` 九宫格

**Files:**
- Modify: `apps/tianshu-mobile/src/components/PlusSheet.tsx`（行列表 → 3 列宫格）

**Interfaces:**
- 对外 props **完全不变**（`visible/filesCap/onPickFileRef/onTakePhoto/onPickLocalFile/onPickSkillRef/onClose`）；`PlusButton` 不动。item 数组与 `setTimeout(onPress, 350)`（iOS document-picker present 冲突规避）逻辑原样保留，仅改渲染。

- [ ] **Step 1: 宫格渲染**

items map 的外层容器由纵向行改宫格（微信 + 面板范式）：

```tsx
          <View className="flex-row flex-wrap px-1">
            {items.map(({ key, label, Icon, onPress }) => (
              <Pressable
                key={key}
                onPress={() => {
                  onClose();
                  // iOS：系统 document-picker 需 present 到根控制器（原注释保留）
                  setTimeout(onPress, 350);
                }}
                className="w-1/3 items-center gap-1.5 py-3"
                style={({ pressed }) => ({
                  opacity: pressed ? 0.6 : 1,
                })}
              >
                <View
                  className="h-14 w-14 items-center justify-center rounded-2xl"
                  style={{ backgroundColor: colors.subtle }}
                >
                  <Icon size={22} color={colors.primary} />
                </View>
                <Text className="text-xs text-black dark:text-white">
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>
```

（4 项时第二行只有 1 个单元左对齐——微信同款不规则末行，不做占位补齐。面板底部 padding 由 `pb-8` 保持。）

- [ ] **Step 2: 验收三件套 + Commit**

```bash
git add apps/tianshu-mobile/src/components/PlusSheet.tsx
git commit -m "feat(mobile): PlusSheet 九宫格面板（微信 + 面板范式，交互与 350ms 规避原样）（P0-T10）"
```

---

### Task 11: 「我的」页重组（连接卡片 + grouped 列表 + smoke 深埋）

**Files:**
- Modify: `apps/tianshu-mobile/src/app/(tabs)/settings.tsx`
- Modify: `apps/tianshu-mobile/src/i18n/locales/zh-CN/settings.json`（`currentHost`）
- Modify: `apps/tianshu-mobile/src/i18n/locales/en-US/settings.json`（同上）

**Interfaces:**
- Consumes: Task 2 的 `GroupSection`/`ListItem`；`useConnectionsStore`（连接卡片）；`StateDot`；既有 `OptionRow`/`ThemeCard`/`ToggleRow`/`SkillsSection`/`McpSection`（视觉内层不动）。
- Produces: 「我的」页 = 顶部当前连接卡片（点击 → `/connections`）+ 外观/通知/技能/MCP/关于 五个 GroupSection；smoke 入口在「关于」组末行。

- [ ] **Step 1: i18n `settings:currentHost`**

zh：`"currentHost": "当前主机"`；en：`"currentHost": "Current Host"`。

- [ ] **Step 2: 页面重组**

结构（SafeAreaView 改 `edges={["top", "bottom"]}`——「我的」无导航头，需自补顶部安全区）：

```tsx
      <ScrollView
        className="flex-1 bg-grouped dark:bg-black"
        contentContainerStyle={{ padding: 16, gap: 16 }}
      >
        {/* 当前连接卡片（微信「我」头像卡范式）：状态点+名称，点击进主机 Tab */}
        <Pressable
          onPress={() => router.push("/connections")}
          className="flex-row items-center gap-3 rounded-2xl bg-card px-4 py-4 dark:bg-[#1C1C1E]"
          style={({ pressed }) => ({
            backgroundColor: pressed ? colors.subtle : undefined,
          })}
        >
          <StateDot state={activeState} />
          <View className="min-w-0 flex-1">
            <Text className="text-[13px] text-label3 dark:text-[#EBEBF54D]">
              {t("currentHost")}
            </Text>
            <Text
              numberOfLines={1}
              className="text-[17px] font-semibold text-black dark:text-white"
            >
              {activeConfig?.name ?? t("noConnectionFallback")}
            </Text>
          </View>
        </Pressable>

        <GroupSection label={t("language")}>
          {LANGUAGES.map(({ locale, labelKey }) => (
            <ListItem
              key={locale}
              title={t(labelKey)}
              showChevron={false}
              right={currentLocale === locale ? <Check size={16} color={colors.primary} /> : undefined}
              onPress={() => setLocale(locale)}
            />
          ))}
        </GroupSection>
        {/* 其余节同法：GroupSection 包既有行组件（外观=明暗+主题卡、
            通知=ToggleRow 三行、关于=版本卡+smoke ListItem） */}
      </ScrollView>
```

落地要点：
- 语言/明暗两节的多选行由 `OptionRow` 换 `ListItem`（选中态 = 右 Check，去掉描边卡样式）；主题色卡节（`ThemeCard` 网格）视觉独特，**保留原样**只外包 `GroupSection`。
- 通知节 `ToggleRow` 三行 + 背景提示文字保留，包 `GroupSection label={t("notifications")}`。
- `SkillsSection`/`McpSection` 内建自己的节头与卡样式——本任务只在其外包 `GroupSection`？**不包**（避免双层节头）：保持原样平铺，仅页面级重组。
- 「关于」组末加 smoke 深埋行：

```tsx
          <ListItem
            title={tCommon("nav.toSmoke")}
            showChevron
            onPress={() => router.push("/smoke")}
          />
```

（`useTranslation` 增 `"common"` 命名空间。无连接兜底 key：复用 `common:noConnection`？该 key 在 chat ns——实现时从 `chat:noConnection` 取或新增 `settings:noConnection`，以现有 key 复用优先。）

- [ ] **Step 3: 验收三件套 + Commit**

```bash
git add "apps/tianshu-mobile/src/app/(tabs)/settings.tsx" apps/tianshu-mobile/src/i18n/locales/zh-CN/settings.json apps/tianshu-mobile/src/i18n/locales/en-US/settings.json
git commit -m "feat(mobile): 我的页重组——当前主机卡片+GroupSection 分组列表，smoke 入口深埋关于（P0-T11）"
```

---

### Task 12: 主机/编排页视觉统一（轻量）

**Files:**
- Modify: `apps/tianshu-mobile/src/app/(tabs)/connections.tsx`（列表容器组卡化）
- Modify: `apps/tianshu-mobile/src/app/(tabs)/orchestration.tsx`（两 Tab 列表容器组卡化）
- Modify: `apps/tianshu-mobile/src/components/ConnectionCard.tsx`（行 hairline 统一）

**Interfaces:**
- Consumes: Task 2 的 `GroupSection`。
- 范围克制：**不动**卡片内部结构与全部交互（测试/激活/删除/运行/中止等），只统一外层容器与行分隔。

- [ ] **Step 1: connections.tsx 容器组卡化**

连接卡列表的外层容器（现为就地 `View` + 间距）改为 `<GroupSection>`（无 label——页面有导航头）或直接沿用圆角组卡 className（`overflow-hidden rounded-2xl`）统一；`ConnectionCard` 之间的分隔若现为 margin 间隔，改为贴边组卡 + 卡内 `border-b border-sep dark:border-[#545458A6]`（末卡去线）。

- [ ] **Step 2: orchestration.tsx 容器组卡化**

Graphs/Automations 两个列表容器同 Step 1 处理；分段切换控件（`TABS`）样式不动。

- [ ] **Step 3: 验收三件套 + Commit**

```bash
git add "apps/tianshu-mobile/src/app/(tabs)/connections.tsx" "apps/tianshu-mobile/src/app/(tabs)/orchestration.tsx" apps/tianshu-mobile/src/components/ConnectionCard.tsx
git commit -m "feat(mobile): 主机/编排列表容器组卡化，hairline 分隔统一（P0-T12）"
```

---

### Task 13: P0 全量验收

**Files:**
- 无新文件；核对 spec §9 功能不丢失核对表逐项走查。

- [ ] **Step 1: 机器验收**

```bash
cd /Users/hjx/workspace/mirror
npm run typecheck -w apps/tianshu-mobile
npm run test -w apps/tianshu-mobile
npx prettier --check "apps/tianshu-mobile/src/**/*.{ts,tsx,json}"
```

全绿为准（prettier 若报格式错，跑 `npx prettier --write` 于报错的文件后复跑）。

- [ ] **Step 2: 人工走查（真机/Expo Go，由用户启动 expo）**

按 spec §9 核对表逐项过（重点回归）：
1. 四 Tab 切换 + 图标选中态主题色；
2. 聊天页 push/pop、深链 `/session/[id]` 直达；
3. 会话：搜索/分组折叠/懒加载/置顶排序/左滑三操作/长按面板/归档筛选/下拉刷新/分页/空态 CTA；
4. 聊天：发送/停止/重试/长按复制/编辑重发/重新生成/模型选择持久/模式轮切/权限切换/专家选择与快捷提示/用量面板/审批 Banner/附件五链（引用文件/拍照/相册/本地文件/技能引用）/产物文件与预览/键盘抬升；
5. 主机：连接 CRUD/测试/激活切换/删除确认；
6. 编排：Graph 运行/中止/详情/删除、自动化启停/立即运行/删除、无 capability 引导；
7. 我的：语言/明暗/四主题色/通知三开关（含首次权限请求）/技能启停/MCP 列表/关于与 smoke 深埋可达。

- [ ] **Step 3: 视觉验收（expo web + Playwright 同机位截图对比，用户起服务后跑）**

按 memory「移动端 web 复现驱动法」：用户 `npm run start -w apps/tianshu-mobile`（web）后，对四 Tab、会话行、聊天页、我的页各截一帧，与改造前同机位对比，确认微信范式落地且无布局错乱。

- [ ] **Step 4: 收尾提交（如有走查修正）**

```bash
git add -A apps/tianshu-mobile/src
git commit -m "fix(mobile): P0 验收走查修正（逐项见核对表）"
```

---

## Self-Review 记录

- **Spec 覆盖**：四 Tab（T4/T5）、会话列表微信化（T6）、聊天页 ⋯/气泡/时间分隔/九宫格（T7/T8/T9/T10）、我的页（T11）、主机/编排统一（T12）、组件沉淀（T1/T2/T3）、验收核对表（T13）。spec §8 `Badge` 组件属 P1 未读数批，不在 P0——已从计划排除。spec §4.2「连接状态轻提示」由 T5 顶栏状态点覆盖。
- **createdAt 事实核验**：两端被控 getById 均带 createdAt（`session-detail.dto.ts`、`server-face/routes.ts` 已读确认），T7 纯透传成立。
- **Chips 收纳方案**：ModeChip/PermissionChip 为即时切换钮（读源码确认），故 T9 采用「标签+chip 右槽」自绘面板而非 AppActionSheet 回调式——五个 chip 零改动，专家快捷提示数据源不丢。
- **无 placeholder**：每个代码步骤含实际代码；唯一弹性点（ExpertChip props 精确签名、settings 无连接兜底 key 复用）已注明「以现有源码为准 + 复用优先」的裁决规则。
- **接口一致**：`Avatar`/`GroupSection`/`ListItem`/`AppActionSheet`/`timeSeparatorKeys`/`avatar-*` 各 Task 引用签名与定义处逐一对齐。
