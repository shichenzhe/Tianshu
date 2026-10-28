# T5 技术验证记录：expo/fetch SSE 流式 + @tianshu/protocol file: 依赖

两个验证点决定 Task 6/7 的 SSE 载体选型（expo/fetch vs react-native-sse）。

> 版本基线：Expo SDK 57（expo 57.0.30 / RN 0.86.3 / react 19.2.3）。
> 2026-10-17 自 SDK 58 降级——App Store 无 Expo Go 58 版本（现行 57.0.9），
> 而 Expo Go 强校验 SDK 版本会拒绝加载 58 项目；expo/fetch 在 SDK 57 同样
> 存在，本验证结论不受降级影响。

- 验证页代码：`src/app/smoke.tsx`（首页「SSE 技术验证」入口）
- 本地 SSE 源：`scripts/dev-sse-server.mjs`（端口 18080，每秒推 `data: {"i":N}`）

## 验证点 1：expo/fetch 能否流式读取 text/event-stream

**已验（web 载体）**：2026-10-17 浏览器级功能验证通过——expo dev web +
`scripts/dev-sse-server.mjs`，点「开始拉流」后 `# connected: HTTP 200
text/event-stream` 先现，随后 `data: {"i":N}` 以每秒一行**增量**出现
（t+2.5s 得 3 行、t+5.5s 得 6 行、约 10s 累计 8 行），非一次性缓冲倒出；
「停止」后行数冻结。页面零 JS 错误。即 expo/fetch 的 **web 实现**（global
fetch）+ ReadableStream 读法可行。

**待人工（真机）**：expo/fetch 的 **native 实现**（Expo Go 内）仍需按下方
步骤在真机上复核——这是 Task 7 选型的最终依据。

### 操作步骤（真机 Expo Go）

1. 电脑起 SSE 源：

   ```bash
   cd /Users/hjx/workspace/tianshu-mobile
   node scripts/dev-sse-server.mjs     # 或 npm run sse；监听 0.0.0.0:18080
   ```

2. 起 Expo dev server（手机与电脑须同一局域网）：

   ```bash
   npx expo start
   ```

3. 手机 Expo Go 扫终端二维码打开 app → 首页点「SSE 技术验证」。

4. 验证页顶部确认 `ENDPOINTS.session.approve = session/approve` 正常渲染（见验证点 2）。
   URL 输入框已按 Metro dev server 的 hostUri 预填 `http://<电脑局域网IP>:18080/`，
   如预填为 `localhost`（hostUri 缺失时）手动改成电脑局域网 IP。

5. 点「开始拉流」。

### 预期现象（通过）

- 先出现一行 `# connected: HTTP 200 text/event-stream`；
- 之后**每秒**新增一行 `data: {"i":N}`，N 逐秒 +1（流式增量，不是一次性倒出）；
- 点「停止」后行数冻结，出现 `# 已停止`。

### 失败判定与 fallback

- 若长时间停在 `# connected` 后一次性涌出全部行 → 非流式（被整包缓冲）；
- 若出现 `! Response body unreadable…`（`res.body.getReader()` 不可用）或
  `TypeError: body is null` → expo/fetch 不支持 ReadableStream；
- 以上任一情况：`npm i react-native-sse`，Task 7 的 DirectTransport 内部改用
  EventSource 实现（Transport 接口不变，只换内部载体），并把结论回填本文件。

## 验证点 2：Metro 吃 @tianshu/protocol 的 npm file: symlink（CJS）

- **Metro 打包已验**：`npx expo export --platform web` 全量打包成功；grep 确认
  导出 chunk（`dist/client/.../smoke-*.js`）内含 `session/approve` 常量。
- **运行时已验（web）**：浏览器验证页渲染出
  `ENDPOINTS.session.approve = session/approve`。
- **node 侧已验**：`npm test`（vitest，node 环境 require dist/index.js）通过
  `ENDPOINTS.session.approve === "session/approve"` 断言。
- **真机复核（待人工）**：Expo Go 中同屏看到该文本即闭环。

## 结论回填区

| 验证点 | 载体 | 结果 | 日期 |
| --- | --- | --- | --- |
| SSE 流式 | expo/fetch（WHATWG ReadableStream 读法） | web 通过（增量逐秒）；**真机待人工** | 2026-10-17 |
| protocol file: symlink | npm file: → dist CJS | Metro 打包 + web 运行时 + node vitest 三路通过；真机待人工 | 2026-10-17 |
