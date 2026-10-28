/**
 * 引用内容注入（LT-T4 / 技能引用批 / 引用式批）：逐引用前缀块 + 原输入
 * ——格式对齐桌面 buildInjectedContent（前缀块间 \n\n、整体与原文间
 * \n\n；文件 `[引用文件 path]`、技能 `[引用技能 name]`——kind 语义前缀
 * 对齐桌面 referencePrefix，模型可分辨引用来源）。移动端独立实现（RN 仓
 * 不 import mirror src-react），语义漂移由两侧测试钉住。
 *
 * 引用式（工作空间文件，引用式批 2026-10-21）：kind "fileRef" 只注路径
 * + read_file 指示、不拉内容——对齐桌面文件窗 library 首条注入（commit
 * 75a76bfb）的「AI 自己读」语义；遥控链路省去「files/read 拉全文到手机
 * 再上行回服务端」双程流量，聊天面板只显示路径行。本地文件（上传）
 * 与技能仍走内容注入（内容在手，无需工具）。
 */
export interface FileRef {
  path: string;
  content: string;
  /** 引用来源语义：缺省 = 内容注入（本地文件）；skill = 技能全文注入；
   *  fileRef = 工作空间引用式（仅路径 + read_file 指示，content 忽略） */
  kind?: "skill" | "fileRef";
}

/** 引用式指示（read_file = 无头端 agent 工具，工作空间相对路径） */
const FILE_REF_HINT = "请用 read_file 工具读取该文件后处理";

function referenceBlock(ref: FileRef): string {
  if (ref.kind === "skill") {
    return `[引用技能 ${ref.path}]\n${ref.content}`;
  }
  if (ref.kind === "fileRef") {
    return `[引用文件 ${ref.path}]（${FILE_REF_HINT}）`;
  }
  return `[引用文件 ${ref.path}]\n${ref.content}`;
}

export function buildInjectedContent(text: string, refs: FileRef[]): string {
  if (refs.length === 0) {
    return text;
  }
  return `${refs.map(referenceBlock).join("\n\n")}\n\n${text}`;
}

/** 引用式前缀行（与 referenceBlock 的 fileRef 分支同字面，拆装互为正逆） */
const FILE_REF_LINE = new RegExp(`^\\[引用文件 (.+?)\\]（${FILE_REF_HINT}）$`);

/** 内容注入式前缀头（段首行；余行为注入全文——本地文件/ask 回退） */
const FILE_REF_HEADER = /^\[引用文件 (.+?)\]$/;

/** 技能前缀头（段首行裸技能名；余行为技能全文，随段拆出不进气泡） */
const SKILL_REF_HEADER = /^\[引用技能 (.+?)\]$/;

export interface SplitFileRefResult {
  /** 头部引用项（保持原序）：file = 文件引用（引用式/内容注入式，
   *  path 为工作空间相对/注入原值）；skill = 技能（path 为技能名） */
  refs: Array<{ path: string; kind: "file" | "skill" }>;
  /** 去除引用段后的余文（段间/与正文间的分隔空行一并清除） */
  rest: string;
}

/**
 * user 消息引用前缀段拆分（渲染层，对齐桌面 file-ref-lines
 * splitFileRefPrefix）：从文本头部按空行分段提取，供气泡上方渲染引用
 * 卡片。覆盖三类形态——文件引用式（fileRef，整段单行带 read_file 指示）、
 * 文件内容注入式（首行裸 [引用文件 path] 头 + 余行注入全文）与技能内容
 * 注入式（首行裸 [引用技能 name] 头 + 余行技能全文；全文不进气泡，卡片
 * 点击 skills/read 拉全文查看）。只认头部连续命中（首个不匹配段即止），
 * 正文中段手打同款文本不受影响。
 */
export function splitFileRefPrefix(text: string): SplitFileRefResult {
  const refs: SplitFileRefResult["refs"] = [];
  // 前缀块间、前缀整体与正文间均以空行分隔（buildInjectedContent 口径）
  let segments = text.split("\n\n");
  while (segments.length > 0) {
    const segment = segments[0];
    // 引用式：整段单行带 read_file 指示
    const hinted = FILE_REF_LINE.exec(segment);
    if (hinted) {
      refs.push({ path: hinted[1], kind: "file" });
      segments = segments.slice(1);
      continue;
    }
    // 内容注入式：段首行裸路径头（余行注入全文随段一并拆出，不进气泡）
    const header = FILE_REF_HEADER.exec(segment.split("\n")[0]);
    if (header) {
      refs.push({ path: header[1], kind: "file" });
      segments = segments.slice(1);
      continue;
    }
    // 技能：段首行裸技能名头（余行技能全文随段一并拆出，不进气泡）
    const skillHeader = SKILL_REF_HEADER.exec(segment.split("\n")[0]);
    if (skillHeader) {
      refs.push({ path: skillHeader[1], kind: "skill" });
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
