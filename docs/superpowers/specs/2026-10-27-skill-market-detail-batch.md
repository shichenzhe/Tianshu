# 技能市场详情页化 + 筛选报错修复批设计 spec

日期：2026-10-27
状态：直接开工（Explore 事实面已核实）
关联：用户报障——技能市场应单独跳转详情页；切换筛选报错

## 0. 事实基面（Explore 核实）

- 专家市场详情是**弹层**（MarketDetailDialog，experts.tsx:1159-1165），非路由页——本批按用户字面意图做**独立路由详情页**（项目 session/[id]、projects/[id] 动态路由先例），非复刻弹层。
- 技能市场内嵌设置页（SkillHubSection），市场行**无 onPress**（只有安装钮可点）；详情数据源：skillhub 面仅 list/top/categories/install 四段，**无 detail 端点**，未安装技能正文不可得——v1 详情页=概要级（SkillHubSkillDto 全字段）。
- 报错三候选：
  1. `parseSkill` 六字段全字符串强制 + `parseSkillArray` 全有或全无 → 任一条不合规整页 null → "Invalid skillhub list response"（skills.store.ts:163-210）——切分类/搜索后上游数据完整度差异可触发
  2. market 读写共用 `reqSeqs.market`：安装×筛选交错互判过期（loadMarketTop/searchMarket/install 同序号，skills.store.ts:265-276/570-574/633-665）
  3. 搜索 300ms 防抖闭包捕获创建时 category，切分类后旧定时器用旧 category 发请求（SkillHubSection.tsx:73-99）
- marketError 无 UI 消费（仅安装失败 toast）——报错显现形态由实施核实（searchMarket 失败写 error 还是 marketError、UI 哪展示）。

## 1. 本批裁定

### 1.1 筛选报错三修
1. **解析改逐行过滤**：非法行跳过（照 sessions「非法行整行过滤」先例），不再全有或全无——消除整页报错；数组级 null 仅保留给「非数组响应」。
2. **market 序号读写拆分**：install 独立序号（installingSlug 已有单槽语义），筛选（loadMarketTop/searchMarket）与安装互不判过期。
3. **筛选快照 ref**：keyword/category 经 ref 取最新值，防抖定时器不发陈旧组合。

### 1.2 技能详情页（/skills/[slug] 动态路由）
- expo-router 动态路由 `src/app/skills/[slug].tsx`：PageHeader（返回+技能名，router.back 先例）+ 概要区（图标/名称/版本/分类/双语描述/下载量/星数/评分）+ 底部安装操作（安装中/已安装态复用现有 install 链与覆盖确认）。
- 概要取数：从 marketItems 按 slug 找（市场进入即时渲染）；找不到（深链/被筛选替换）fallback 调 searchMarket({keyword: slug}, true) 再查找——v1 无 detail 端点，此 fallback 为尽力而为，找不到显「不存在/已下架」占位。
- 根 Stack 注册 skills/[slug] `headerShown:false`（双标题教训）。
- 市场行整行 onPress → router.push 详情页。
- 不做：未安装技能正文预览（需新 detail 端点+宿主预览能力，另批）；不做排序三档（无 createdAt 字段，协议扩展另批）。

## 2. 测试与验收
- store：逐行过滤用例（一条不合规其余保留）+ install/筛选并行不互过期用例 + 解析边界。
- 页面：数据面用例（slug 查找/fallback/占位分支，纯函数抽出）；既有 589 零红。
- typecheck + prettier；分提交。

## 3. 风险
- fallback searchMarket(keyword=slug) 语义不完美（slug ≠ 名称）——v1 可接受，深链场景占位兜底。
- marketItems 被筛选替换后返回市场再点详情——行 slug 仍带在路由参数里，不受影响。
