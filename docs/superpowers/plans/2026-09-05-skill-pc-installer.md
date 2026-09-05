# 安装引擎 P-C 实施计划(市场下载 + 本地导入)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** zip/目录安装引擎(校验/冲突覆盖/落盘/入库)+ 市场"+"接通 + 导入技能弹窗。

**Architecture:** 纯函数校验层(skill-archive,TDD)+ 主进程编排(skill-installer,adm-zip)+ SkillRepository IPC 扩展 + 前端安装态与导入弹窗。conflict 为返回值非异常(覆盖确认是正常流)。

**Tech Stack:** adm-zip(新依赖)、Electron dialog、React Query、Vitest。

**Spec:** `docs/superpowers/specs/2026-09-05-skill-pc-installer-design.md`

## Global Constraints

- 同 P-B(i18n 双语/主题变量/Prettier 双引号分号 tabWidth=2/每任务全量验证后 commit)
- adm-zip 通过 `npm i adm-zip` 安装(dependencies);**zip 条目必须先过 validateArchiveEntries 再解压落盘**(zip-slip 防御不可绕过)
- InstallResult:`{status:"installed"; record: SkillRecord} | {status:"conflict"; name: string}`;校验/危险条目错误走 throw(中文 reason 直接可展示)

---

### Task 1: skill-archive 纯函数(TDD)

**Files:**
- Create: `electron/domains/ai/skill/skill-archive.ts`
- Test: `tests/ai/skill-archive.test.ts`

**Interfaces:**
- Consumes: `parseFrontmatter`(`../agent/skill-loader` 导出)
- Produces(Task 2 消费):

```ts
export type ArchiveCheck = { ok: true } | { ok: false; reason: string };
export function validateArchiveEntries(entries: string[], opts?: { maxFileBytes?: number; maxTotalBytes?: number; maxCount?: number }): ArchiveCheck;
export function locateSkillRoot(entries: string[]): { ok: true; root: string } | ArchiveCheck;
export function validateSkillMd(raw: string): { ok: true; name: string; description: string } | ArchiveCheck;
// 默认上限:单文件 10MB、总 50MB、500 条(entries 仅路径时大小检查由调用方在解压后按实际字节数再验一次,此函数校验路径与数量)
```

- [ ] **Step 1: 失败测试**(用例覆盖:zip-slip `../a`、绝对路径 `/etc/x`、`a/../../b`;可执行拒绝 `.sh/.exe/.dll/.bat/.command/.app`(含 `x.exe` 与目录 `dir.exe/`?目录不算 —— 以文件扩展判定);超条目数 501;合法清单通过;locateSkillRoot:根 SKILL.md、唯一子目录 `pkg/SKILL.md`、无、两个子目录都有 → 错误;validateSkillMd:合法/缺 name/缺 description/无 frontmatter)
- [ ] **Step 2: 红** → **Step 3: 实现**:

```ts
/** zip 条目安全校验与技能包结构定位(纯函数,TDD;spec §2.1) */
import path from "node:path";
import { parseFrontmatter } from "../agent/skill-loader";

const DANGEROUS_EXT = new Set([".exe", ".dll", ".sh", ".bat", ".command", ".app", ".msi", ".scr"]);
const DEFAULTS = { maxFileBytes: 10 * 1024 * 1024, maxTotalBytes: 50 * 1024 * 1024, maxCount: 500 };

export type ArchiveCheck = { ok: true } | { ok: false; reason: string };

export function validateArchiveEntries(
  entries: string[],
  opts: Partial<typeof DEFAULTS> = {},
): ArchiveCheck {
  const { maxCount } = { ...DEFAULTS, ...opts };
  if (entries.length === 0) {
    return { ok: false, reason: "压缩包为空" };
  }
  if (entries.length > maxCount) {
    return { ok: false, reason: `条目数超过上限(${maxCount})` };
  }
  for (const entry of entries) {
    const normalized = path.posix.normalize(entry.replace(/\\/g, "/"));
    if (path.posix.isAbsolute(normalized) || normalized.startsWith("../") || normalized.includes("/../")) {
      return { ok: false, reason: `存在不安全路径:${entry}` };
    }
    if (DANGEROUS_EXT.has(path.posix.extname(normalized).toLowerCase())) {
      return { ok: false, reason: `不允许的可执行文件:${entry}` };
    }
  }
  return { ok: true };
}

export function locateSkillRoot(entries: string[]): { ok: true; root: string } | ArchiveCheck {
  const normalized = entries.map((e) => e.replace(/\\/g, "/"));
  const hasSkillMd = (prefix: string) => normalized.some((e) => e === `${prefix}SKILL.md`);
  if (hasSkillMd("")) {
    return { ok: true, root: "" };
  }
  const topDirs = new Set(
    normalized.filter((e) => e.includes("/")).map((e) => e.slice(0, e.indexOf("/"))),
  );
  if (topDirs.size === 1) {
    const only = [...topDirs][0]!;
    if (hasSkillMd(`${only}/`)) {
      return { ok: true, root: only };
    }
    return { ok: false, reason: "未找到 SKILL.md(须位于压缩包根或其唯一一级子目录)" };
  }
  return { ok: false, reason: "未找到 SKILL.md(压缩包含多个顶层目录)" };
}

export function validateSkillMd(raw: string): { ok: true; name: string; description: string } | ArchiveCheck {
  const { name, description } = parseFrontmatter(raw);
  if (!name) return { ok: false, reason: "SKILL.md 元数据缺少 name" };
  if (!description) return { ok: false, reason: "SKILL.md 元数据缺少 description" };
  return { ok: true, name, description };
}
```

(测试按此实现校准:多顶层目录但只有唯一子目录含 SKILL.md 的 case —— 本实现判"多个顶层目录"即拒绝,测试按此语义断言;spec §2.1 描述同义。)
- [ ] **Step 4: 绿**;全量验证 → **Step 5: Commit** `feat(skill): 安装包安全校验与技能根定位纯函数`

---

### Task 2: skill-installer 编排(TDD,临时目录)

**Files:**
- Create: `electron/domains/ai/skill/skill-installer.ts`
- Test: `tests/ai/skill-installer.test.ts`

**Interfaces:**
- Consumes: Task 1 三函数;`loadSkills`(对账复用);prisma skillRecord;`syncSkillRecords`(沿用 P-A 对账或直接 upsert)
- Produces(Task 3 消费):

```ts
export type InstallResult =
  | { status: "installed"; record: { id: number; name: string; source: string; slug: string | null; version: string | null } }
  | { status: "conflict"; name: string };

export class SkillInstaller {
  constructor(deps: {
    skillsRoot: string;                       // 注入目录(测试用 tmp)
    prisma: SkillRecordPrismaLike;            // { findFirst(args), upsert(args), delete(args) } 结构子集
    fetchImpl?: typeof fetch;                  // downloadZip 用(测试 fake)
  });
  installFromBuffer(buf: Buffer, source: "market" | "local", meta?: { slug?: string; version?: string }, overwrite?: boolean): Promise<InstallResult>;
  importDirectory(dir: string, overwrite?: boolean): Promise<InstallResult>;
  async downloadAndInstall(slug: string, overwrite?: boolean): Promise<InstallResult>;  // fetch 详情取 version + downloadZip
}
```

- [ ] **Step 1: 失败测试**(adm-zip 构造 zip 到 Buffer;`mkdtempSync` 建 skillsRoot;prisma 用内存 Map stub 实现三方法):
  1. 新装:zip 根含 SKILL.md → status installed;skillsRoot 下出现 `<name>/SKILL.md`;upsert 被调(source local)
  2. 单层子目录 zip(`pkg/SKILL.md`)→ 装到 `<name>/`(子目录内容平移)
  3. 冲突:预先建同名目录 → status conflict、原目录内容未动、无第二条 upsert
  4. overwrite=true → 旧文件被替换(旧 extra.txt 消失、新 SKILL.md 就位)、prisma upsert 更新 version
  5. 坏包:无 SKILL.md → throw("未找到 SKILL.md");含 `evil.sh` → throw("不允许的可执行文件")
  6. importDirectory:临时源目录(含 SKILL.md + scripts/)→ 复制安装;源目录仍在(不 move)
  7. downloadAndInstall:fetchImpl fake —— 第一次 `/api/v1/skills/{slug}` 返回 `{skill:{...}, latestVersion:{version:"1.0.2"}}`,download 请求返回 zip Buffer → installed 且 version=1.0.2、slug 落库
- [ ] **Step 2: 红** → **Step 3: 实现**(关键点:adm-zip `getEntries()` 取 entryName 列表先 validate;`getData()` 解压到内存再 fs 写(单文件 ≤10MB 安全);staging 目录 `.staging-<Date.now()>` 中转后 `cpSync` 到目标;overwrite 先 `rmSync(dir, {recursive:true, force:true})`;解压后按实际字节复验单文件/总量上限;skillsRoot 用 `isInsideDir` 复核(P-A skill-sync)防目标逃逸;upsert where name unique)
- [ ] **Step 4: 绿**;全量 → **Step 5: Commit** `feat(skill): 安装编排(解压/校验/冲突覆盖/入库)`
- [ ] **Step 6: `npm i adm-zip`**(若未在 Step 3 装;commit 含 package.json/lock)

---

### Task 3: SkillHubClient.downloadZip + IPC + 前端 api

**Files:**
- Modify: `electron/domains/ai/skill/skillhub-client.ts`(downloadZip + getDetail)
- Modify: `electron/domains/ai/skill/skill.repo.ts`(installer 实例化 + 3 通道)
- Modify: `src-react/lib/ipc.ts`(+3:skillhub:install / skill:import / skill:pickImport)
- Modify/Create: `src-react/domains/ai/skills/api/`(skillhub.api.ts 加 install;skill.api.ts 加 import/pickImport;类型 InstallResult 独立声明)

**Interfaces:**
- `SkillHubClient.getDetail(slug): Promise<{ skill: { slug: string; version?: string }; latestVersion: { version: string } }>`(裸对象 `/api/v1/skills/{slug}`,只声明消费字段)
- `SkillHubClient.downloadZip(slug): Promise<ArrayBuffer>`(GET `/api/v1/download?slug=`,fetch 自动跟随 302;非 2xx throw `{error}`)
- `SkillInstaller.inspectFromPath(path): Promise<{ status: "ok"; name: string; description: string } | { status: "conflict"; name: string }>`(**Task 2 一并实现并测试**:dryRun 校验 —— 解压/校验/冲突检测,不落盘不写库;Task 5 导入弹窗消费)
- IPC:`skillhub:install {slug, overwrite?} → InstallResult`;`skill:import {path, overwrite?, dryRun?} → InstallResult | InspectResult`(dryRun 时返回 inspect 结果);`skill:pickImport → {canceled: true} | {canceled: false, path}`(dialog.showOpenDialog properties:["openFile","openDirectory"],filters zip)
- SkillRepository 构造 `new SkillInstaller({ skillsRoot: path.join(app.getPath("userData"), "skills"), prisma: this.prismaClient })`(fetchImpl 默认)
- 前端类型 `InspectResult` 与 `InstallResult` 在 `src-react/domains/ai/skills/api/skillhub-types.ts` 独立声明

- [ ] Steps:Task 2 补 inspect 测试(zip/目录两形态:ok 返回 name/description、conflict 返回、坏包 throw)→ client 测试补 downloadZip/getDetail(fake fetch 返回 200 zip body,断言 URL 含 `/api/v1/download?slug=`)→ repo 通道(dryRun 透传)→ 前端 api/类型/IPCChannel → 全量 → Commit `feat(skill): 安装 IPC 三通道与市场下载`

---

### Task 4: 发现页"+"接通 + 安装态

**Files:**
- Modify: `src-react/domains/ai/skills/components/SkillHubCard.tsx`
- Modify: `src-react/domains/ai/skills/views/SkillDiscoverView.tsx`、`SkillsView.tsx`
- i18n:zh/en chat.json skills 子树追加(install/installing/installed/conflictTitle/conflictDesc/overwrite/installedBadge 等)

**Interfaces:**
- `SkillHubCard({ skill, installed, onInstall })`:`installed` 布尔(slug 已在记录中)→ Check 灰态;否则 `+`/spinner(本地 `installing` state)/点击 `onInstall(skill)`
- SkillDiscoverView:持有 installingSlug state;`handleInstall = async (skill) => { setInstalling(slug); try { const r = await SkillHubApi.install({slug}); if (r.status==="conflict") { setConflictSkill(skill); return; } toast.success(t installed); await queryClient.invalidateQueries(["skillRecords"]); } catch(e){ toast.error(mapIpcError(e)); } finally { setInstalling(null); } }`;冲突 AlertDialog(确认 → install({slug, overwrite:true}))
- installedSlugs:`SkillsView` 从 `["skillRecords"]` 缓存派生 `new Set(records.map(r=>r.slug).filter(Boolean))` 传下(DiscoverView 与 Card)
- i18n zh:`"install": "安装", "installing": "安装中…", "installedBadge": "已安装", "conflictTitle": "技能已存在", "conflictDesc": "{{name}} 已安装,覆盖安装将替换其文件(启用状态保留)。", "overwrite": "覆盖安装", "installSuccess": "已安装 {{name}}"`;en 对应

- [ ] Steps:i18n → Card 改造 → DiscoverView 安装流 → SkillsView 派生传递 → 全量 → Commit `feat(skill): 发现页+号安装接通(安装中/已安装/冲突覆盖)`

---

### Task 5: 导入技能弹窗 + 添加下拉接线 + 全量验证

**Files:**
- Create: `src-react/domains/ai/skills/components/SkillImportDialog.tsx`
- Modify: `src-react/domains/ai/skills/views/SkillDiscoverView.tsx`(添加下拉"上传技能"开弹窗;"创建技能"仍 toast)
- i18n 追加(importTitle/importTip/importDrop/importBrowse/autoInstall/requirement 文案/installConfirm 等)
- 验证:全量 + 手测清单(spec §7 DoD)

**Interfaces:**
- Dialog(open/onOpenChange);流程(定案,消费 Task 2/3 的 inspectFromPath 与 dryRun):
  1. 选择文件(`skill:pickImport`)或拖拽(drop 事件 `e.dataTransfer.files[0].path`)→ 得 path
  2. `skill:import {path, dryRun: true}` → throw → 红字 reason;`status:"conflict"` → 覆盖确认 AlertDialog(确认 → `skill:import {path, overwrite:true}`);`status:"ok"` → 显示摘要(名称/描述)
  3. 摘要态:勾选「非高风险自动安装」→ 直接 `skill:import {path}`;未勾 → 用户点「安装」按钮再装
  4. 成功:toast + 关闭 + invalidate `["skillRecords"]`
- i18n zh 追加:`"importTitle": "导入技能", "importDrop": "拖拽 zip 压缩包或文件夹到此处,或点击选择", "autoInstall": "非高风险自动安装", "requirement": "要求:必须包含 SKILL.md,且头部 YAML 含 name 与 description", "install": "安装", "importFailed": "导入失败"`,conflict 复用 Task 4;en 对应

- [ ] Steps:i18n → Dialog 组件 → DiscoverView 添加下拉「上传技能」接开弹窗(「创建技能」仍 toast)→ 全量 + DoD 手测清单(spec §7)→ Commit `feat(skill): 导入技能弹窗(选择/拖拽/校验红字/覆盖确认)`

---

### Task 6(收尾): 全量验证 + DoD 手测清单交用户

(同 P-B T5 形态:全量三连 + grep Key + 手测清单)
