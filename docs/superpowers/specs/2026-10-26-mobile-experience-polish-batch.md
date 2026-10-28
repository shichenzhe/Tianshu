# 移动端体验精修批设计 spec

日期：2026-10-26
状态：直接开工（用户已裁定散点合批；数据面事实已核实）
关联：[[user-rulings-2026-10-26]]（对话式创建定性）；A2/A3/A4 批留档裁剪的回填

## 0. 事实基线

- 桌面专家市场排序三档（`market-filter.ts`）：comprehensive=score desc / hot=downloads desc / newest=createdAt desc；core `ExpertMarketItem` 四字段俱全（score/downloads/createdAt/category）。
- 契约 `ExpertMarketSummary` 未透出排序字段与分类名——A2 批移动端市场排序只做了综合/名称、分类 chips 显 categoryId 原值的裁剪。
- 分类名字典在 core `EXPERT_CATEGORIES`（slug/titleKey/icon/gradient/expertSlugs）——**titleKey 是 i18n 键，消费端本地化**，无中英硬编码字面量。
- `ExpertCreateParams` 有 `sourceSlug: item.slug`，但契约 `AssistantSavePayload` 无此字段——A2 批 installFromMarket 未回传来源。
- 桌面「对话式创建」=新开会话+预填 `chat.json` 的 `experts.createPrompt` 模板（访谈式提问→宿主 agent 调 `create_expert` 工具落库），零产品流骨架。

## 1. 本批裁定

### 1.1 协议增量（expert-contract.ts，冻结后重建 dist）
- `ExpertMarketSummary` 增可选段：`score?: number`、`downloads?: number`、`createdAt?: string`（ISO）、`categoryTitleKey?: string`（经 EXPERT_CATEGORIES 查得的 titleKey，消费端本地化）。
- `AssistantSavePayload` 增 `sourceSlug?: string | null`（undefined 保留 / 值即设置——与既有三态注释同排说明）。
- mirror 钉测试不涉及（无常量面）。

### 1.2 face 层
- expert-tap marketList 映射补齐四段（score/downloads/createdAt/categoryTitleKey——经 core EXPERT_CATEGORIES find）；assistant/save 透传 sourceSlug 到 repo（先读 repo create/update 是否已支持 sourceSlug 列——schema 里 assistant 表应有该列，若无则停下报告）。

### 1.3 移动端
1. **对话式创建**：/experts 我的段加「对话式创建」入口 → 首个 workspace 建会话（session/create）→ send 预填提示词 → 跳会话页。提示词模板 i18n 双语（zh 照桌面 `experts.createPrompt` 口径改写，en 同构）；会话建好回 /experts 重拉列表（订阅 session.updated 即可，既有面）。
2. **搜索逐词高亮/导航**：message-search 升级为命中位置级（消息索引+块内偏移数组）；导航逐位跳转（上/下在位置级循环），计数=位置数；高亮=命中子串包 `<Text>` 主色底（RN 嵌套 Text，禁 flex-1 行规则不破）；对齐桌面大小写不敏感/非重叠语义。
3. **市场排序三档**：综合（score）/热门（downloads）/最新（createdAt）——服务端已下发字段，纯客户端排序；无字段的旧端回退现有名称排序。
4. **分类名本地化**：chips 显 i18n（titleKey→experts ns 12 分类名双语）；installFromMarket 回传 sourceSlug。

### 1.4 非目标
桌面端不动；expert-market 数据不动；专家团成员编辑器（仍不做）。

## 2. 测试与验收
- face：marketList 四段映射/save sourceSlug 透传用例。
- mobile：search 位置级钉测试（多命中/跨块/导航循环）；store 端点映射；i18n 齐平；既有 466 零红。
- 根 typecheck + 双仓全量绿；分提交。

## 3. 风险
- assistant 表若无 sourceSlug 列则 face 侧需停（schema 变更走 v1 快照，属批外）。
