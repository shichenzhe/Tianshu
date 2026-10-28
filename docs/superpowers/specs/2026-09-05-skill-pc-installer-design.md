# P-C 安装引擎(市场下载 + 本地导入)设计

> 上游:PRD §3.3.1/§3.3.2、§3.1.1"+"号安装、§4 异常处理;宏观决策见 P-A spec。
> 前置:P-A(skillRecord/SkillRepository/管理页)、P-B(SkillHubClient/发现页)已合并。

## 1. 范围

| 做 | 不做(YAGNI) |
|----|------|
| zip 解压安装(市场下载 + 本地导入共用引擎) | sha256 逐文件校验(https 传输,平台侧已校验来源;需要时后续) |
| SKILL.md/元数据校验 + 红字错误 | 技能版本管理/更新检测(P-E 后) |
| 冲突检测 →「覆盖安装/取消」 | 市场"套件"标签(无数据来源) |
| 导入弹窗(点击选择 + 拖拽,非高风险自动安装勾选) | "高风险"分级标签 UI(判定内化为 requires_api_key/付费) |
| 发现页"+"接通(安装中/已安装态) | AI 辅助创建(P-D) |

## 2. 安装引擎(主进程)

```
electron/domains/ai/skill/
├── skill-archive.ts   # 纯函数:zip 条目安全校验 + 技能根定位 + frontmatter 校验(TDD)
└── skill-installer.ts # fs/网络编排:download(slug) / importFromPath(path) / install()
```

### 2.1 skill-archive.ts(纯函数,单测)

```ts
/** zip-slip 防御 + 白名单:条目路径规范化后必须仍在 targetDir 内;拒绝绝对路径/..;
 *  白名单扩展:常规文本/代码/图片等,拒绝可执行(.exe/.dll/.sh/.bat/.command/.app)与超限条目(单文件>10MB、总>50MB、条目数>500) */
export function validateArchiveEntries(entries: string[]): { ok: true } | { ok: false; reason: string };
/** 技能根定位:zip 根含 SKILL.md → 根;唯一子目录含 SKILL.md → 该子目录;否则错误 */
export function locateSkillRoot(entries: string[]): { ok: true; root: string } | { ok: false; reason: string };
/** frontmatter 校验:parseFrontmatter 复用 skill-loader;缺 name/description → 错误 */
export function validateSkillMd(raw: string): { ok: true; name: string; description: string } | { ok: false; reason: string };
```

### 2.2 skill-installer.ts(编排,fs/网络)

- `installFromBuffer(buf, source: "market" | "local", meta?): InstallResult`
  adm-zip 解压 → validateArchiveEntries → locateSkillRoot → 读 SKILL.md 校验 →
  冲突检测(skillRecord name 或 dir 已存在)→ **返回 `{ status: "conflict", existing }` 不落盘** →
  确认后 `overwrite: true` 删旧目录 → 写入 `userData/skills/<name>/` → upsert skillRecord
  `{ name, source, slug?, version? }`(enabled 默认 true,已存在保留 enabled)→ 对账语义不变
- `downloadAndInstall(slug)`:SkillHubClient 下载(新增 `downloadZip(slug): Promise<{buf, version}>`,
  fetch 跟随 302 自动,10s×3 重试同 client 策略;version 取详情 latestVersion —— 简化:download
  响应 Content-Disposition 或再查详情?**定案:安装前 `GET /api/v1/skills/{slug}` 取 version 一次**)→ installFromBuffer(source market)
- `importFromPath(path)`:`.zip` 读文件;目录 → 校验目录内 SKILL.md 后整目录复制(复用校验函数,不打包中转)
- 临时解压:`userData/skills/.staging-<ts>/`,完成或失败后清理

## 3. IPC(SkillRepository 扩展)

| 通道 | 参数 | 返回 |
|------|------|------|
| `skillhub:install` | `{slug, overwrite?}` | `InstallResult`(conflict 时前端再确认重发 overwrite) |
| `skill:import` | `{path, overwrite?}` | `InstallResult` |
| `skill:pickImport` | — | 主进程 `dialog.showOpenDialog`(zip 或目录)→ `{canceled} \| {path}`;拖拽入口直接走 `skill:import`(渲染层 drop 事件取 `file.path`) |

`InstallResult = { status: "installed"; record: SkillRecord } | { status: "conflict"; name: string }`,
错误走异常(mapIpcError 展示,reason 即红字文案来源:SKILL.md 缺失/元数据不全/zip 危险条目/超限)。

## 4. UI

### 4.1 发现页"+"接通(SkillHubCard)

- 未安装:`+`(点击 → spinner(按钮内 Loader2)→ installed toast + invalidate `["skillRecords"]`)
- 冲突:AlertDialog「<name> 已存在,覆盖安装?」确认重发 overwrite
- 已安装(slug 在 skillRecords 中):按钮变 `Check` 灰态不可点;禁用安装态(`enabled:false` 记录)同样视为已安装
- SkillDiscoverView 传入 installedSlugs(由 SkillsView 的 skillRecords 缓存派生,含 slug 的记录)

### 4.2 导入技能弹窗(SkillImportDialog,添加下拉「上传技能」唤起)

- **文件区**:虚线框;点击 → `skill:pickImport`;拖拽(drop 事件,`e.dataTransfer.files[0].path`,zip/目录均可);选中后显示文件名 + 校验结果
- **校验错误**:调 `skill:import`(overwrite:false 试装)→ conflict 弹确认;异常(校验失败)红字显示 reason
- **高级选项**:「非高风险自动安装」勾选框 —— 不勾:导入前弹内容摘要确认(名称/描述/来源,确认按钮「安装」);勾选:直接安装
- **要求说明**(静态文案):必须包含 SKILL.md;头部 YAML 需含 name/description
- 成功:toast + 关闭 + invalidate

## 5. 错误处理(PRD §4 对齐)

| 场景 | 行为 |
|------|------|
| 缺 SKILL.md / YAML 缺字段 | 导入弹窗红字具体原因 |
| 市场下载失败(网络/5xx) | toast mapIpcError;卡片 spinner 复位 |
| 冲突 | 覆盖确认(市场卡片与导入弹窗同款 AlertDialog) |
| zip 危险条目/超限 | 异常 reason 红字/ toast |

## 6. 测试

- `tests/ai/skill-archive.test.ts`:validateArchiveEntries(zip-slip/绝对路径/..、可执行拒绝、大小/条目数上限)、locateSkillRoot(根/单子目录/无/多子目录)、validateSkillMd(合法/缺 name/缺 description/无 frontmatter)
- `tests/ai/skill-installer.test.ts`:installFromBuffer 用临时目录(纯 Node fs + adm-zip 构造 zip)—— 新装/冲突返回/overwrite 替换/enabled 保留/prisma 用内存 fake(结构对齐 P-A repo 测试现状:注入 prismaClient stub)
- UI:lint/typecheck + 手测清单

## 7. DoD

1. 发现页"+"→ 安装 → 我安装的视图出现该技能(标"市场");重启保持;卸载(P-A)后再装冲突提示覆盖
2. 添加→上传技能→选择 zip(根或单层子目录含 SKILL.md)→ 装成功;拖拽目录同样
3. 坏包(无 SKILL.md/YAML 缺字段/带 .sh)→ 红字具体原因,不落盘不写库
4. 同名冲突 → 覆盖确认 → 旧目录替换、enabled/installedAt 语义正确(enabled 保留,installedAt 刷新)
5. 下载量统计:安装请求走了 /api/v1/download(平台侧计数)
6. test/lint/typecheck 全绿

## 8. 决策记录

| # | 决策 | 理由 |
|---|------|------|
| 1 | adm-zip 依赖(同步 API,小包场景) | 项目无解压库;zip KB~MB 级;zip-slip/白名单自建校验补足安全 |
| 2 | conflict 为返回值非异常 | 覆盖确认是正常流,异常留给真错误 |
| 3 | 市场"+"直接安装(无摘要确认);导入弹窗受「非高风险自动安装」控制 | PRD 3.1.1"+"静默安装;3.3.2 确认语义归导入弹窗 |
| 4 | 高风险内化判定 = requires_api_key/付费 label | PRD 未定义分级;导入本地包无 labels,该判定仅用于市场摘要展示,不阻塞 |
| 5 | version 经详情接口安装前获取一次 | download 302 响应无稳定版本信息 |
| 6 | 拖拽取 file.path(Electron 保留 API) | 渲染层无 fs;备选 dialog 主进程拾取已并存 |
