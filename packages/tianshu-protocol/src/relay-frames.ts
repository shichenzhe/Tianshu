/**
 * relay 隧道帧（spec §3.3；RC-T1 收编单份）——与 tianshu-server
 * src/relay/registry.ts 的 RelayFrame 同构（该侧为透传形态：kind 联合 +
 * 索引签名；本侧为判别联合精确形态，帧面保持兼容，改动必须双仓同步）。
 *
 * **envelope 契约（T8/T9 契约注记 → 双仓钉死）**：
 * - req 帧负载与直连 HTTP 同构：{method:"GET"|"POST", path:"session/query"
 *   |"/session/query"（前导斜杠归一等价）, body?:unknown}；
 * - res 帧负载 {id, status, body}：status/body 即 handleRoute 的返回——
 *   body 含 starter 包装 {code,success,data,message}（业务错 200+4xxx）；
 * - relay 客户端按此消费 req 帧，RelayTransport.request() 按此封装
 *   req/res 配对，两承载（直连 HTTP / relay 隧道）上层无感。
 */
export type RelayFrame =
  | { kind: "req"; id: number; method: string; path: string; body?: unknown }
  | { kind: "res"; id: number; status: number; body: unknown }
  | { kind: "event"; type: string; payload: unknown }
  | { kind: "open"; connectionId: string }
  | { kind: "close"; connectionId: string; reason?: string }
  | {
      kind: "register";
      instanceId: string;
      capabilities: string[];
      name?: string;
    }
  // 活性帧（T14）：应用层 ping/pong 经 relay 透传（relay 侧只校验 kind 为
  // string；tianshu-server RelayFrameKind 未列亦原样转发）——undici 全局
  // WebSocket 无协议层 ping，见 ws-liveness.ts。双端对称：定时发 ping、
  // 收 ping 回 pong
  | { kind: "ping" }
  | { kind: "pong" };
