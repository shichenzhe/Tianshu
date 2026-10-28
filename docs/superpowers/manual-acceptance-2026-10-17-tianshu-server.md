# tianshu-server 双链路 E2E —— 桌面端全链路人工验收（T19 Step 3）

- 日期：2026-10-17
- 验收人：Task 19 会话（CDP 驱动自动化执行，步骤与判定如实记录）
- 环境：mirror `main`（dev 模式 `vite --host 127.0.0.1:5173` + Electron 双实例之一挂
  `--remote-debugging-port=9223`，playwright-core CDP 驱动）；tianshu-server `dist`
  产物（`npm run build`）；真实模型 = 本机 LMStudio `http://localhost:8002/v1`
  `Qwen3.5-0.8B-MLX-4bit`（mirror dev 库 provider#1）

## 步骤与结果

1. **登录**：dev 库注册用户 `tsdriver19` 并登录（旧测试用户口令已失效）——OK
2. **进入「服务端」控制台**：侧栏 `/module/ai/server`，页面与「添加连接」「本地无头端」卡渲染——OK
3. **本地无头端启动**：目录填 `/Users/hjx/workspace/tianshu-server` → 点「启动」→
   Supervisor spawn + 握手成功，状态转「运行中」，连接行 `local` 出现且状态点
   `bg-primary`（connected）——OK（截图 `t19-console-local-started.png`）
4. **新建远程会话**：面板「新建会话」建会话成功（见下方遗留 1：该入口不带模型）
5. **发送消息看流式**：经面板选中带模型的会话后，输入「请只回复 pong」发送 →
   助手气泡流式回显 `pong`，落库后带 usage（`1505 输入 / 1 输出 tokens`）——OK
   （截图 `t19-console-remote-pong.png`；消息区最终文本
   `"请只回复 pongpong1505 输入 / 1 输出 tokens"`，用户气泡+助手回显+usage 三段齐）

全链路：桌面 UI → 控制端 IPC → DirectTransport（fetch+SSE）→ tianshu-server
HTTP `/session/send`（202）→ EventBus `/event` SSE（message.chunk → finish →
session.updated）→ 控制端动态通道 → RemoteMessageList 流式上屏 → 回读历史。

## 验收中发现（均已在 T19 处置）

- **SSE 被 gzip 缓冲（tianshu-server 缺陷，已修）**：默认 `compression` 中间件对
  hijack 直写的 `/event` 响应套 gzip 且小帧不刷出——首帧永远到不了客户端，
  桌面直连流式回显在修复前不可用。修复：`event.controller.ts` 以
  `Cache-Control: no-cache, no-transform`（setHeader 预置）豁免压缩，附回归测试
  `tianshu-server test/modules/event-stream.spec.ts`。详见 task-19 报告。
- **遗留 1（UI 面板缺口，未在本任务修）**：远控面板「新建会话」不指定
  `currentModelId`，对新库直接发送会触发服务端 `NO_MODEL`（session.error toast）。
  本次验收经页面 IPC 直调 `server:sessionCreate {currentModelId}` 建会话绕过。
  建议后续在面板加模型选择或读被控端默认模型。
- **环境残留**：验收前发现一个早前会话遗留的 tianshu-server 进程占用 3000 端口
  （已结束）；旧测试桌面实例（06:40 起）与本验收并行未受影响。

## 复现手册（手动步骤清单）

1. tianshu-server：`npm run build`
2. mirror：`npm run dev`（vite 若只听 IPv6 localhost，加 `--host 127.0.0.1`）
3. 登录 → 左侧「服务端」→ 本地无头端卡填 tianshu-server 目录 → 启动
4. 连接行 `local` 选中（状态点为主题色 = connected）
5. 「新建会话」→ 发送「请只回复 pong」→ 观察流式回显与 usage 行
   （若服务端库无模型配置，先经 provider/save 或 E2E 脚本落一个 provider）
