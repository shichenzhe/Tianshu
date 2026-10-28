/**
 * user 消息引用文件前缀段拆分（渲染层共享纯函数，与
 * build-injected-content 的 [引用文件] 前缀互为正逆）：按空行分段从文本
 * 头部逐段提取，供消息气泡上方渲染文件卡片，余文照旧进气泡。覆盖两种
 * 形态——引用式（fileRef，整段单行带 read_file 指示）与内容注入式
 * （首行裸 [引用文件 path] 头 + 余行注入全文；全文不展示——卡片点击
 * 打开可见，AI 已随消息收到）。只认头部连续命中（首个不匹配段即止），
 * 正文中段手打同款文本不受影响；技能/待办前缀不在此列，保持原样显示。
 */

/** 引用式前缀行（与 referencePrefix 的 fileRef 分支同字面） */
const FILE_REF_LINE =
  /^\[引用文件 (.+?)\]（请用 read_file 工具读取该文件后处理）$/;

/** 内容注入式前缀头（段首行；余行为注入全文） */
const FILE_REF_HEADER = /^\[引用文件 (.+?)\]$/;

export interface SplitFileRefResult {
  /** 引用文件路径（工作空间相对/本地绝对路径等注入原值，头部连续命中保持原序） */
  refs: string[];
  /** 去除引用段后的余文（段间/与正文间的分隔空行一并清除） */
  rest: string;
}

export function splitFileRefPrefix(text: string): SplitFileRefResult {
  const refs: string[] = [];
  // 前缀块间、前缀整体与正文间均以空行分隔（buildInjectedContent 拼装口径）
  let segments = text.split("\n\n");
  while (segments.length > 0) {
    const segment = segments[0];
    // 引用式：整段单行带 read_file 指示
    const hinted = FILE_REF_LINE.exec(segment);
    if (hinted) {
      refs.push(hinted[1]);
      segments = segments.slice(1);
      continue;
    }
    // 内容注入式：段首行裸路径头（余行注入全文随段一并拆出，不进气泡）
    const header = FILE_REF_HEADER.exec(segment.split("\n")[0]);
    if (header) {
      refs.push(header[1]);
      segments = segments.slice(1);
      continue;
    }
    break;
  }
  if (refs.length === 0) {
    return { refs, rest: text };
  }
  return { refs, rest: segments.join("\n\n") };
}

/** 文件名（路径末段；兼容正/反斜杠分隔） */
export function fileRefBasename(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== "");
  return parts.length > 0 ? parts[parts.length - 1] : path;
}
