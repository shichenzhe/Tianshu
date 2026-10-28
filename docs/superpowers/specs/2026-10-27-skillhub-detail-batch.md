# SkillHub detail 端点 + 详情正文 + 最新排序批设计 spec

日期：2026-10-27
状态：直接开工（hub 实测 + 三端代码面已核实）
关联：`2026-10-27-skill-market-detail-batch.md` 留档项回填——「未安装技能正文预览需 detail 端点另批」「排序最新档需 createdAt 协议扩展另批」

## 0. 事实基面（实测/核实）

- **hub 真实上游**（skillhub-client.ts 注入 `https://api.skillhub.cn`）：
  - `GET /api/v1/skills/{slug}` 裸对象实测（pdf-reader）富形状：`skill.{slug,displayName,category,iconUrl,summary,summary_zh,overviewMd,hasOverview,created_at,source,sourceUrl,labels,stats{downloads,installs,stars,versions,comments},subCategories}`、`owner{displayName,handle,image}`、`latestVersion{version,changelog,createdAt}`、`securityReports{keen,sanbu}` 各 `{reportUrl,status,statusText}`（实测均 benign）。`overviewMd` 可为空串（hasOverview:false 时）。
  - **list/top 行原生带 `created_at`**（epoch ms）——「无 createdAt」是客户端/协议声明面未收，非上游缺失，排序「最新」档可行。
- 桌面 `SkillHubClient.getDetail` 已存在（skillhub-client.ts:190）但只声明 `{skill:{slug,version?},latestVersion:{version}}`（skill-installer.ts:444 latestVersion 比对消费）——本批扩声明，安装链零改动。
- face 四端点（skillhub-tap.ts / routes.ts:2190-2199 / deps.ts:327-332）；`ENDPOINTS.skillhub` 四段（server-event.ts:291-294）；钉测试 skillhub 组 toEqual（protocol-package.test.ts:137-142）。
- **无头端不报 skillhub 能力位**（DESKTOP_CAPABILITIES 专属）——本批零无头端/SDK 改动。
- 移动端：详情页概要级（[slug].tsx + logic/skill-detail.ts 三分支）；市场无排序档（SkillHubSection）；专家市场排序三档钮先例（experts.tsx:649/709-723）；MarkdownLite 渲染器已有（library md 预览先例）；store 资源序号已拆 detail 需新列（skills.store.ts:291-299）。

## 1. 本批裁定

### 1.1 协议包（skill-contract.ts + server-event.ts，冻结后重建 dist）
- `SkillHubSkillDto` 增 `createdAt?: number`（epoch ms；hub 蛇形 `created_at` 由 repo 映射 camel；旧被控端可选兼容）。
- 新 `SkillHubDetailDto`（只声明消费面）：`skill{slug,displayName?,category?,iconUrl?,summary?,summary_zh?,overviewMd?,hasOverview?,createdAt?,source?,sourceUrl?,stats?{downloads,installs,stars,versions,comments}}`、`owner{displayName,handle,image}|null`、`latestVersion{version,changelog?,createdAt?}|null`、`security: SkillHubSecurityStatus`。
- **securityReports 归一单值**（repo 侧纯函数）：`"benign"`=全部报告 benign / `"caution"`=存在非 benign / `"unknown"`=无报告——移动端零报告形状知识。
- `ENDPOINTS.skillhub` 增 `detail: "skillhub/detail"`（4→5 段）；钉测试同步。

### 1.2 桌面被控面
- client：`SkillHubSkill` 增 `created_at?: number`；`SkillHubSkillDetail` 扩消费声明（照 hub 实测形状，只声明消费字段；`latestVersion` 宽容化为可空，安装链 `?.` 消费兼容）。
- repo：`listHubSkills/listHubTop` 行经 `mapHubSkill`（蛇形 created_at → camel createdAt）返回 DTO 形状；新增 `getHubSkillDetail(slug)` → `SkillHubDetailDto`（映射 + securityReports 归一）。
- face：`ServerFaceSkillHub` 增 `detail(slug)`；tap 桥 + `SkillHubRepoSubset` 扩；routes `handleSkillHubDetail`（slug 非空校验照 install 口径）注册 `skillhub/detail`。

### 1.3 移动端
- store：`SkillResource` 增 `"detail"`（独立序号——详情页与市场筛选/安装互不过期）；state 增 `detail/detailLoading/detailError`；`loadDetail(slug)`（skillhub 能力门禁；失败写 detailError 静默降级）。
- 排序纯函数 `logic/skill-market-sort.ts`：`MarketSortMode = comprehensive|hot|newest`；`sortMarketItems(items, mode)`——综合 score / 热门 downloads / 最新 createdAt desc；**缺 createdAt 行沉底**；copy+sort 不变更输入（experts.tsx:709-723 同口径）。
- 市场页：分类条下排序三档 chips（默认综合，纯客户端排序 marketItems）。
- 详情页增广区（detail 拉到才渲染，失败无感降级）：作者行（owner.displayName）、安全徽标（benign/caution/unknown 三态本地化 + 图标色）、meta 补行（安装 N · 版本 N · 评论 N）、「详细介绍」正文——**overviewMd（MarkdownLite 渲染）> summary/summary_zh（纯文本）> 占位「暂无详细介绍」**。
- i18n：skills ns 双语补 key（排序三档照 experts 键名 sortComprehensive/sortHot/sortNewest）。

### 1.4 不做（留档）
桌面发现页正文预览（桌面 UI 另批）；已装技能 latestVersion 升级比对提示；securityReports reportUrl 跳转（移动端无浏览器）；contentZhAvailable 中文正文切换；hub 服务端 sortBy 透传（客户端排序够用）；changelog 展示。

## 2. 测试与验收
- 协议：protocol-package.test.ts skillhub 组 4→5 段；FACE_CAPABILITIES 不变；dist 重建后 face/mobile typecheck 绿。
- face：skillhub-tap 补 detail 用例（映射/security 归一三分支/SKILLHUB_UNAVAILABLE）+ mapHubSkill created_at→createdAt；routes 补 detail 载荷校验（slug 缺失/非法）。
- mobile：sortMarketItems 纯函数用例（三档/缺 createdAt 沉底/输入不变性）；loadDetail 端点与序号防迟到用例；既有零红。
- 根 typecheck + prettier；分提交。

## 3. 风险
- hub detail 形状演进——消费面全可选段宽容，缺字段占位兜底不炸页。
- overviewMd 长文渲染——MarkdownLite 整文渲染，与 library md 预览同先例同风险面。
- 协议改动后 symlink 消费 dist——先重建协议包再跑 face/mobile 测试。
