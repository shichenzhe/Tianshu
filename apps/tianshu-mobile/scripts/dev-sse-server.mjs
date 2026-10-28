// 本地 SSE 源（expo/fetch 流式拉流技术验证用，T5）。
// 用法：node scripts/dev-sse-server.mjs   （或 npm run sse）
// 端口 18080；每秒向当前连接推送一行 `data: {"i":N}`，Ctrl+C 结束。
// 真机验证时手机须与电脑同一局域网，验证页 URL 填 http://<电脑局域网IP>:18080/
// （Expo Go 下验证页已按 Metro dev server 的 hostUri 预填同网段地址）。
// CORS 已放开，web 导出页跨源访问亦可。
import http from "node:http";

let i = 0;
http
  .createServer((req, res) => {
    console.log(`[dev-sse] ${req.socket.remoteAddress} connected`);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });
    const timer = setInterval(() => res.write(`data: {"i":${++i}}\n\n`), 1000);
    req.on("close", () => {
      console.log("[dev-sse] client closed");
      clearInterval(timer);
    });
  })
  .listen(18080, () => console.log("[dev-sse] listening on http://0.0.0.0:18080/"));
