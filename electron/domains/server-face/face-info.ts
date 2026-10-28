// 被控面进程级身份（spec §3.2 首帧 / relay 注册帧共用）：模块加载生成
// 一次，与 tianshu-server info.controller 的 instanceId 同构。
// FACE_CAPABILITIES 自 @tianshu/protocol 收编（RC-T1，单份权威源）；
// FACE_INSTANCE_ID/FACE_NAME 仍本地（双仓各持同构副本，改动必须双改
// ——spec §3.1/§3.2）。
import { randomUUID } from "node:crypto";
import { DESKTOP_CAPABILITIES } from "@tianshu/protocol";

export const FACE_INSTANCE_ID = randomUUID();

/** 能力清单（spec §6.1：被控桌面端报 chat+provider）——单份定义在协议包
 * （RC-T1 收编；GA-T6 拆分：无头端 CAPABILITIES 增 graph 后，桌面端被控
 * 面无编排端点，改引 DESKTOP_CAPABILITIES 保持 chat+provider），此处仅
 * 作老导出名兼容 */
export const FACE_CAPABILITIES = DESKTOP_CAPABILITIES;

/** 被控面服务名（/info 与 relay register 帧的身份字段） */
export const FACE_NAME = "tianshu-desktop";
