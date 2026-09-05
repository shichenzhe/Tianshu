# AI 辅助创建 P-D 实施计划(skill-creator + create_skill)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 内置 skill-creator 技能 + create_skill 写类工具(审批落盘),对话即可创建技能。

**Architecture:** 复用最大化:审批横幅(P1 kind:write)、skill-archive 校验、skillRecord upsert、system 清单注入;无新 UI。

**Tech Stack:** 既有栈;新增仅 SKILL.md 资源文件与一个工具模块。

**Spec:** `docs/superpowers/specs/2026-09-05-skill-pd-creator-design.md`

## Global Constraints

同前三期(i18n/主题变量/Prettier/全量验证后 commit);工具模块纯 Node 可测(禁 import electron,资源路径由调用方注入);错误回喂为中文错误串(同 read_skill 模式)。

---

### Task 1: 内置技能资源 + ensureBuiltinSkills(TDD)

**Files:**
- Create: `electron/resources/builtin-skills/skill-creator/SKILL.md`
- Create: `electron/domains/ai/skill/builtin-skills.ts`
- Modify: `vite.config.ts`(syncElectronAssets 复制 builtin-skills → dist-electron)
- Modify: `electron/domains/ai/skill/skill.repo.ts`(ensureBuiltinSkills 方法)
- Modify: `electron/Application.ts`(启动 fire-and-forget 接线)
- Test: `tests/ai/builtin-skills.test.ts`

**Interfaces:**
- Produces(Task 2/后续消费):`ensureBuiltinSkills(deps: { builtinRoot: string; skillsRoot: string; prisma: SkillRecordPrismaLike }): Promise<void>`(纯 Node:技能缺失时 `cpSync` 目录 + upsert `{name:"skill-creator", source:"builtin", dir, description 取自 frontmatter}`;存在跳过;**内置技能被禁用时也不跳过重装判定 —— 判定仅看目录是否存在**)

- [ ] **Step 1: SKILL.md 资源**(内容按 spec §2 要点编写;frontmatter `name: skill-creator`、description 引导模型在用户想创建技能时读取本技能;正文:①澄清需求清单 ②SKILL.md 规范(name kebab-case/一句话 description/正文结构:何时使用/步骤/示例) ③附属文件克制原则 ④调用 create_skill(name/description/files 含 SKILL.md) ⑤告知用户技能页可管理)
- [ ] **Step 2: 失败测试**:缺失安装(临时目录:builtinRoot 有资源、skillsRoot 空 → 调用后 skills/skill-creator/SKILL.md 存在 + upsert 被调 source builtin);存在跳过(预放同名目录 → cpSync 与 upsert 均不发生);disabled 记录 + 目录在 → 跳过重装
- [ ] **Step 3: 红 → 实现 builtin-skills.ts**(纯 Node:cpSync recursive;upsert where name;描述经 parseFrontmatter 读资源 SKILL.md)
- [ ] **Step 4: repo 方法 + 接线**:`SkillRepository.ensureBuiltinSkills()`:`builtinRoot = app.isPackaged ? path.join(app.getAppPath(), "builtin-skills") : path.join(__dirname, "../../resources/builtin-skills")`(以项目实际 dist 结构校准,typecheck+dev 启动可验证为准;vite.config.ts 的 syncElectronAssets 加 tryCopySync 同 script 模式);Application registerServices 里 `void skillRepo.ensureBuiltinSkills().catch(...)`(Log)
- [ ] **Step 5: 绿 + 全量 → Commit** `feat(skill): 内置 skill-creator 技能与启动自愈安装`

---

### Task 2: create_skill 工具(TDD)

**Files:**
- Create: `electron/domains/ai/agent/create-skill.ts`
- Modify: `electron/domains/ai/chat/chat.service.ts`(collectToolDefinitions 注入)
- Test: `tests/ai/create-skill.test.ts`

**Interfaces:**
- Consumes: `validateSkillMd`(skill-archive)、`isSafeDirName`/SkillRecordPrismaLike(skill-installer)
- Produces:

```ts
export function validateCreateSkillParams(args: unknown):
  | { ok: true; name: string; description: string; files: Array<{ path: string; content: string }> }
  | { ok: false; reason: string };
export function makeCreateSkillTool(deps: { skillsRoot: string; prisma: SkillRecordPrismaLike }):
  ToolDefinition<{ name: string; description: string; files: Array<{ path: string; content: string }> }>;
// 注册名 "create_skill";kind: "write";description 指导模型按 skill-creator 技能规范调用
```

- [ ] **Step 1: 失败测试**:校验纯函数 —— name `^[a-z0-9][a-z0-9-]*$`、files 必含 SKILL.md 且 validateSkillMd 通过、path 禁 `..`/绝对路径、条目 ≤20、单文件 ≤256KB、总 ≤1MB;工具执行(临时目录)—— 成功落盘+upsert(source local)+返回"已创建技能 <name>…";同名目录已存在 → 返回"错误: 技能已存在,请先在技能页卸载后重试"(不落盘);坏参数 → 错误串回喂
- [ ] **Step 2: 红 → 实现**(zod schema:z.object({name, description: z.string().min(1).max(200), files: z.array(z.object({path, content}))});execute 先 validateCreateSkillParams 再 fs 写 `path.join(skillsRoot, name, file.path)`(逐条 isSafeDirName/path 归一复核)再 upsert;写盘失败清理半成品目录)
- [ ] **Step 3: chat.service 注入**:`collectToolDefinitions` 返回数组头部与 makeReadSkillTool 并列:`makeCreateSkillTool({ skillsRoot: this.skillsRoot(), prisma: ... })` —— chat.service 无 prisma/skillsRoot?**接入点决策**:SkillRepository 已有 skillsRoot 与 prismaClient;在 Application 装配处把 `skillRepo` 传入 ChatService?P-A 已传 skillRepo(SkillDisabledLookup 最小接口)。**最小侵入**:ChatService 构造可选参数扩为 `{ getDisabledNames(); ensureCreateSkillTool?(): ToolDefinition }` 过度 —— **定案:create-skill 工具的 deps 由 SkillRepository 构造时静态注册到 tool-registry**(registry.registerTools 聚合点,P1 既有):SkillRepository 构造内 `registry.registerTools([makeCreateSkillTool({...})])`,chat.service 的 registered 集合自动含之(collectToolDefinitions 里 mcp__ 之外的 registered 已透传 —— 核实注入条件:`agent.workspacePath ? registered : registered.filter(mcp__)` → 未绑定目录时 create_skill 会被过滤!**需调整**:过滤条件改为 `def.name.startsWith("mcp__") || def.name === "create_skill" || def.name === "read_skill"`(read_skill 本就在数组外常驻)—— 以 chat.service 实际代码为准做等价调整,保持文件四件仍依赖 workspacePath)
- [ ] **Step 4: 绿 + 全量 → Commit** `feat(skill): create_skill 写类工具(审批落盘+校验)`

---

### Task 3: 全量验证 + DoD 手测

- [ ] 全量三连;手测清单(spec §5):对话创建 morse 技能全链路 / 坏输入错误串 / 同名冲突提示 / 卸载 skill-creator 重启恢复 / 拒绝审批回喂
