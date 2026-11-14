/**
 * macOS Seatbelt sbpl profile 生成（OS 沙箱 spec §4.2/§4.3）：
 * 纯函数零 IO——路径转义与 /private 符号链接归一均字符串级，
 * vitest 直测；IO（realpath/os.tmpdir）在 seatbelt.ts 解析后传入。
 * workspace-write 语义：deny 全部写后白名单放行 workspace 子树 +
 * TMPDIR + 基础设备节点；读/进程执行/网络零约束（裁定 #2）。
 */

/** sbpl 字符串字面量转义：反斜杠与双引号（工作空间允许任意路径） */
export function escapeSbplString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** macOS 符号链接路径归一：/var、/tmp、/etc 前缀实际落 /private/ 下，
 * sbpl subpath 按真实路径匹配，未归一的白名单静默失效 */
export function normalizeMacPrivatePath(p: string): string {
  if (p === "/var" || p.startsWith("/var/")) {
    return "/private" + p;
  }
  if (p === "/tmp" || p.startsWith("/tmp/")) {
    return "/private" + p;
  }
  if (p === "/etc" || p.startsWith("/etc/")) {
    return "/private" + p;
  }
  return p;
}

/** workspace-write profile（spec §4.2 模板 + macOS 26 修正）：
 * (allow default) 头必带——macOS 26（Darwin 25）实测未提及操作不再默认
 * 放行，缺它 execvp 直接 EPERM；deny 与子路径 allow 更具体、优先级更高 */
export function buildSeatbeltProfile(
  workspacePath: string,
  tmpDir: string,
): string {
  const allowPaths = [workspacePath, tmpDir]
    .map((p) => normalizeMacPrivatePath(p))
    .filter((p) => p !== "");
  const allowLines = allowPaths
    .map((p) => `(allow file-write* (subpath "${escapeSbplString(p)}"))`)
    .join("\n");
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    allowLines,
    '(allow file-write* (literal "/dev/null") (literal "/dev/tty"))',
  ].join("\n");
}
