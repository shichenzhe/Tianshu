# 天枢远程文件面设计（FA：Files-over-Agent 协议批）

- 日期：2026-10-20
- 状态：设计定稿（自主决策口径——澄清项以「假设」标注），待用户审阅
- 前置：HD spec P1-P3 全量（单 UI 多主机、AgentRunner 接缝 AR-T1/T2）
- 上游决策：HD spec「非目标：workspace 文件/附件域远程化（后续批按需）」转正

## 1. 背景与目标

**问题**：远程主机下 `caps.files` 恒 false（HD-T4 门控），@ 文件联想、
文件内容注入、图片多模态整体不可用——单 UI 双主机的最后一个大体验断层。

**目标**：远程主机会话的文件面与本地拉平：

| 能力 | 本地链 | 远程链（本批） |
|---|---|---|
| @ 文件联想清单 | `file:listWorkspaceFiles` | `files/list`（远端 workspace 目录） |
| 文件内容注入（发送前缀） | `file:readExternalFile` | `files/read`（512KB 同口径） |
| 图片多模态 | 粘贴落盘本地 attachments → ImageBlock 相对路径 | `files/uploadImage` 上传远端 → ImageBlock 远端相对路径 |

**非目标**：资料库远程化（本地库语义保持）、file-window 本地文件树
（控制端本地文件管理器）、项目域远程化、workspace CRUD 远程化。

## 2. 关键设计依据（调研结论）

1. **远端文件根**：无头端 `Workspace.directoryPath`（chat-runner
   `normalizeWorkspacePath` 已是引擎工具的文件根口径）——files 端点
   复用同口径，@ 联想清单 = 该目录下相对路径枚举
2. **图片回喂零改动**：ImageBlock 存**数据根相对路径**，引擎 loadImage
   读**被控端**数据根——上传后的远端路径进 ImageBlock，远端引擎现有
   回喂链直接兼容（控制端不感知）
3. **relay 单帧 4MiB**（relay-main maxPayload）：图片上传走 base64 过
   relay 须控制端前置压缩/收紧上限（假设 1：不做分帧，超限 toast）

## 3. 协议设计

### 3.1 被控端三端点（双侧同构：无头 server + 桌面 face）

```
files/list   {workspaceId}                    → {files: string[]}          # 相对路径，深度与本地 listWorkspaceFiles 对齐
files/read   {workspaceId, path}              → {content: string}          # 文本；512KB 上限/二进制结构化拒（本地 readExternalFile 同口径）
files/uploadImage {workspaceId, name, base64} → {absPath: string}          # 落被控端 attachments/（与本地 savePastedImage 目录结构同口径）；返回数据根相对路径
```

- 路径安全：path 归一 + workspace 根前缀校验（无头端 normalizeWorkspacePath
  既有口径；越界 4xxx 拒）
- uploadImage 大小上限 3MB（base64 前）——relay 4MiB 单帧余量（信封+加密
  开销）；超限 4xxx 结构化错，控制端映射本地化 toast
- capabilities：无头端/桌面 face 上报清单增 `"files"`；旧被控端不上报 →
  caps.files=false 门控照旧（向后兼容，连接侧零迁移）

### 3.2 send 扩参（协议小扩）

`server:sessionSend` 增可选 `images: string[]`（**远端数据根相对路径**，
uploadImage 已落盘）；被控端落 ImageBlock 走现有持久链。缺省不传 =
既有行为（向后兼容）。

## 4. 渲染层接线

1. **caps 动态化**：`capsOfCapabilities` 的 `files: has("files")`（本地
   恒 true 不变）；ChatInput/PlusMenu 门控（HD-T4）自动跟随——远程真值
   时恢复全部文件面，零新门控点
2. **api 双路由**（routeInvoke 模式）：
   - `file:listWorkspaceFiles` → 远程 `files/list`（形状直传）
   - `file:readExternalFile` → 远程 `files/read`
   - `file:savePastedImage` → 远程 `files/uploadImage`（粘贴链落盘改上传）
   - 适配器集中 `data-source/remote-files.ts`
3. **send images 远程链**：ChatApi.send 远程分支从「不传 images」改为
   **send 时逐图上传**（挂 pill 仅暂存本地临时态，不预传——避免弃发浪费）：
   控制端 blob → base64 → uploadImage → 远端路径数组 → sessionSend
4. **图片上限差异化**：本地链 10MB 保持；远程链 3MB（挂 pill 时预检，
   超限 toast「远程主机图片上限 3MB」——i18n 双语）

## 5. 分批实施

| 任务 | 内容 | 验收 |
|---|---|---|
| FA-T1 | 协议三端点+send 扩参；无头端实现（file-tools 复用）+capabilities+测试 | server 单测绿 |
| FA-T2 | face 桥三端点+capabilities+测试 | face 单测绿 |
| FA-T3 | 渲染层 remote-files 适配器+三 api 路由化+caps 动态+send images 链+上限差异化+i18n+测试 | data-source 套件绿 |
| FA-T4 | E2E（direct+relay 真子进程：list/read/upload+send 带图收流）+全量回归 | E2E 绿+实测记录 |

## 6. 风险与假设

1. **假设 1（relay 图片体积）**：不做事分帧——3MB 上限 + 前置压缩取舍；
   若实测 relay 链路图片体验不佳，后续批再评估分帧/压缩重编码
2. **假设 2（@ 联想深度）**：listWorkspaceFiles 的清单深度/过滤口径
   （node_modules 类排除）与本地实现共享纯函数（@tianshu-core 收编或
   双端各持——FA-T1 时按 drift 纪律裁定）
3. **face 语义**：桌面被控面的 attachments 与该桌面本地会话共用数据根
   ——「远端」即那台桌面，语义正确无隔离需求
4. **旧被控端兼容**：capabilities 无 "files" 的旧端，UI 门控全关
   （既有行为），无迁移路径
