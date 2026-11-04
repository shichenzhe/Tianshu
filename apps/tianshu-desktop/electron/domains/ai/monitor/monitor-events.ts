/**
 * 监控埋点：实现已收编 @tianshu/core（MO 批 2026-10-27，原文件逐字上移
 * 仅 Log.warn 改静默吞错）——本文件 re-export 保消费面 import 路径不变
 * （chat.service / graph-executor / automation-runner 三处埋点）。
 */
export * from "@tianshu/core";
