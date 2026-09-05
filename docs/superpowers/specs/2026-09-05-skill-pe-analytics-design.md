# P-E 技能埋点(skillStat 事件表)设计与计划

> 上游:PRD §数据埋点;P-A spec 决策 7(本地表,不追溯历史,平台无上报接口)。
> 本期最小:事件采集落库 + 聚合查询 IPC;**不做展示 UI**(PRD 未定义形态,YAGNI)。
> 最后一期,P-A~P-D 已全部合并。

## 1. 数据模型(v6 → v7)

```prisma
model skillStat {
  id        Int      @id @default(autoincrement())
  name      String   // 技能名
  event     String   // install | enable | disable | uninstall | batch_enable | batch_disable | batch_uninstall | create
  createdAt DateTime @default(now())
}
```

- `electron/infrastructure/script/v7/upgrade-table.sql`(IF NOT EXISTS 同 v6 模式);Constants DATABASE_VERSION 6→7;CLAUDE.md 版本号同步。
- 批量操作逐选中技能记一条 `batch_*` 事件:每技能活跃度与批量使用率(count(batch_*)>0)一表两得。
- `create` 事件:create_skill 工具成功(区分 AI 创建与市场/本地安装)。

## 2. 采集与查询

- `electron/domains/ai/skill/skill-stats.ts`:`recordSkillEvent(prisma, name, event)`(**swallow 错误**:catch + Log.warn,埋点失败绝不影响主流程);`aggregateSkillStats(rows)`(纯函数:事件行 → 按技能聚合 `{name, installs, creates, enables, disables, uninstalls, batchOps, lastActiveAt}`,TDD)。
- 写入点(全部 fire-and-forget,不 await 主流程):
  - `skill-installer.installFromBuffer` 成功尾部:source==="market" ? "install" : "install"(事件同为 install,source 信息在 skillRecord 已有;不重复建模)
  - `skill.repo.setEnabled/batchSetEnabled/uninstall/batchUninstall`:enable/disable/uninstall/batch_*
  - `create-skill.ts` execute 成功尾部:create
- IPC:`skill:stats` → `{ items: AggregateItem[] }`(name 升序;直接 prisma findMany 全量行 → 纯函数聚合,量级本地可忽略)+ 前端 `SkillApi.stats()`(暂无 UI 消费,api 备好)。

## 3. 任务

- **T1**:v7 迁移 + 模型 + 迁移测试 + CLAUDE.md 版本号(同 P-A T1 模式)
- **T2**:skill-stats(recorder + aggregate TDD)+ 五个写入点接线 + skill:stats IPC + 前端 api + IPCChannel
- **T3**:全量验证 + 全分支终审 + 合并

## 4. DoD

1. 安装/开关/卸载/批量/AI 创建各动作后 skillStat 出现对应行(查库或 skill:stats)
2. 埋点写入失败(如表锁)不影响任何主流程(测试:prisma stub 抛错 → 主操作仍成功)
3. skill:stats 聚合数字正确(纯函数测试)
4. 老库升 v7 无损;test/lint/typecheck 全绿

## 5. 决策记录

| # | 决策 | 理由 |
|---|------|------|
| 1 | 事件表而非计数列 | 频率/时序/僵尸识别(lastActiveAt)都要事件流;计数列算不出活跃度 |
| 2 | 不做展示 UI | PRD 只提采集口径;查看形态未定义,api 层备好即可 |
| 3 | swallow 错误 | 埋点属可观测性,反客为主不可接受 |
| 4 | 全量行内存聚合 | 本地单机事件量级(千级)无关性能 |
