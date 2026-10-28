# 天枢移动端（tianshu-mobile）— 手动验收清单（真机）

> 性质：**验收就绪文档**（Task 16 交付）。真机操作由用户执行（实现方无法操作 Expo Go 真机），逐项执行后把结果回填文末汇总表；发现问题在「五、验收发现」下自行追加记录。
> 对照文档：`docs/superpowers/specs/2026-10-17-tianshu-mobile-design.md`（下称 spec）；实施计划 `docs/superpowers/plans/2026-10-17-tianshu-mobile.md`。
> 代码基线：mirror `main`（`30a13aa` face 三端点 + `d364b21` 协议契约，其上另有二期 graph 提交）；tianshu-server `main`（`dbe8eb5` approve+manual 模式）；tianshu-mobile `main`（`49bbf9a`）——三仓已于 2026-10-18 经 git subtree 并入 monorepo（`apps/tianshu-server`、`apps/tianshu-mobile`，历史保留）。
> 自动化基线（已完成）：三仓 typecheck 零错；tianshu-mobile `npm test` 16 文件 / 108 用例全绿；mirror face 三端点与审批超时测试绿；tianshu-server approve/manual 三套件 15/15 绿。
> 矩阵维度：**目标**（桌面 face / 无头端 tianshu-server）× **承载**（direct / relay）× 场景。核心组合建议全覆盖（4 组合），重场景（审批/图片等）按条目标注的建议组合执行。

## 0. 环境记录（验收开始前填写）

| 项 | 值 |
| --- | --- |
| 验收日期 / 验收人 | |
| 手机型号 / 系统版本（iOS / Android） | |
| Expo Go 版本 | |
| Expo SDK（脚手架基线） | SDK 57（expo ~57.0 / RN 0.86 / react 19.2） |
| 电脑与手机是否同一局域网 | （Metro / direct / SSE 源均依赖） |

---

## 一、环境准备（三仓启动）

### 1.1 mirror 桌面端（被控目标 A：桌面 face）

1. `cd /Users/hjx/workspace/mirror && npm run dev`，登录后进左侧「AI → 服务端」（`/module/ai/server`）。
2. 左栏底部「本机被控面」卡：勾选**启用被控面**；端口默认 **18411**；监听地址选**「所有网卡（0.0.0.0）」**——默认 127.0.0.1 手机连不上；令牌未生成时点「重新生成令牌」并「复制令牌」（移动端 direct 连接用）。
3. relay 场景：卡内填**中继服务器地址**（`ws://<relay 主机>:8411`）与**中继令牌**，保存后卡上显示「中继已连接」。
4. **face 的 instanceId 不在卡上直显**（relay「目标实例 ID」需要它），带外获取两法：
   - 先在移动端加一条 direct 连接点「测试连接」，成功文案「连接成功（\<instanceId\>）」中即含；
   - 桌面 DevTools console 执行 `await window.ipcRenderer.invoke("serverFace:status")`，读返回的 `instanceId` 字段。
5. 注意：instanceId 为进程级随机（每次重启桌面端都会变），**重启后需更新移动端 relay 连接的目标实例 ID**。

### 1.2 tianshu-server（被控目标 B：无头端）

1. 配置文件 `src/config/config.yml`。审批场景改两处后（再）启动：
   ```yaml
   tianshu:
     chat:
       accessMode: manual          # 审批挂起模式（D 组场景；平时 default 即可）
       approvalTimeoutMs: 5000     # 超时自动 deny（默认 300000；D3 专用）
   ```
2. 启动：`cd /Users/hjx/workspace/mirror/apps/tianshu-server && TIANSHU_TOKEN=<token> npm run start:dev`（HTTP 端口 **3000**；token 为移动端 direct 连接令牌）。
3. instanceId 从启动 stdout 扫 `TIANSHU_HANDSHAKE {"port":…,"token":…,"instanceId":…}` 单行（relay「目标实例 ID」用；同 face，重启即变）。
4. 服务端库需至少一个可用 provider/model（经 `provider/save` 或桌面控制台同步落库），否则发送报 NO_MODEL（表现见已知限制 K7）。
5. relay 注册场景：启动追加 `--relay-url ws://<relay 主机>:8411 --relay-token <relay token>`（或 env `TIANSHU_RELAY_URL` / `TIANSHU_RELAY_TOKEN`）。
6. **I 组（编排区）场景无需额外配置**：服务端二期已内置 graph 相关能力上报，连接 capabilities 自动含 `graph`（桌面 face 仅 chat+provider 不含——正好作 I1/I8 的负向对照）。

### 1.3 relay（中继服务端）

```bash
cd /Users/hjx/workspace/mirror/apps/tianshu-server
npm run build
node dist/src/relay/relay-main.js --port 8411 --token <relay token>
```

`--token` 缺省拒绝启动。本机验证可用 `ws://127.0.0.1:8411`（手机与电脑同网段即可），跨网验证才需公网部署。

### 1.4 tianshu-mobile（移动端）

```bash
cd /Users/hjx/workspace/mirror/apps/tianshu-mobile
npx expo start
```

手机装 **Expo Go 57.x（SDK 57 对应版；App Store 现行 57.0.9，Expo Go 强校验 SDK 版本，58 项目会被拒载）**，扫终端二维码打开（手机与电脑须同一局域网）。若改过 mirror 协议包源码：先在仓库根 `npm --prefix packages/tianshu-protocol run build`，再 `npx expo start -c` 清 Metro 缓存。

**双控制端小技巧**：D4 竞速 / K1 串流观察需要第二个控制端——用电脑浏览器开 `npx expo start --web` 即可（web 载体同样是完整控制端），或第二台设备装 Expo Go。

---

## 二、验收矩阵（场景）

> 建议顺序：G（技术验证）→ A → B → C → D → E → F → H → I → J。每条目标注建议组合：`face`（桌面端）/`server`（无头端）× `D`（direct）/`R`（relay）。

### G. SSE 技术验证（smoke 页，先做——决定后续是否有阻塞性风险）

#### G1. expo/fetch 真机流式 + 协议包渲染

- **组合**：无被控端依赖（本地 SSE 源）。
- **操作步骤**：
  1. `node scripts/dev-sse-server.mjs`（或 `npm run sse`，监听 `0.0.0.0:18080`）；
  2. `npx expo start` → Expo Go 扫码 → 首页底部点「SSE 技术验证」；
  3. 确认 URL 预填 `http://<电脑局域网 IP>:18080/`（若预填成 localhost 手动改），点「开始拉流」。
- **预期结果**：先出现 `# connected: HTTP 200 text/event-stream`；随后 `data: {"i":N}` **每秒 +1 增量**出现（非一次性涌出）；点「停止」后行数冻结出现「已停止」；页面上 `ENDPOINTS.session.approve = session/approve` 文本正常渲染（Metro 吃 file: symlink 协议包）。
- **失败判定**：停在 connected 后一次性涌出全部行 / 出现 `! Response body unreadable` 或 `TypeError: body is null` → expo/fetch native 不支持流式。

#### G2. 结论回填

- **操作步骤**：把 G1 真机结果回填 tianshu-mobile 仓 `src/transport/smoke.md` 结论表（SSE 流式、protocol symlink 两行的「真机」列 + 日期）。
- **预期结果**：表格回填完成；若 G1 失败，按 smoke.md 的 fallback 执行（`npm i react-native-sse`，DirectTransport 内部换 EventSource 载体，Transport 接口不变），并在本文件「五、验收发现」记录决定。

### A. 连接管理（/connections 页）

#### A1. 添加直连连接

- **组合**：face×D、server×D。
- **操作步骤**：首页点顶部连接切换器 → 进连接管理 →「添加直连」→ 填名称 / 地址（`http://<电脑 IP>:18411`（face）或 `http://<host>:3000`（server））/ 访问令牌 → 保存。
- **预期结果**：列表出现新卡片（「直连」模式标签、六态色点初始「未连接」灰）；持久化——杀掉 Expo Go 重开仍在（AsyncStorage）。

#### A2. 测试连接四分类文案

- **组合**：任一目标×D（R 同构）。
- **操作步骤与预期**（表单内点「测试连接」，测试中按钮置灰防重入）：

| 触发 | 预期内联文案 |
| --- | --- |
| 必填字段留空（direct 缺地址/令牌；relay 三缺一） | 「配置不完整」（保存也被拦） |
| 地址正确 + 令牌填错值 | 「令牌无效」（face 401 / server 200+code 4010 均归此类） |
| 地址指向未监听端口（如 :9999）或被控端已停 | 「无法连接」 |
| 地址为不可路由 IP（如 `http://10.255.255.1:18411`） | 约 8s 后「连接超时」 |
| 全部正确 | 「连接成功（\<instanceId\>）」 |

#### A3. 激活与六态徽章

- **组合**：face×D（R 同构）。
- **操作步骤与预期**：

| 状态（文案/色） | 触发 |
| --- | --- |
| 未连接（灰） | 保存后未点「使用」 |
| 连接中（灰） | 点「使用」的一瞬（短暂） |
| 已连接（绿） | 正常激活后 |
| 重连中（黄） | 激活后停掉被控端 / 手机关 Wi-Fi——指数退避重连期间 |
| 令牌无效（红，粘滞） | 令牌错的重连失败后；改对令牌保存后需**再点「使用」**（编辑保存不自动重连，已知语义） |
| 已断开（灰） | 激活连接 B 后，原活动连接 A 卡片（teardown 终态） |

#### A4. 删除确认

- **操作步骤**：卡片垃圾桶图标 → 系统弹窗「确定删除「\<name\>？」」，点「取消」不动、点确认（destructive 样式）删除。
- **预期结果**：确认后卡片消失；删的是活动连接则 activeConnId 一并清空（首页变「暂无活动连接」空态）。

#### A5. iOS Modal 状态残留（必测——T12 修复核验，RN 0.88 isRendered 坑）

- **组合**：iOS 真机（Android 顺手过一遍）。
- **操作步骤**：连接 A 卡点编辑（铅笔）→ Modal 显示 A 的字段 → 下滑/「取消」关闭 → **立刻**点「添加直连」→ 检查表单 → 再点连接 B 的编辑检查。
- **预期结果**：重开的表单**全空**（模式、名称、地址、令牌均无 A 残留）；编辑 B 时显示 B 的字段不串 A。关闭动画期间 iOS 可能见短暂空屏滑出（已知取舍，T12 minor）。

#### A6. 添加中继连接

- **组合**：face×R、server×R。
- **操作步骤**：「添加中继」→ 填名称 / 中继地址（`ws://<relay 主机>:8411`）/ 中继令牌 / 目标实例 ID（= 被控端 instanceId，获取法见 1.1/1.2）→ 保存 →「使用」。
- **预期结果**：状态点连至「已连接」（relay open 帧按 connectionId 配对成功）；目标实例 ID 填错时表现为「重连中」往复（配不上对），改对后点「使用」恢复。

### B. 会话列表（首页）

#### B1. 分页

- **组合**：任一目标×任一承载（被控端备 >pageSize 条会话，可在桌面端批量建）。
- **操作步骤**：进列表上拉触底。
- **预期结果**：追加下一页（跨页 id 去重）；取尽后继续上拉不再请求；下拉刷新回第一页。

#### B2. 搜索

- **操作步骤**：搜索框输入关键词（观察约 400ms 防抖）；输入无匹配词；点清空按钮。
- **预期结果**：防抖后出过滤结果；无匹配显示「无匹配会话」；清空恢复全量。搜索换词时旧结果不串台（时序令牌）。

#### B3. 新建跳转

- **操作步骤**：右下角 FAB 新建会话。
- **预期结果**：创建成功**立即跳转**会话流页；返回列表时新会话**置顶**可见（无需下拉刷新）。

#### B4. 长按删除

- **操作步骤**：长按会话行 → 弹窗「确定删除「\<title\>？」」确认。
- **预期结果**：行消失、计数减一；删除失败（如断网）行保留。

#### B5. 桌面改名事件刷新

- **组合**：face×D（事件经 SSE 推送）。
- **操作步骤**：移动端停在列表页，桌面端给某会话改名（或归档）。
- **预期结果**：列表行**原地更新**标题（session.updated 推送），无需下拉刷新。

#### B6. 连接切换串台窗口观察（联动已知限制 K6）

- **操作步骤**：列表页显示连接 A 的会话 → 经连接切换器换活动连接为 B → 返回列表。
- **预期结果**：B 的表加载完成前可能**短暂残留 A 的旧行**（server.connected 全量重拉收口）。观察串台窗口时长是否可接受，结果记入 K6 判定。

### C. 会话流（session/[id]）

#### C1. 历史加载与 blocks 渲染

- **组合**：face×D、server×D（R 同构）。
- **操作步骤**：进有历史的会话（桌面端先造含各块型的对话：markdown 文本、思考、工具调用、带图消息）。
- **预期结果**：消息按时间序渲染、最新在底；text 走轻量 markdown（标题/代码块/列表/引用/行内粗斜体代码）；thinking 默认收起（角标字数 + 首句摘要），点按展开；tool 卡六态徽章 + 参数截断 + 输出折叠展开；usage 角标 `↑输入 ↓输出 tokens`；图片块见 F 组。

#### C2. 流式逐块

- **操作步骤**：发送一条会触发思考与工具的消息（如「写一个快速排序并简单解释」）。
- **预期结果**：thinking 角标字数增长；text 逐块追加（非整段蹦出）；tool 卡「执行中」→「完成」；发送期间输入框锁定、发送键变红色「中止」。

#### C3. finish 定稿

- **操作步骤**：等本轮回复自然结束。
- **预期结果**：流结束后 live 并入定稿历史（getById 重拉覆写），无重复/残缺；乐观用户消息与落库真值一致；错误横幅清空。

#### C4. 中止

- **操作步骤**：生成中点红色「中止」。
- **预期结果**：流停、sending 解锁、输入恢复；被控端侧该轮停止（桌面端可见已收部分内容）。

#### C5. 断线恢复

- **组合**：face×D（杀桌面进程 / 关电脑 Wi-Fi 几秒再开）。
- **操作步骤**：生成中断网。
- **预期结果**：断线即现红字横幅「连接中断」、sending 解锁（乐观消息保留显示）；网络恢复后自动重连（徽章「重连中」→「已连接」），server.connected 触发列表与当前会话**重拉定稿**（对齐服务端真值）。

#### C6. 双端同推

- **组合**：face×D（桌面端自身即第二控制面）；server 可用 web 载体第二控制端。
- **操作步骤**：移动端停在某会话页，桌面端（或第二控制端）在同会话发送消息。
- **预期结果**：移动端**实时**收到该轮流式回显（chunk 按 sessionId 分发），与桌面端同步收尾。

### D. 审批（无头端 manual 模式主路径；face 超时为 10 分钟常量不可配）

> 前置：`accessMode: manual` 已配好；D3 另需 `approvalTimeoutMs: 5000` 并重启 server。触发审批：发送会用到写类工具的指令（如「在数据根创建一个文件 test.txt」）。

#### D1. 批准

- **组合**：server×D / server×R。
- **操作步骤**：触发挥盘工具 → Banner 出现 → 点「批准」。
- **预期结果**：Banner 含盾图标标题「工具执行申请审批」+ 工具名 + 参数摘要（截断）；批准后 Banner **即刻收起**、工具卡「执行中」→「完成」、回复流继续。

#### D2. 拒绝

- **操作步骤**：同 D1 但点「拒绝」（描边按钮）。
- **预期结果**：工具卡出现橙色「已拒绝」徽章；流继续（模型收到拒绝结果后继续话术）；Banner 收起。

#### D3. 超时自动 deny（approvalTimeoutMs 调小验证）

- **操作步骤**：`approvalTimeoutMs: 5000` 重启 server → 触发审批后**放任不点**。
- **预期结果**：约 5s 后服务端自动 deny，移动端 Banner 经 denied tool-update **自动收起**、工具卡「已拒绝」；若恰在超时瞬间按键则得 4040 → 走 D4 表现。

#### D4. 双端竞速 4040 新文案

- **组合**：server×D + 第二控制端（web 载体 / 第二台设备）；face 目标可用桌面聊天自身的审批条做对手。
- **操作步骤**：同一挂起审批，另一控制端**先**应答 → 本端再点「批准/拒绝」。
- **预期结果**：先到方生效；后到方按键转圈后出**内联琥珀提示「该审批已被处理或已失效」**且按键锁死（stale 态），随后到达的 tool-update 把 Banner 真出队收起；队列中还有下一项时立刻顶上（角标「还有 N 项待审批」减一）。

#### D5.（可选）face 目标审批

- **操作步骤**：face 直连下，用桌面端带审批的工具会话触发（移动端发送或桌面端发送均可）→ 移动端 Banner 应答。
- **预期结果**：同 D1/D2；与桌面聊天审批条互为竞速对手（同 D4）；face 超时自动 deny 为 10 分钟常量。

### E. 模型选择

#### E1. capability 门禁

- **操作步骤**：会话页看头部模型胶囊（headerRight）。
- **预期结果**：face（chat+provider）与 server（chat+provider+graph）都含 `provider`，胶囊可点（主题色 subtle 底）；点击弹分组模型列表（按服务商分节、选中行主题色 + Check）。灰显「未选择模型」不可点的负向路径日常碰不到（需老版本 face），不强求。

#### E2. 选择随 send 生效

- **组合**：server×D（列表里至少两个模型）。
- **操作步骤**：胶囊选另一模型 → 发送新消息 → 桌面/服务端侧核对该轮实际用的模型（usage 行/模型列）；退出会话页重进。
- **预期结果**：新轮次用新模型；选择**不回写**服务端会话（重进回「选择模型」态——本页本轮生效语义）；首开拉取成功后重开列表**不再重拉**（页面生命周期缓存）。

### F. 图片（仅 face 目标有无头端没有的图片产生链路）

#### F1. 桌面发图 → 移动端加载

- **组合**：face×D。
- **操作步骤**：桌面端会话贴图发送（ImageBlock 落库）→ 移动端进该会话。
- **预期结果**：图片块经 `image` 端点 base64 加载显示（宽约 70%、contain、圆角）；同图滚动复现**零二次请求**（模块缓存）；切换连接再回来不串显旧连接图（缓存按连接维度隔离）。

#### F2. 失败占位

- **操作步骤**：把数据根里对应图片文件移走/改名 → 移动端进会话（或下拉刷新触发重挂）。
- **预期结果**：灰底「图片加载失败」占位，页面不崩；其余块正常。

### H. 设置页（M1 交付：语言 / 主题 / 关于）

> 入口：首页顶部连接切换器行**右侧** Settings 齿轮图标（`/settings`）。

#### H1. 语言切换即时重渲 + 重启恢复

- **操作步骤**：设置页「语言」区点 English → 观察本页（区标题 / 行文案）与 Stack 标题、返回首页与编排区 → 点「中文」切回 → 完全杀掉 Expo Go 重开。
- **预期结果**：切换即时全页重渲（react-i18next 语言变更，无需重启）；当前语言行选中态（subtle 底 + primary 描边 + Check 图标）；重启后保持（AsyncStorage；M4 后新 key `tianshu-mobile.locale`，旧档 `tianshu-mobile-locale` 首读自动迁入）。

#### H2. 主题四色切换即时换色 + 重启恢复

- **操作步骤**：「主题」区四色卡（蓝 / 红 / 绿 / 橙）逐个点 → 返回首页、进编排区 / 会话流看主题跟随 → 杀 Expo Go 重开。
- **预期结果**：整页（及全 App 已挂载页面）primary / subtle 等主题变量**即时**跟随；色卡以自身主题色渲染色点与卡底（浅底深字，明暗两模式均可辨），当前项以自身 primary `border-2` 描边、无布局跳动；重启后保持（key `tianshu-mobile.theme`）。已知观感：暗色模式下色卡为浅色块——预览固有形态（保证色相可辨），非缺陷（M1 concerns 2）。

#### H3. 版本与已知限制显示

- **操作步骤**：看「关于」区。
- **预期结果**：「天枢移动端」+ 版本号行（Expo Go / dev 下取 app.json 的 1.0.0，正式构建后为原生版本号）+ 已知限制一句提示（「多控制端同时遥控同一会话可能串流」）。

### I. 编排区（M2 交付：graph / automation 遥控，目标仅无头端）

> 前置：活动连接为无头端（graph 能力上报见 1.2 第 6 条）；造数据：经桌面端远控编排页（或 web 控制端）在服务端备若干 graph 与 automation 任务——**含一个耗时图（多工具轮次）与一个引用该图的自动化任务**（I7 拦截场景用）。

#### I1. 入口图标 capability 门控

- **组合**：server×D vs face×D。
- **操作步骤**：活动连接分别为无头端与桌面 face 时看首页顶部。
- **预期结果**：仅 capabilities 含 `graph` 的连接显示 Workflow 图标（Settings 图标左侧）；face（chat+provider）连接不显示；能力未知（server.connected 未到达 / 切换连接窗口期）不视为具备、同样不显示。

#### I2. Graphs / Automations 两段列表

- **组合**：server×D（R 同构）。
- **操作步骤**：进编排区，「编排图 / 自动化」两段来回切；下拉刷新；滚动触底翻页。
- **预期结果**：主题色分段控件；graph 卡（name / description 截断 + nodeCount 徽标 + enabled 停用灰显 opacity 0.55 但动作仍可用）；automation 卡（targetKind 徽标点：graph 橙点「编排」/ prompt 蓝点、scheduleText 空兜底「未配置调度」、nextRunAt **未来向**相对时间——60 秒内「即将」/「N 分钟后」/ 同日「N 小时后」/ 跨日绝对日期）；分页跨页 id 去重、取尽不再请求、下拉刷新回第 1 页。

#### I3. 运行 → 乐观 running → 事件终态徽标

- **组合**：server×D。
- **操作步骤**：graph 卡点「运行」→ 观察徽标与按钮 → 等待 graph.run.updated 终态 → 点终态徽标。
- **预期结果**：202 受理后徽标**乐观**转「运行中」（蓝）、按钮换红描边「中止」（busy 防双击）；事件到达落终态徽章（succeeded 绿 / failed 红 / aborted 橙 / queued 灰，语义固定色不随主题强调色）；点终态徽标弹 Alert 详情（output / error，800 字截断）；他人或第二控制端触发的运行同样经广播事件归档到本端徽标。

#### I4. 中止

- **操作步骤**：运行中点红描边「中止」。
- **预期结果**：请求携本端 runs 的 runId，aborted 终态由事件回传（不本地合成）；徽标橙「已中止」。若 aborted 事件丢失，徽标停留「运行中」——断开重连（server.connected 清空 runs + 双拉）后复位，联动 K10。

#### I5. 启停 Switch（save 全量语义）

- **操作步骤**：automation 卡 Switch 开↔关各一次。
- **预期结果**：乐观即时翻转 + busy 禁用；save 载荷为**全量任务对象**（scheduleJson 解析还原为 schedule 对象在内的全字段，非仅 enabled 布尔）；成功后回参原位覆写；失败（如中途断网）自动重拉还原原值。

#### I6. 立即运行

- **操作步骤**：automation 卡点「立即运行」。
- **预期结果**：202 受理回执 Alert（单按钮信息弹窗——移动端无 toast 库，沿用 Alert 惯例，M2c concerns 1）。

#### I7. 长按删除（GRAPH_IN_USE 引用拦截）

- **操作步骤**：长按无引用的 automation 卡 → 确认删除；再长按被自动化任务引用的 graph 卡 → 确认删除。
- **预期结果**：无引用者成功后本地移行；被引用者服务端拒删（GRAPH_IN_USE）→ Alert 友好文案并透传**被引用任务名清单**（`GRAPH_IN_USE:` 冒号后 detail 拼入）。

#### I8. 空态与能力门禁三分支

- **操作步骤**：1) server 连接且服务端无任何 graph / 任务时进编排区；2) face 活动连接下直达 /orchestration 路由（深链，或驻留编排页时切换活动连接）；3) 无活动连接时直达该页。
- **预期结果**：三分支——有连接有能力无数据 → empty + tip 空态；有连接无 graph 能力 → 整页能力不支持提示（不发列表请求）；无活动连接 → 整页「暂无活动连接」+「去连接管理」按钮（判定顺序先连接后能力，M2c Fix 1）。

#### I9. 错误码友好文案（GRAPH_ALREADY_RUNNING 场景）

- **组合**：server×D + web 第二控制端（或断连重连法）。
- **操作步骤**：
  1. 造「已在运行」场景（任一）：a) 运行耗时图后**断开重连**（runs 投影被清空而服务端仍在执行）再回编排区；b) web 第二控制端触发同图运行，移动端在其 running 事件到达前抢点；
  2. 对运行中的图再点「运行」。
- **预期结果**：Alert 显示 i18n 友好文案（「图已在运行中」类），非原始 code / message；错误映射同表覆盖 GRAPH_IN_USE（带任务名 detail）/ GRAPH_NOT_FOUND / GRAPH_NOT_RUNNING，未知码 message 原样、code 与 message 双空走 networkError 兜底（M2c Fix 3）。

### J. 通知（M3 交付 + M4 修正：expo-notifications 本地通知，无远程推送）

> 前置：真机（iOS / Android 都过一遍）；审批场景同 D 组（server `accessMode: manual`）；需 web 第二控制端在移动端退后台后触发事件。
> **Android 注意**：通知渠道 importance 已升 HIGH（M4 项 6），但渠道属性变更仅对**新装**生效——**老安装需卸载重装**才能拿到高优先级审批横幅，验收 Android 时留意安装时间点。

#### J1. 设置页通知开关（系统权限 + 拒绝回弹）

- **操作步骤**：设置页「通知」区（主题与关于之间）：首开总开关 → 系统权限弹窗，分别走「同意」「拒绝」两臂；关掉总开关看子开关；iOS 拒绝过一次后再开。
- **预期结果**：初始总开关关、子开关（审批请求 / 图完成）开但置灰（opacity 0.45）；首开请求期间该行置灰禁用（pending）；同意 → 总开关开、子开关可操作；拒绝 → Alert 提示（引导去系统设置）且总开关**保持关**（受控回弹）；iOS canAskAgain=false 后系统不再弹窗、仍出提示文案（跳系统设置页留后续增强）。后台限定 hint 小字可见。

#### J2. 后台审批请求横幅

- **组合**：server×D（manual 模式）+ 第二控制端；iOS 真机看横幅样式。
- **操作步骤**：通知开（审批子开关开）→ app 退后台（Home 键，保持存活）→ 第二控制端发送触发审批的消息。
- **预期结果**：系统横幅「审批请求」+ 工具名；同 toolCallId 重发不重复响；返回 app 后 Banner 仍可正常应答。iOS inactive 态（下拉通知中心 / 控制中心遮盖）不误发（M4 项 3：仅真后台发）。

#### J3. 后台图终态通知

- **操作步骤**：通知开（图完成子开关开）→ 触发图运行后立即退后台 → 等终态。
- **预期结果**：横幅「图运行结束」+「成功 / 失败 / 已中止 · 图名」（graphId 查不到名只发状态文案）；同终态事件重发不重复响；同一 run 先 failed 再 aborted 会双响为已知边角（服务端单 run 只发一个终态，正常路径遇不到，M3 concerns 3）。

#### J4. 前台不通知

- **操作步骤**：app 前台停留时触发审批 / 图终态。
- **预期结果**：无任何系统通知（前台界面已有 Banner / 徽标；iOS 未设前台 handler 故必静默——M3 concerns 2）。

#### J5. app 被杀收不到（已知限制复核，联动 K9）

- **操作步骤**：杀掉 Expo Go 进程 → 第二控制端触发审批 / 图终态 → 重开 app。
- **预期结果**：杀进程期间无任何通知（本地通知仅前台 / 后台存活期可达）；重开后事件不补发（无离线队列）；设置页 hint 已明示该限制。

---

## 三、已知限制复核清单（ledger deferred/minor 汇总）

逐条复核表现是否符合预期（而非修掉——均为已裁定保留项），结果记入汇总表 K 行。

| # | 限制（来源） | 复核观察点 |
| --- | --- | --- |
| K1 | 多控制端同会话**串流**（spec §8：relay 对同 connectionId 的 res/event 帧广播给全部已配对 client） | 两控制端同 open 一个 connectionId：双方都收到对方的响应与事件帧——功能可用但有串台；按单控制端使用约定 |
| K2 | `getById` 全量拉取慢（spec §8，T13/T14） | 进一个超长会话（如 200+ 消息）记录进入到可交互的时长，供后续增量端点评估 |
| K3 | relay instanceId 带外获取（spec §8） | 确认 1.1 的两条获取路径可用（direct 测试读 instanceId / DevTools status 接口）；face 卡无直显属实 |
| K4 | 静态 token 风险（spec §9） | 错 token 有「令牌无效」粘滞 + 引导（A3 已覆盖）；泄漏的补救=face「重新生成令牌」/ server 换 `TIANSHU_TOKEN`，无设备级撤销 |
| K5 | 图片**发送**不支持（spec §3 不做） | 移动端 composer 无附件入口（预期行为，非缺陷） |
| K6 | 连接切换旧表串台窗口（T13 minor，本验收裁定） | B6 观察：串台窗口时长与观感，裁定「可接受」或立后续任务 |
| K7 | NO_MODEL 类错误乐观消息短暂消失（T14 minor：落库后抛的错走 session.error 会滤掉乐观消息） | 无模型配置的 server 直发消息：乐观气泡短暂消失、错误文案出现、重拉自愈——不视为缺陷（可选后续按错误码区分） |
| K8 | instanceId 每进程随机（1.1/1.2 注意事项） | 重启被控端后 relay 连接需手动更新目标实例 ID——确认更新后即恢复 |
| K9 | 本地通知 app 被杀不可达（M3 concerns 1） | J5 复核：杀进程后事件无通知、重开不补发；远程推送留待 EAS development build + 开发者账号（后续迭代） |
| K10 | 编排区 abortRun 事件丢失徽标停留 running（M2c concerns 3，与桌面蓝本同取舍：不本地合成 aborted） | I4 观察：中止后若徽标停在「运行中」，断开重连（server.connected 清空 runs + 双列表重拉）后复位 |
| K11 | 重拉恒回第 1 页（编排区与会话列表同款分页语义） | 下拉刷新 / server.connected 重连双拉后列表回第 1 页，深页浏览位置不保留——复核观感是否可接受 |
| K12 | provider/query 传输面脱敏（M5：apiKey 掩码 `__REDACTED__`） | 移动端 ModelPicker 不读密钥、模型列表功能不受影响；核验走 web 第二控制端 DevTools 网络面看 provider/query 响应 `apiKey == "__REDACTED__"`（extraHeaders 值掩码、头名保留）；桌面本地 provider 编辑走本地 IPC 不经被控面不受影响，server 侧 echo 掩码不清空现值（回写防御已就位） |

---

## 四、遗留记录

### L1. markdown 自写渲染器裁定（spec §8 预留项落地）

spec §8 预留「`react-native-markdown-display` 维护一般，备选自写轻量渲染」——**实现时裁定为自写**（T14）：`src/logic/markdown.ts` 纯函数 + `MarkdownLite.tsx` 渲染，子集覆盖 heading 1-3 / 围栏代码块（带语言角标、不高亮）/ 有序无序列表 / 引用 / 段落，行内 bold / italic / code（标记不跨行、未闭合按字面）。13 用例单测。已知边界（可接受）：`2*3*4` 类文本误判斜体、语言角标整串显示等；链接与长按复制未做（需 expo-clipboard，超出当时任务边界），后续需要再扩。

### L2. expo/fetch 验证结论（T5 smoke.md 摘要）

- **web 载体已验**（2026-10-17 浏览器级）：HTTP 200 text/event-stream 后 `data: {"i":N}` 每秒增量出现，「停止」冻结，零 JS 错误——expo/fetch 的 web 实现（global fetch）+ ReadableStream 读法可行。
- **真机 native 待验**（本清单 G1）：唯一残留技术假设。
- **fallback 预案**（G1 失败时）：`npm i react-native-sse`，DirectTransport 内部改用 EventSource 实现（Transport 接口不变，只换内部载体），结论回填 `src/transport/smoke.md`。
- 附带已验：Metro 吃 `@tianshu/protocol` npm file: symlink（CJS dist）——web 打包/运行时/node vitest 三路通过，真机同屏核验在 G1 一并闭环。

### L3. 后续迭代清单（spec §3「不做」同款，按序）

推送通知（移动后台需自建长连或推送网关）、语音输入、自动化与 graph 遥控（二期 `graph/*` / `automation/*` 落地后 capability 驱动渲染——无头端现已上报 `graph` 能力，移动端暂不渲染编排区）、图片**发送**、provider/save（模型写面留在桌面端）、设备配对码 / per-device 凭据轮换、E2E 加密、多控制端串流隔离。

---

## 五、验收发现（执行时自行追加）

（问题、截图文件名、归因与处置决定记于此节。）

---

## 六、汇总表（结果回填）

结果列填：通过 / 不通过 / 未测；备注记现象与偏差。

| # | 验证点 | 建议组合 | 结果 | 备注 |
| --- | --- | --- | --- | --- |
| G1 | expo/fetch 真机流式 + ENDPOINTS 渲染 | 本地 SSE 源 | | |
| G2 | smoke.md 结论回填 | — | | |
| A1 | 添加直连 + 持久化 | face/server × D | | |
| A2 | 测试四分类文案 | × D | | |
| A3 | 激活 + 六态徽章 | face × D | | |
| A4 | 删除确认 | 任一 | | |
| A5 | iOS Modal 编辑 A→关→添加/编辑 B 防串态 | iOS | | |
| A6 | 添加中继（含错 connectionId 表现） | face/server × R | | |
| B1 | 分页（上拉/取尽/下拉刷新） | 任一 | | |
| B2 | 搜索（防抖/无匹配/清空） | 任一 | | |
| B3 | 新建即跳转 + 列表置顶 | 任一 | | |
| B4 | 长按删除确认 | 任一 | | |
| B5 | 桌面改名事件刷新 | face × D | | |
| B6 | 连接切换串台窗口（K6 联动） | 任一双连接 | | |
| C1 | 历史加载 + 五种 blocks 渲染 | face/server × D | | |
| C2 | 流式逐块（thinking/text/tool） | 任一 | | |
| C3 | finish 定稿（无重复残缺） | 任一 | | |
| C4 | 中止 | 任一 | | |
| C5 | 断线恢复（文案/解锁/重拉定稿） | face × D | | |
| C6 | 双端同推 | face × D | | |
| D1 | 审批-批准 | server × D/R | | |
| D2 | 审批-拒绝 | server | | |
| D3 | 超时自动 deny（5000ms） | server | | |
| D4 | 双端竞速 4040 新文案 | server/face + 第二端 | | |
| D5 | face 审批（可选） | face | | |
| E1 | 模型胶囊 capability 门禁 | face/server | | |
| E2 | 模型选择随 send 生效 | server × D | | |
| F1 | 桌面发图移动端加载（缓存/隔离） | face × D | | |
| F2 | 图片失败占位 | face × D | | |
| H1 | 语言切换即时重渲 + 重启恢复 | 任一 | | |
| H2 | 主题四色切换即时换色 + 重启恢复 | 任一 | | |
| H3 | 版本与已知限制显示 | 任一 | | |
| I1 | 编排入口 capability 门控（face 不显示） | server vs face | | |
| I2 | Graphs / Automations 两段列表 + 分页 | server | | |
| I3 | 运行乐观 running → 事件终态徽标 | server | | |
| I4 | 中止（事件回传终态） | server | | |
| I5 | 启停 Switch（save 全量 / 失败还原） | server | | |
| I6 | 立即运行 202 回执 | server | | |
| I7 | 长按删除 + GRAPH_IN_USE 拦截文案 | server | | |
| I8 | 空态三分支（无数据 / 无能力 / 无连接） | — | | |
| I9 | 错误码友好文案（ALREADY_RUNNING） | server + 第二端 | | |
| J1 | 通知开关（权限请求 / 拒绝回弹 / pending） | iOS / Android | | |
| J2 | 后台审批请求横幅 | server + 第二端 | | |
| J3 | 后台图终态通知 | server | | |
| J4 | 前台不通知 | 任一 | | |
| J5 | app 被杀收不到（K9 联动） | 任一 | | |
| K1 | 串流限制复核 | R + 双端 | | |
| K2 | getById 全量时长记录 | 长会话 | | |
| K3 | relay instanceId 带外获取路径 | — | | |
| K4 | 静态 token 风险口径 | — | | |
| K5 | 图片发送不支持（预期） | — | | |
| K6 | 串台窗口裁定 | — | | |
| K7 | NO_MODEL 乐观消息短暂消失 | server | | |
| K8 | 重启后 instanceId 更新 | — | | |
| K9 | 通知 app 被杀不可达 | — | | |
| K10 | abortRun 事件丢失徽标停留 | server | | |
| K11 | 重拉恒回第 1 页 | 任一 | | |
| K12 | provider/query 脱敏口径 | web 第二端 | | |
