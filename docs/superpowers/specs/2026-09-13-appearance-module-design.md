# 外观模块设计（设置面板 · 皮肤级主题系统）

- 日期：2026-09-13
- 状态：待用户审阅
- 来源 PRD：`docs/外观 PRD.md`（设置面板-外观模块）
- 范围：设置面板「外观」Tab 落地（预览卡 + 皮肤网格）+ 皮肤级主题系统（明暗模式 + 色彩 + 装饰）；现有 4 色主题体系兼容整合

## 1. 目标

把设置面板的「外观」占位 Tab（SettingsDialog.tsx:53 禁用项）落地为完整皮肤中心：主题预览卡 + 10 款皮肤网格即点即切；引入**深色模式**与皮肤化视觉（色系 + 装饰背景）；全 UI 语义变量联动。

## 2. 关键决策

| 决策点 | 结论 | 理由与代价 |
| --- | --- | --- |
| **IP 联名皮肤处理**（需拍板） | **去版权化**：PRD 的张韶涵/和平精英/张靓颖/经典 QQ 为 QQ 的 IP 皮肤，本项目无授权插画资源——10 款皮肤全部**本地原创命名与视觉**（抽象色系 + 渐变 + SVG 图案，不仿 IP 插画）；皮肤名目：浅色、深色（基础）+ 晨雾/涟漪/原野/海空/暖沙/暮色/松林/墨韵 8 款精选（各带明暗与色系） | 保留 IP 名目而无 IP 视觉是空壳且涉版权风险；代价：与 PRD 名目表不一致（视觉品质靠 CSS 渐变与 SVG 装饰撑，无位图插画） |
| 皮肤架构 | **皮肤 = { id, mode: light\|dark, hue, wallpaper? } 三元组**：`data-mode` 新属性控制明暗变量集；`data-theme`（现有 4 色 hue）保留复用；`data-wallpaper` 控制装饰层（body/侧栏渐变 + SVG 图案背景） | 现有 4 色体系零破坏——ThemeSelector（顶栏语言旁）保留，语义变为"基础浅色下切色相"；皮肤选择器写全三元组 |
| 深色模式实现 | `globals.css` 新增 `[data-mode="dark"]` 完整变量集（背景/前景/card/muted/border/tooltip 等全套 HSL 暗色映射，primary 保持 hue 驱动） | 全 UI 已走语义变量（CLAUDE.md 规范），变量集覆盖即全局生效；风险在少量硬编码色残留——专项核查任务清理 |
| 皮肤视觉 | 全部 CSS 原生：每款皮肤 = hue 值 + 可选 wallpaper 变量组（`--skin-sidebar-image`（SVG data-URI 图案）/`--skin-bg-gradient`）；无位图、无网络资源 | PRD"网络主题下载"边界条目本地化裁定为**全内置**（本地应用无下载场景，Loading 骨架降为瞬时切换） |
| 主题属性胶囊 | 显示皮肤**类型**标签（基础主题/精选皮肤）——PRD 的"永久有效/限时/VIP"付费语义不做（无账号体系），胶囊右上角展示类型 | 假付费语义违反 C 方案精神 |
| 持久化 | 扩展现有 `tianshu-theme` persist（zustand）：结构升级为 `{ skin: string; hue: string }`（迁移兼容：旧值 `{theme:"orange"}` 读入映射为浅色+该 hue） | 单 key 延续，启动即应用 |
| 预览卡 | 模拟主界面缩略（侧栏条 + 对话气泡 + 输入框的 div 组合）以**当前皮肤变量**渲染（CSS 变量作用域天然生效，缩小布局非截图）；右上角类型胶囊 | PRD 3.1；真实变量驱动即"实时预览"的本质 |

## 3. 架构

### 3.1 皮肤定义（静态数据 + CSS）

```
src-react/stores/skin.store.ts          # zustand persist：{ skin, hue } + applySkin（写 data-mode/data-theme/data-wallpaper）
src-react/styles/skins.css              # [data-mode="dark"] 暗色变量集 + [data-wallpaper="..."] 8 款装饰层（globals.css import）
src-react/domains/app-settings/model/skins.ts   # 10 款皮肤元数据（id/名称/描述/类型/mode/hue/wallpaper/缩略图变量）
```

10 款（mode × hue × wallpaper）：

| id | 名称 | mode | hue | 装饰 |
|---|---|---|---|---|
| light | 浅色 | light | blue(220°) | 无 |
| dark | 深色 | dark | blue(220°) | 无 |
| dawn-mist | 晨雾 | light | 260° | 淡紫云纹 SVG |
| ripple | 涟漪 | light | 190° | 水纹同心圆 SVG |
| field | 原野 | light | 120° | 草地渐变 |
| ocean-sky | 海空 | light | 205° | 天海渐变 |
| warm-sand | 暖沙 | light | 35° | 沙丘渐变 |
| dusk | 暮色 | dark | 15° | 暖橙暮光渐变 |
| pine | 松林 | dark | 150° | 墨绿层叠渐变 |
| ink | 墨韵 | dark | 225° | 深蓝漩涡 SVG |

### 3.2 设置面板外观页

```
src-react/domains/app-settings/components/AppearanceSettings.tsx   # 预览卡 + 网格
src-react/domains/app-settings/components/ThemePreviewCard.tsx     # 变量驱动缩略主界面
src-react/domains/app-settings/components/SkinCard.tsx             # 缩略图卡（变量缩微渲染 + 类型角标 + 选中边框）
```

- SettingsDialog 解禁 appearance 项（disabled 移除 + 路由到新组件）；
- 布局：预览卡（上，变量驱动的模拟界面 + 右上类型胶囊）→「全部皮肤」标题 + 5 列网格（grid-cols-5，窄屏响应 3/2 列）；
- 点击卡片即 `setSkin(id)`（瞬时切换，预览同步）；选中卡 `border-primary ring-2 ring-primary/30`；
- SkinCard 缩略图 = 该皮肤变量的微缩组合（背景色块 + 侧栏色条 + 主色圆点），hover 轻微抬升。

### 3.3 主题体系整合

- `useThemeStore`（现有）改造为 `useSkinStore` 或共存：**推荐改造合并**（theme.store.ts → skin.store.ts，导出兼容 hook `useThemeStore` 别名保留 ThemeSelector 不动或最小改）；hue 单独可变（ThemeSelector 写 hue 保持当前皮肤 mode/wallpaper）；
- 启动初始化：`applySkin` 在应用入口（现有 applyTheme 调用点替换）；
- 4 色 ThemeSelector 行为：浅色模式下切 hue；深色/装饰皮肤下切 hue 同样生效（hue 是正交维度）。

### 3.4 全局联动与核查（PRD §4）

切换皮肤后侧栏背景/内容区背景/文字/组件/图标全部跟随——依赖语义变量全覆盖。**专项核查任务**：grep 全仓硬编码色类残留（`bg-white`、`text-black`、`bg-gray-*`、`bg-slate-*` 等非语义类），清理为语义变量；这是深色模式可用的前提。

## 4. 异常与边界

| 场景 | 处理 |
|---|--- |
| 未知皮肤 id（persist 脏数据） | 回落 light + 日志 |
| 旧版 persist 结构（`{theme:"orange"}`） | 迁移映射为 `{ skin:"light", hue:"orange" }` |
| 壁纸 SVG 渲染失败 | 壁纸层仅为渐变/图案叠加，底层始终有语义背景色兜底 |
| 图片资源 | 零位图——不适用 PRD 的图片加载失败占位图条款 |
| 深色下文字对比度 | 暗色变量集逐项对 W3C 对比度抽查（验收项） |

## 5. i18n / 测试 / 手动验收

- i18n：settings namespace 扩展 `appearance.*`（标题/全部皮肤/预览/类型标签/皮肤名与描述——皮肤名走 i18n 还是静态中文数据？**皮肤名称/描述为品牌化内容数据走静态 zh 双语 fields**（skins.ts 每款带 name/nameEn/desc/descEn），避免 40+ key 膨胀；界面文案走 i18n；
- 单测：skin.store（迁移/回落/applySkin 三属性写入/双维正交）、skins.ts 元数据完整性（id 唯一/浅深覆盖/缩略变量存在）、AppearanceSettings（渲染网格/点击切换/选中态/预览卡胶囊）；
- 手动验收清单：10 款切换全 UI 联动（含 AI 聊天/项目四 Tab/设置各页）、深色对比度、重启持久化、旧数据迁移、ThemeSelector 与皮肤正交。

## 6. 风险

1. **深色模式的全局适配面**是最大风险——语义变量规范已执行两期项目模块，但 AI 域存量代码可能有硬编码残留；专项核查任务兜底；
2. **壁纸装饰的品质**：纯 CSS/SVG 的"插画感"有限——按"氛围渐变+纹理图案"定位预期，不做位图插画；
3. theme.store 合并的兼容面：ThemeSelector/启动入口/既有测试引用——改造以别名兼容 + 全量回归兜底。
