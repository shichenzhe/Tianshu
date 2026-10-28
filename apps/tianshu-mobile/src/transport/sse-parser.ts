/**
 * SSE 流解析器（DirectTransport 事件通道）：吃任意切分文本块，吐完整
 * 事件帧 {event, data}——两端被控端（server-face / tianshu-server）的 SSE
 * 线格式为 `event: <type>\ndata: <json>\n\n`，事件类型只在 event: 行，
 * 消费侧靠本字段重建 ServerEvent.type。多 data: 行按规范 \n 拼接；
 * `:` 注释行即心跳，id:/retry: 本协议不用，均忽略；无 event: 行时
 * event 为 undefined（ServerEvent 重建时丢弃该帧）。
 * 对照 mirror direct-transport.ts dispatchSseBlock 语义（唯一差异：
 * mirror 缺 event 行时默认 "message"，此处透出 undefined 交上层裁定）。
 */
export interface SseFrame {
  event: string | undefined;
  data: string;
}

export function createSseParser(onFrame: (frame: SseFrame) => void) {
  let buffer = "";
  let eventName: string | undefined;
  let dataLines: string[] = [];
  const dispatch = () => {
    if (dataLines.length > 0) {
      onFrame({ event: eventName, data: dataLines.join("\n") });
    }
    eventName = undefined; // 事件边界后重置（SSE 规范：event type 不跨帧）
    dataLines = [];
  };
  return (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.search(/\r?\n/)) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + (buffer[idx] === "\r" ? 2 : 1));
      if (line === "") {
        dispatch(); // 空行 = 事件边界
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      } else if (line.startsWith("event:")) {
        eventName = line.slice(6).replace(/^ /, "");
      }
      // `:` 注释与其余字段（id/retry）忽略
    }
  };
}
