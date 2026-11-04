// 控制端协议类型（T13）——类型定义已收编共享协议包 @tianshu/protocol
// （共享 core 重构 RC-T1，原三处同构双写收敛单份），本文件为 re-export
// 兼容层：既有 import 链不变。
// wire 口径：SSE data / relay event 帧 payload 的日期一律 ISO 字符串
// （updatedAt: string），勿 new Date(str) 假设时区（T7/T12 契约注记，
// 详见包内 server-event.ts 头注释）。
export type { ServerEvent } from "@tianshu/protocol";
