# 外观模块实施计划（皮肤级主题系统）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 设置面板「外观」Tab 落地（预览卡 + 10 款皮肤网格）+ 皮肤三元组主题系统（明暗 × 色相 × 装饰）+ 深色模式全局适配。

**Architecture:** `data-mode`（明暗变量集）+ `data-theme`（现有 hue 复用）+ `data-wallpaper`（装饰层）三属性驱动；skin.store 扩展现有 persist 并迁移旧数据；皮肤视觉纯 CSS/SVG 全内置。

**Tech Stack:** 同主仓（React 19 + Tailwind 4 + zustand persist + CSS variables）。

**Spec:** `docs/superpowers/specs/2026-09-13-appearance-module-design.md`（执行者必读——10 款皮肤表与决策理由在 §3.1/§2）

## Global Constraints

- 同项目规范：i18n 双语同步、语义色（本模块正是语义色体系的建设者——**新代码严禁硬编码色**）、Prettier、IPC 不涉及
- 暗色变量集必须**逐项对照** globals.css 的亮色集（同名变量一个不漏），值按 W3C AA 对比度调校
- theme.store 改造保持 `useThemeStore` 导出兼容（ThemeSelector 与既有测试依赖）
- 测试基线：当前 master 全量 1125/1125、typecheck/eslint 全绿——每任务保持
- 工作目录：以执行时 controller 指定的 worktree 为准

## 文件结构总览

```
src-react/styles/skins.css                                   [新] 暗色集 + 壁纸层（globals.css import）
src-react/styles/globals.css                                 [改] import skins.css
src-react/stores/skin.store.ts                               [新] {skin, hue} persist + 迁移 + applySkin
src-react/stores/theme.store.ts                              [改] 兼容层（re-export skin store 的 useThemeStore 别名）或合并
src-react/domains/app-settings/model/skins.ts                [新] 10 款皮肤元数据
src-react/domains/app-settings/components/ThemePreviewCard.tsx [新]
src-react/domains/app-settings/components/SkinCard.tsx       [新]
src-react/domains/app-settings/components/AppearanceSettings.tsx [新]
src-react/domains/app-settings/components/SettingsDialog.tsx [改] 解禁 appearance
src-react/i18n/locales/{zh-CN,en-US}/settings.json           [改] appearance.* 界面文案
tests/app-settings/skin-store.test.ts 等                     [新]
全仓 src-react/ 硬编码色类清理                                [改] T6 专项
```

---

### Task 1: skins.css——暗色变量集 + 8 款壁纸装饰层

**Files:**
- Create: `src-react/styles/skins.css`
- Modify: `src-react/styles/globals.css`（文件头 import "./skins.css";）

**Interfaces:**
- Produces: `[data-mode="dark"]` 全套变量 + `[data-wallpaper="<id>"]` 8 组装饰变量（供 T2 applySkin 写属性、T4 卡片渲染消费）

- [ ] 读 globals.css 亮色 `:root` 变量清单（背景/前景/card/popover/secondary/muted/accent/destructive/border/input/tooltip 等）——`[data-mode="dark"]` **逐项覆盖**（HSL 暗色映射：背景 220 15% 8%、card 220 13% 12%、muted-foreground 提亮至 60%、border 降至 22% 亮度等；primary 系保持 hue 驱动不变；--color-tooltip 暗色下反转为浅底深字或保持深底仅调边）
- [ ] 壁纸层 8 组（spec §3.1 表）：每组定义 `--skin-bg-gradient`（body 背景叠加渐变，light 系低饱和度透明叠加、dark 系深色渐变）与 `--skin-sidebar-image`（SVG data-URI 图案：晨雾云纹/涟漪同心圆/原野草渐变/海空天海线/暖沙沙丘/暮色暖光/松林层叠/墨韵漩涡——简单几何 SVG，低透明度平铺或大渐变，**品质定位"氛围纹理"**）；light 系壁纸需在暗色模式下失效（壁纸层选择器嵌套 `[data-wallpaper="ripple"]:not([data-mode="dark"])` 或每款皮肤自带 mode 固定——按 spec 表每款皮肤 mode 固定，选择器独立无交叉，无此问题）
- [ ] body/侧栏消费点：`body` 背景 `var(--color-background)` 叠加 `var(--skin-bg-gradient, none)`；侧栏壳（GlobalSidebar 内层）叠加 `var(--skin-sidebar-image, none)`——**消费点改动最小化**：skins.css 内用属性选择器直接覆盖 `body` 与 `[data-wallpaper] body`？不——CSS 无法反向选择；采用：skins.css 定义变量 + 在 skins.css 尾部直接写 `body { background-image: var(--skin-bg-gradient, none); }`（与 globals 的 background-color 并存——background-color 在 globals、image 在 skins，互不覆盖）
- [ ] 视觉自查：临时手动在 devtools 验证不可行（无 GUI）——以变量值合理性 + T4 卡片渲染测试兜底；对比度按 HSL 亮度差 ≥45% 抽查记录在报告
- [ ] typecheck（CSS 无类型影响，确认 import 路径无拼写错——构建由 vite 处理，跑 `npx vitest run` 全量确认无破坏）+ 提交 `feat(settings): 皮肤样式层——深色模式变量集 + 八款壁纸装饰`

---

### Task 2: skin.store + theme.store 兼容改造（TDD）

**Files:**
- Create: `src-react/stores/skin.store.ts`
- Modify: `src-react/stores/theme.store.ts`（兼容层）
- Test: `tests/app-settings/skin-store.test.ts`

**Interfaces（T4/T5 消费）:**

```ts
export interface SkinState {
  skin: string;          // 皮肤 id，缺省 "light"
  hue: string;           // "blue"|"red"|"green"|"orange"，缺省 "orange"（沿用现状默认）
  setSkin: (skinId: string) => void;   // 写 data-mode/data-theme(皮肤的 hue 或当前 hue 正交保持——见 ruling)/data-wallpaper
  setHue: (hue: string) => void;       // 正交：保持 skin 的 mode/wallpaper，仅换 data-theme
}
export function applySkin(skin: string, hue: string): void;  // 三属性一次写入 + 未知 id 回落 light
export function useThemeStore(): SkinState;  // 兼容别名（ThemeSelector 既有 setTheme 调用改名适配或保留 setTheme 别名——读 ThemeSelector 实际用法后定，最小改动）
```

Ruling（正交语义）：`setSkin(id)` 时若目标皮肤与当前 mode 相同则保留用户当前 hue（用户在深色下选了红相再切"墨韵"仍是红相？——**否，spec §2 决策"皮肤选择器写全三元组"**：setSkin 写皮肤自带的 hue（皮肤是完整预设）；`setHue`（ThemeSelector）为正交微调且会同时更新 store.hue。两者独立可叠加，最后写入者生效。）

- [ ] 失败测试：persist 迁移（旧 `{theme:"orange"}` → 读入 `{skin:"light", hue:"orange"}`——zustand persist migrate 或 merge 自定义）；未知皮肤 id 回落 light；applySkin 三属性 DOM 断言（jsdom document.documentElement.dataset）；setHue 不动 mode/wallpaper；setSkin 写全三元组
- [ ] 实现：zustand persist（key 沿用 `tianshu-theme`，version 升 1 + migrate）；启动初始化点接线（grep applyTheme 现调用点替换为 applySkin——main.tsx 或 App 入口，找到实际位置）
- [ ] theme.store.ts：改 re-export（`export { useThemeStore } from "./skin.store"`——若 ThemeSelector 用了 `theme` 字段名则 skin.store 同时暴露 `theme` getter 兼容或 ThemeSelector 最小改造改用 hue；既有 tests 引用 grep 核实）
- [ ] 全量（含 ThemeSelector 既有测试回归）+ typecheck + eslint + 提交 `feat(settings): 皮肤状态——三元组 store、旧主题数据迁移、theme.store 兼容层`

---

### Task 3: skins.ts 元数据 + settings i18n（TDD 轻量）

**Files:**
- Create: `src-react/domains/app-settings/model/skins.ts`
- Modify: `src-react/i18n/locales/{zh-CN,en-US}/settings.json`（appearance 组：title（已有"外观"）/preview/allSkins/basicType/premiumType/selected）

**Interfaces:**

```ts
export interface SkinDef {
  id: string;                // "light"|"dark"|"dawn-mist"|...（spec §3.1 十款）
  mode: "light" | "dark";
  hue: "blue" | "red" | "green" | "orange";  // 映射 data-theme
  wallpaper: string | null;  // null=无装饰；否则 data-wallpaper 值
  type: "basic" | "premium";
  name: string; nameEn: string;         // 品牌化内容数据不走 i18n（spec §5）
  desc: string; descEn: string;
}
export const SKINS: SkinDef[];
export function getSkin(id: string): SkinDef | undefined;
```

- [ ] 失败测试：id 唯一；恰好 10 款且 light/dark 为 basic 其余 premium；hue 均为合法枚举；getSkin 未知 undefined
- [ ] 实现（名称/描述按 spec §3.1 中文名 + 对应英文）+ i18n keys 双语
- [ ] 全量 + 提交 `feat(settings): 皮肤元数据十款 + appearance i18n`

---

### Task 4: ThemePreviewCard + SkinCard（TDD）

**Files:**
- Create: `src-react/domains/app-settings/components/ThemePreviewCard.tsx`、`SkinCard.tsx`
- Test: `tests/app-settings/skin-cards.test.tsx`

**Interfaces:**
- `ThemePreviewCardProps { skin: SkinDef }`：模拟主界面缩略（左侧窄条=侧栏色 + wallpaper 图案、右侧对话区背景 + 两枚气泡（user 右 primary/user-foreground、assistant 左 muted）+ 底部输入条 border 圆角）——**全部用 CSS 变量**（`var(--color-*)`）且卡片根元素设 `data-mode/data-theme/data-wallpaper` 使 skins.css 选择器局部生效（属性选择器作用于卡片子树——验证 [data-mode="dark"] 变量集可作用于非 html 元素：CSS 变量继承自匹配元素，成立）；右上角类型胶囊（basicType/premiumType，深灰底白字）
- `SkinCardProps { skin: SkinDef; selected: boolean; onSelect: (id) => void }`：微缩缩略（背景色块（skin.mode 决定深浅——同法局部 data-mode）+ 侧栏色条 + hue 主色圆点）+ 名称（按 locale 取 name/nameEn——用 i18n.language 判断）+ 角标（premium 时右上小角标）+ 选中 `border-primary ring-2 ring-primary/30` + hover 抬升 + button a11y

- [ ] 失败测试：预览卡深色皮肤下背景类切换（断言根元素 data-mode 属性 + 胶囊文案）；SkinCard 渲染名称双语分流；selected 类名；onSelect 回调；premium 角标
- [ ] 实现 + 全量 + 提交 `feat(settings): 皮肤预览卡与缩略卡——变量局部作用域渲染`

---

### Task 5: AppearanceSettings + SettingsDialog 解禁（TDD）

**Files:**
- Create: `src-react/domains/app-settings/components/AppearanceSettings.tsx`
- Modify: `src-react/domains/app-settings/components/SettingsDialog.tsx`（appearance 项 disabled 移除 + 内容区渲染 AppearanceSettings；移除"敬请期待"禁用态相关逻辑）
- Test: `tests/app-settings/appearance-settings.test.tsx`

Binding:
- 布局：ThemePreviewCard（当前 store.skin，切换即时更新）→ 「全部皮肤」标题 → 5 列网格（`grid-cols-5`，`md:grid-cols-3 sm:grid-cols-2` 响应）滚动；
- 点击 SkinCard → `useSkinStore.setSkin(id)` → 预览即时换肤（store 驱动）；
- 选中态读 store.skin。

- [ ] 失败测试：渲染 10 卡；点击卡 → store.setSkin 调用（或 DOM data-mode 变化）；选中卡样式；预览卡随 store 更新；SettingsDialog 外观项可点进（不再 disabled）
- [ ] 实现 + 全量（settings-dialog 既有测试的外观占位断言更新）+ typecheck + eslint + 提交 `feat(settings): 外观设置页——预览卡+皮肤网格即点即切`

---

### Task 6: 全仓硬编码色核查清理

**Files:**
- 核查与修复：`grep -rn "bg-white|bg-black|text-white|text-black|bg-gray-|text-gray-|bg-slate-|bg-zinc-|bg-neutral-|from-blue-|to-blue-|bg-emerald-|text-emerald-" src-react/ --include="*.tsx"`（+ 补充 emerald/indigo/violet/rose 等常见 Tailwind 调色板类）——逐一分类：语义变量替换（bg-white→bg-background、text-gray-500→text-muted-foreground、bg-emerald-500 流式绿点→bg-primary 等语义评估）或确属固定装饰色（如代码块语法高亮色）保留并注明
- 注意：`tests/` 里的类名断言同步更新；`--color-tooltip` 深底白字为设计固定组合不算违规

- [ ] grep 清单入报告（每条：文件:行 → 处置）
- [ ] 替换修复 + 受影响测试更新 + 全量 + 提交 `refactor(theme): 硬编码色清理——深色模式全 UI 适配前提`

---

### Task 7: 收尾——全量验证 + 手动验收清单

- [ ] `npm run typecheck && npm run lint && npm run test` 全绿
- [ ] 写 `docs/superpowers/manual-acceptance-2026-09-14-appearance-module.md`（照三期格式）：
  - 设置→外观：预览卡初始浅色 → 点深色全应用即时暗（含 AI 聊天/项目动态流/资产/计划看板/自动化/资料库逐页走查）→ 8 款精选逐一切换（壁纸渐变在 body/侧栏可见）→ 选中边框/类型角标/胶囊
  - 顶栏 ThemeSelector：深色皮肤下切红色——mode 保持暗、仅色相变（正交验证）
  - 重启应用 → 皮肤恢复（持久化）；老用户数据（若模拟旧 tianshu-theme）→ 迁移为浅色+原色相
  - 深色对比度抽查（正文/侧栏/muted 文字）
  - 四主题色（蓝红绿橙）在浅/深两模式下主 UI 走查
  - 已知边界附录：壁纸纯 CSS 纹理品质定位；皮肤名目去版权化（PRD 名目表差异说明）
- [ ] 提交 `docs(settings): 外观模块手动验收清单`

---

## 自审记录

1. **Spec 覆盖**：§2 决策表→T1（CSS/全内置/类型胶囊）/T2（三元组/持久化迁移/正交）/T6（联动核查）；§3.1 皮肤表→T1/T3；§3.2 设置页→T4/T5；§3.3 整合→T2；§4 异常→T2（回落/迁移）/T1（底层兜底）；§5 i18n/测试/验收→T3/T4/T5/T7。无缺口。
2. **占位符**：T1 对比度记录与 T2 ThemeSelector 适配点为"执行时核实"步骤（有明确判定路径），非 TBD。
3. **类型一致性**：SkinDef（T3）与 T4/T5 消费一致；SkinState（T2）与 T5 消费一致；wallpaper id 与 skins.css 选择器（T1↔T3 由 T3 测试锁定合法枚举）。
