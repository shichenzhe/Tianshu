/** 超过该长度的路径做中段省略 */
const PATH_MAX_LENGTH = 24;

/** 路径中段省略：保留前 10 后 8 字符，防止长路径挤占消息区宽度 */
export function shortenPath(directoryPath: string): string {
  if (directoryPath.length <= PATH_MAX_LENGTH) {
    return directoryPath;
  }
  return `${directoryPath.slice(0, 10)}…${directoryPath.slice(-8)}`;
}
