# P-A 技能管理地基(skillRecord + 我安装的 + 批量管理)设计

> 上游 PRD:技能(Skill)管理与维护系统(2026-09-05,对话定稿)。
> 本文只覆盖分期 **P-A**;P-B~P-E 见 §1 分期表,各自单独 spec。

## 1. 背景与分期

现状(P2 交付):技能 = `userData/skills/` 与工作空间 `.mirror/skills/` 下的
SKILL.md 目录扫描(`skill-loader.ts`),无 DB、无启用状态、无管理 UI
(技能 Tab 仅"打开技能目录"按钮)。

市场数据源已确认:**SkillHub Open API**(`https://api.skillhub.cn`,腾讯,
文档 github.com/Tencent/skillhub;列表/Top 榜/分类/详情/下载接口已于
2026-09-05 用团队 Key 实调验证通过)。整体架构采用**主进程统一市场代理**:
所有 SkillHub 请求与 Key 只存在于主进程,渲染进程纯 IPC。

| 期 | 内容 | 状态 |
|----|------|------|
| **P-A** | 数据层 + 我安装的 + 批量管理(本文) | 本 spec |
| P-B | SkillHubClient + 发现页(精选/换一换/分类/搜索) | 待 spec |
| P-C | 安装引擎(市场下载 + 本地导入 zip/文件夹、YAML 校验、冲突覆盖、非高风险自动安装) | 待 spec |
| P-D | AI 辅助创建(@skill-creator) | 待 spec |
| P-E | 埋点(本地 skillStat 事件表) | 待 spec |

## 2. 决策记录

| # | 决策 | 理由 |
|---|------|------|
| 1 | 市场数据源 = SkillHub Open API;主进程代理 | 官方 API 已验证;Key 不进渲染进程/前端 bundle |
| 2 | **目录为文件事实源,DB 为状态事实源**,skill:list 时自愈对账 | 兼容"手放目录"既有习惯;存量技能零迁移自动入库 |
| 3 | P-A 仅管理**用户级** `userData/skills/`;workspace 级保持 P2 语义(始终加载、不进列表) | workspace 技能属项目文件,卸载会破坏用户仓库 |
| 4 | 卸载 = 删目录条目 + 删记录;删除失败记录保留并报错 | PRD 语义;半完成状态可重试 |
| 5 | `source` 取值 `local` / `market` / `builtin`(`suite` 值预留) | P-A 仅产生 local(手放);market 由 P-B 写入;builtin 清单当前为空,字段与 UI 标签映射就绪 |
| 6 | `X-API-Key` 走 `UPGRADE_URL` 同款占位符机制(`npm run init` 写入 Constants.ts),不硬编码进模板仓库 | 仓库是脚手架模板;Key 属敏感信息(建议上线前在 SkillHub 侧轮换) |
| 7 | 埋点推迟到 P-E 本地事件表,不追溯历史 | 平台无上报接口;下载量平台侧已有统计 |

## 3. 数据模型与迁移(v5 → v6)

```prisma
model skillRecord {
  id          Int      @id @default(autoincrement())
  name        String   @unique  // frontmatter name(与 loader 去重键一致)
  slug        String?           // SkillHub slug(市场来源技能,P-B 起写入)
  version     String?
  source      String            // "local" | "market" | "builtin"("suite" 预留)
  dir         String            // 条目目录绝对路径
  enabled     Boolean  @default(true)
  installedAt DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

- `prisma/schema.prisma` 新增模型;`electron/infrastructure/script/v6/upgrade-table.sql`
  建表(`--/ignore` 幂等语义同 v5);`electron/Constants.ts` DB_VERSION 5→6;
  升级仍走 `VersionRepository.update`(Application 启动接线不变)。
- `installedAt`:自愈首次入库时间即为"安装时间"。

## 4. 状态语义与自愈对账

### 4.1 对账算法(纯函数,单测覆盖)

```
syncSkillRecords(scanned: SkillInfo[], records: SkillRecordRow[]):
  { toInsert: InsertRow[]; toDeleteIds: number[]; kept: KeptRow[](含 dir/version 刷新) }
```

- 目录有、DB 无 → insert `{ name, source: "local", dir, enabled: true }`
- 双方都有 → 保留 enabled/installedAt,刷新 dir/version
- DB 有、目录无 → delete(卸载残留/手删目录的清理)
- keyed by `name`(与 loadSkills 去重键一致;user 级目录只传 userData/skills)

### 4.2 chat.service 联动(禁用即时生效)

`chat.service.ts` 组装处(现 L159 与工具集装配):`loadSkills` 结果经
`filterDisabled(skills)` 过滤后再进入 `buildSystemPrompt` 与
`makeReadSkillTool`。禁用技能对模型 = 不存在:system 清单无此项,
`read_skill(name)` 返回"错误: 技能不存在"。每次 send 即时查询(延续 P2
增删免重启语义)。

## 5. SkillRepository 与 IPC(同 McpRepository 模式)

```
electron/domains/ai/skill/
└── skill.repo.ts   # class SkillRepository(prismaClient 注入,可测)
                   # skill:list / setEnabled / batchSetEnabled / uninstall / batchUninstall
```

| 通道 | 参数 | 返回/行为 |
|------|------|-----------|
| `skill:list` | — | 扫描 + 对账 + 返回 `SkillRecord[]`(按 name 升序) |
| `skill:setEnabled` | `{name, enabled}` | 更新单条 |
| `skill:batchSetEnabled` | `{names[], enabled}` | 事务批量 |
| `skill:uninstall` | `{name}` | `rm -rf dir`(仅限 userData/skills 之下,路径校验防越界)→ 删记录;目录删除失败记录保留、返回错误 |
| `skill:batchUninstall` | `{names[]}` | 逐个执行,返回 `{succeeded[], failed: [{name, reason}]}` |

- 共享类型定义在 `src-react/domains/ai/skills/api/skill.api.ts`(后端 import,
  与 mcp.api 同模式)。
- `skill:openDir` 既有通道保留。

## 6. UI:技能 Tab → "我安装的"管理页

```
src-react/domains/ai/skills/
├── api/skill.api.ts            # invoke 封装 + SkillRecord 类型
├── lib/skill-filter.ts         # 本地搜索过滤(name/description 不区分大小写,单测)
├── views/SkillManagerView.tsx  # 数据(React Query ["skillRecords"]) + 批量模式状态机
└── components/SkillCard.tsx    # 单卡片(图标/名称/描述/Toggle/标签/复选框)
```

- **顶部操作条**:搜索输入框(实时本地过滤)+ 右侧"批量管理"文字按钮;
  ("添加技能"下拉、"我安装的 [n]"快捷入口、发现页视图切换留待 P-B 接入)
- **卡片网格**(grid,同助手卡片密度):图标(P-A 一律名称首字符占位;
  市场 iconUrl 渲染 P-B 接入)、名称、描述 `line-clamp-2`、右上角 Toggle
  (`enabled`)、来源标签(内置/市场/本地);批量模式下 Toggle 隐去、
  卡片左上角显示 Checkbox
- **批量操作栏**(进入批量模式后顶部替换为):已选 X 项 | 全选 | 清空 ‖
  开启 | 关闭 | 卸载 | 取消;卸载走 AlertDialog 二次确认(列出将移除的
  名称);操作完成 toast 汇总(成功数/失败数),失败项在 toast 描述列出
- **空状态**:保留"打开技能目录"引导按钮
- ExpertsView 技能 Tab 改挂 `SkillManagerView`;样式全部走主题变量;
  i18n `chat:skills.*` zh-CN/en-US 全量(含批量操作、标签、确认框文案)

## 7. 错误处理

| 场景 | 行为 |
|------|------|
| `skill:list` 对账/DB 异常 | toast 报错;列表降级为上次缓存(React Query 语义) |
| setEnabled/uninstall 单条失败 | toast `mapIpcError`(现有模式) |
| 批量部分失败 | 汇总 toast + 失败原因;成功项正常生效 |
| 卸载路径越界(非 userData/skills 前缀) | 拒绝并返回错误(防御) |

## 8. 测试

- `tests/ai/skill-sync.test.ts`:`syncSkillRecords` 新增/删除/保留/刷新/同名边界
- `tests/ai/skill-filter.test.ts`:过滤纯函数(大小写、空关键字、无命中)
- chat 联动:`filterDisabled` 过滤逻辑单测(注入 disabled 集合)
- repo IPC 层不测(electron 依赖,同 McpRepository 现状);GUI 手测清单转人工

## 9. 验收标准(DoD)

1. 手放 `userData/skills/<name>/SKILL.md` → 技能页自动出现(P-A 全部标记"本地")
2. Toggle 关闭 → 新会话 system 清单无该技能;`read_skill` 报"技能不存在";重开 App 状态保持
3. 批量:勾选 3 项 → 关闭 → 全部置灰;卸载 → 确认框列出名称 → 确认后目录与记录消失
4. 手删技能目录 → 技能页刷新后条目消失(对账清理)
5. 老库(v5)启动自动升 v6,既有数据无损
6. `npm run test` / `lint` / `typecheck` 全绿

## 10. 明确不做(YAGNI)

- 发现页/市场客户端/"+"号安装(P-B);安装引擎与导入弹窗(P-C)
- AI 辅助创建(P-D);埋点表与统计(P-E)
- "套件"标签渲染(表结构已兼容,P-C 导入元数据时启用)
- workspace 级技能的展示/启停/卸载
- 技能详情页、版本管理、更新检测
