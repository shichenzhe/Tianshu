# P-B 技能发现页(SkillHubClient + 市场 UI)设计

> 上游:PRD 技能管理与维护系统;宏观决策见 P-A spec §1-2(方案 1 主进程代理、
> SkillHub Open API、X-API-Key 占位符、埋点本地)。本文只覆盖 **P-B**。
> 前置:P-A 已合并(skillRecord 表、SkillRepository、我安装的管理页)。

## 1. 范围

| 做 | 不做(YAGNI,归期) |
|----|------|
| SkillHubClient(主进程 HTTP 客户端 + 指数退避) | "+"号安装、zip 导入弹窗(P-C) |
| skillhub IPC 通道(list/top/categories) | 技能详情页(PRD 推测项,市场卡直接对齐列表数据;需要时 P-C 顺带) |
| 发现页:精选区+换一换、分类 Tab、推荐网格 | AI 辅助创建(P-D) |
| 顶部导航区:搜索框、我安装的 [n]、添加技能下拉 | 埋点上报(P-E;下载量平台侧天然统计) |
| 添加下拉的"上传/创建"入口(toast 占位) | iconUrl 之外的富媒体卡片 |

## 2. SkillHubClient(主进程)

```
electron/domains/ai/skill/skillhub-client.ts
├── fetchJson<T>(path, query?): T         # GET + 信封解包 + 错误规整
├── listSkills({ keyword, category, page, pageSize, sortBy, order }): SkillHubPage
├── listTop(): SkillHubSkill[]            # /api/skills/top
├── listCategories(): SkillHubCategory[]  # /api/v1/categories(active 过滤)
└── 指数退避:429/5xx/网络错误重试 2 次(1s/2s),超时 10s(AbortSignal)
```

- **鉴权**:`X-API-Key` 取 `Constants.SKILLHUB_API_KEY`(空串则不发该头,API 当前
  非必填);`X-Client-User-Id` 用固定脱敏哈希(机器码 sha256 前 16 位,app 启动算
  一次)。**Key 不进仓库**:`Constants.ts` 默认空串,`process.env.SKILLHUB_API_KEY`
  覆盖;`scripts/lib/replace.mjs` 增占位符 `skh-your-api-key`(npm run init 写入,
  与 UPGRADE_URL 同机制)。
- 错误规整:HTTP `{error}` / 非 0 信封 code → `Error(message)`;网络层失败重试后
  仍失败 → `Error("网络错误")` 可被 `mapIpcError` 展示。
- 响应类型(仅声明消费字段,未文档字段不依赖):
  `SkillHubSkill { slug, name, description, description_zh, iconUrl, category,
  version, downloads, stars, score, source, labels }`;
  `SkillHubCategory { key, name, nameEn, sortOrder }`。
- **纯注入可测**:构造收 `fetchImpl`(默认 globalThis.fetch)与 baseUrl,单测用
  fake fetch 覆盖信封解包/退避/错误路径(不真实联网)。

## 3. IPC(挂在 SkillRepository,同文件新增三个 handle)

| 通道 | 参数 | 返回 |
|------|------|------|
| `skillhub:list` | `{ keyword?, category?, page?, pageSize?, sortBy?, order? }` | `SkillHubPage`(skills+total) |
| `skillhub:top` | — | `SkillHubSkill[]`(≤50) |
| `skillhub:categories` | — | `SkillHubCategory[]`(按 sortOrder 升序,active 过滤) |

IPCChannel 联合类型 + `src-react/domains/ai/skills/api/skillhub.api.ts` 同步补。

## 4. UI:技能 Tab 改双视图容器

```
src-react/domains/ai/skills/
├── views/SkillsView.tsx        # 新:视图状态(discover|installed)+ 顶部导航区
├── views/SkillManagerView.tsx  # 既有(P-A),去掉自带搜索条(职责上移)
├── views/SkillDiscoverView.tsx # 新:精选区 + 分类 Tab + 推荐网格
└── components/SkillHubCard.tsx # 新:市场卡(iconUrl 回退首字符/名称/描述截断/+ 按钮)
```

- **顶部导航区**(SkillsView,PRD §2.1):左=搜索框(占位"搜索技能";输入防抖
  300ms 调 `skillhub:list?keyword`,结果替换网格;清空回分类浏览);"我安装的 [n]"
  文字按钮(n 来自 ["skillRecords"] 缓存计数,点击切 installed 视图);右=添加技能
  下拉(DropdownMenu:查找技能→切 discover;上传技能/创建技能→toast 即将上线)。
- **发现页**(默认视图):
  - 精选区:`skillhub:top` 前 8 张横排(overflow-x-auto),右上"换一换"按钮本地
    随机洗牌(Fisher-Yates,纯函数可测)
  - 分类 Tab:`skillhub:categories`(staleTime 1h)+ 首位"全部";点击切 `category`
  - 网格:`skillhub:list`(category/keyword,pageSize 24,sortBy score);分页
    "加载更多"按钮(追加);"+"按钮 disabled + 点击 toast"安装功能即将上线"(P-C 接)
  - 加载失败:错误文案 + 重试按钮(重新 invalidate query)
- **我安装的视图**:复用 SkillManagerView;搜索条上移后由 SkillsView 统一?
  ——**不**:用户级搜索是本地过滤、市场搜索是远端 keyword,语义不同。installed
  视图保留自带搜索条;discover 视图的搜索框在顶部导航区(两视图互斥渲染,不冲突)。
  顶部导航区随视图切换:discover 显示市场搜索+我安装的+添加;installed 显示
  本地搜索+批量管理+添加(P-A 交互不变,外层加"返回市场"由"我安装的"按钮
  toggle 语义承担:installed 态点击回 discover)。
- React Query:`["skillhub","list",params]` / `["skillhub","top"]` /
  `["skillhub","categories"]`(staleTime:top 10min、categories 1h)。

## 5. 错误处理

| 场景 | 行为 |
|------|------|
| 市场 API 失败(任一通道) | 视图内错误态 + 重试按钮;不影响 installed 视图 |
| categories 失败 | 分类 Tab 只剩"全部",不阻塞网格 |
| iconUrl 加载失败 | img onError 回退首字符占位 |

## 6. 测试

- `tests/ai/skillhub-client.test.ts`:fake fetch —— 信封/裸对象两形态解包、错误
  规整、退避(2 次后成功/仍失败)、query 序列化
- `tests/ai/skill-shuffle.test.ts`:shuffleTop(洗牌保持集合不变、可注入随机源)
- 前端 UI 无组件测试基建,靠 lint/typecheck + 手测清单

## 7. 验收标准(DoD)

1. 技能 Tab 默认进发现页:精选区 8 张(可换一换)、分类 Tab 动态拉取、网格按评分排序、加载更多可用
2. 搜索框输入关键字 → 网格变为搜索结果;清空恢复分类浏览
3. "我安装的 [n]" 切换视图,n 与管理页条数一致;P-A 全部交互不回归
4. 断网/接口 5xx → 错误态 + 重试可恢复;categories 失败不阻塞
5. 主进程日志/渲染进程 bundle 中不出现真实 API Key
6. test/lint/typecheck 全绿

## 8. 决策记录

| # | 决策 | 理由 |
|---|------|------|
| 1 | "+"号 P-B 仅 toast 占位 | 安装引擎是 P-C;避免半套安装 |
| 2 | 不做技能详情页 | PRD 自注"推测逻辑";列表字段够展示;详情留 P-C 视需要 |
| 3 | Key = env 覆盖 + init 占位符,默认空串 | key 不得进 git;API 非必填,空串仍可用 |
| 4 | X-Client-User-Id = 机器码 sha256 前 16 | 官方建议脱敏稳定标识;不引入用户系统依赖 |
| 5 | 两视图互斥渲染,搜索框语义分置 | 市场远端搜索与本地过滤语义不同,不复用同一输入 |
