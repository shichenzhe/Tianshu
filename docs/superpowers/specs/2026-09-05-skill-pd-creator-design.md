# P-D AI 辅助创建(skill-creator)设计

> 上游:PRD §3.3.3;前置 P-A/B/C 已合并。本期为全计划最小一期,核心策略
> 是**最大化复用**:审批 UI(P1)、安装落盘(P-C skill-installer 校验语义)、
> system 技能清单注入(P2)。

## 1. 范围与策略

| 做 | 不做(YAGNI) |
|----|------|
| 内置 skill-creator 技能(SKILL.md 指导模型生成技能) | 输入框 @ 语法解析(PRD"或直接输入指令触发"已满足;@ 提及留后续) |
| `create_skill` 内置工具(模型生成的落盘通道,**kind: write 走既有审批横幅**) | 独立"AI 创建"向导 UI(对话流即向导) |
| 启动时内置技能自愈安装(缺则从 app 资源复制) | 生成内容的人工编辑器(生成后用户可在技能目录手改) |
| 生成技能即时进入 system 清单(下一次对话可用) | 生成结果的"下载"选项(本地应用无下载语义,直接安装) |

**链路**:用户说"帮我创建一个能 X 的技能" → system 清单含 skill-creator →
模型 `read_skill("skill-creator")` 获取创作指引 → 问答澄清需求 → 模型调
`create_skill({name, description, files})` → **审批横幅(写类工具)** →
主进程校验+落盘 `userData/skills/<name>/` → upsert skillRecord(source:
local)→ 工具卡显示成功 → "我安装的"立即出现(对账)。

## 2. 内置技能资源与自愈安装

- `electron/resources/builtin-skills/skill-creator/SKILL.md`(随源码提交)
- 构建:`vite.config.ts` 的 `syncElectronAssets()` 增加复制
  `electron/resources/builtin-skills` → `dist-electron/builtin-skills`(与
  script/docs 同模式);dev 模式读源路径,生产读 `process.resourcesPath`/
  `app.getAppPath()` 下的 builtin-skills(启动时解析,参照现有 Prisma
  script 目录的定位方式)
- `skill.repo.ts` 新增 `ensureBuiltinSkills()`:skill-creator 不存在于
  userData/skills 时复制安装(source 标 "builtin" 直接 upsert);Application
  启动接线(fire-and-forget,失败仅日志)。重复启动幂等(存在即跳过);
  用户卸载内置技能后重启会重装 —— **决策:卸载即隐藏(不重装)**:
  ensure 记录"已卸载内置"跳过重装?过度设计 —— **定案:重装(内置技能
  卸载后重启恢复)**,符合"内置"语义,PRD 卡片也有"内置"标签卸载语义未定义。

### skill-creator SKILL.md(核心资产,内容要点)

frontmatter:`name: skill-creator` / `description: 指导创建自定义技能:
当用户想创建/生成一个技能(skill)时,先读本技能获取规范与流程`。
正文指导模型:①先澄清需求(用途/触发场景/操作步骤/注意事项);
②SKILL.md 规范(kebab-case name、一句话 description、正文=何时使用/步骤/
示例);③附属文件克制(仅在必要时,脚本须说明运行方式与依赖);
④调用 `create_skill` 保存(files 含 SKILL.md 必选);⑤成功后告知用户
在「我安装的」可管理、对话即可使用。

## 3. create_skill 内置工具

`electron/domains/ai/agent/create-skill.ts`(模式同 read-skill.ts):

```ts
makeCreateSkillTool(deps: { skillsRoot: string; prisma: SkillRecordPrismaLike })
// 注册名 "create_skill";kind: "write"(自动进审批横幅,argSummary = name + N 个文件)
// parameters(zod): { name: string(kebab-case 校验 ^[a-z0-9][a-z0-9-]*$),
//   description: string(1..200), files: [{path, content}] }
//   files 须含 SKILL.md;path 相对技能目录,禁止 .. 与绝对路径;条目 ≤20、单文件 ≤256KB、总 ≤1MB
// 执行:复用 skill-archive 的 validateSkillMd 语义(校验 files 中的 SKILL.md 内容)
//   + skill-installer 的 isSafeDirName;目录已存在 → 返回错误串提示覆盖需先卸载(不做静默覆盖)
//   成功 → 写盘 + upsert(source "local")→ 返回 "已创建技能 <name>,可在技能页管理"
```

- 注册:chat.service `collectToolDefinitions` 的 registered 集合(registry
  `registerTools` 聚合点,P1)—— **同 read_skill 的常驻注入**;不依赖
  workspacePath。
- 校验纯函数(`validateCreateSkillParams`)抽出可测;zod schema 对齐既有工具定义模式。

## 4. 测试

- `tests/ai/create-skill.test.ts`:参数校验纯函数(name 格式/文件白名单路径/
  SKILL.md 必含且内容合法/上限)+ 工具执行(临时目录:成功落盘+upsert、
  同名冲突错误串、坏 path 拒绝)
- `tests/ai/builtin-skills.test.ts`:ensureBuiltinSkills(缺失安装/存在跳过/
  卸载后重装)
- skill-creator SKILL.md 资源存在性由构建复制保障(手测)

## 5. DoD

1. 新会话说「帮我创建一个能把文本转 morse 码的技能」→ 模型澄清 → create_skill 审批横幅 → 允许 → 技能页出现(标"本地"),system 清单即时含它
2. 坏输入(非法 name/无 SKILL.md/路径逃逸)→ 工具返回错误串回喂模型,不落盘
3. 同名重建 → 提示先卸载;卸载 skill-creator → 重启恢复(内置)
4. 拒绝审批 → 模型收到拒绝回喂,继续对话
5. test/lint/typecheck 全绿

## 6. 决策记录

| # | 决策 | 理由 |
|---|------|------|
| 1 | 复用审批横幅(create_skill kind:write) | P1 写类审批 UI 全套现成,PRD"生成 → 安装"的信任边界天然成立 |
| 2 | 不做 @ 语法解析 | PRD"或直接输入指令"满足;@ 提及涉及 ChatInput 改造,收益低 |
| 3 | 内置技能卸载后重启重装 | "内置"语义;避免"已卸载"额外状态 |
| 4 | 同名冲突不静默覆盖 | 模型生成场景静默覆盖用户技能风险高;提示卸载后重建 |
| 5 | 无独立向导 UI | 对话流即向导(工具卡+审批+技能页三处呈现) |
