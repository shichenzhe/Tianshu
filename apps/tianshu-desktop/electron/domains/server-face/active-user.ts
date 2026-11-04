/**
 * 渲染层上报的当前登录用户（问题 2 方案 A，裁定 2026-10-22）。
 *
 * 背景：登录态此前只存渲染层 localStorage（JWT），登录/登出/切换不通知
 * 主进程——被控面 resolveUserId 无从感知，只能猜「user 表最新一行」，
 * 切回更早注册的账号登录即错位（移动端看到的是另一个人的数据）。
 *
 * 语义：登录/登出/切换/启动恢复登录态时渲染层经 serverFace:
 * reportActiveUser 上报 userId（登出/未登录上报 null）。内存态——主进程
 * 重启即丢，渲染层 rehydrate 后再上报补齐；未上报窗口期回落「user 表
 * 最新」旧语义。token 为实例级钥匙不变（按用户签发另行裁定）。
 */
let reported: number | null = null;

/** 渲染层上报（null=登出/未登录清空） */
export function reportActiveUser(userId: number | null): void {
  reported = userId;
}

/** 被控面消费（resolveUserId / info 身份面） */
export function getReportedActiveUser(): number | null {
  return reported;
}
