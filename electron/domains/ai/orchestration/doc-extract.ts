// electron/domains/ai/orchestration/doc-extract.ts
/**
 * 文档提取（docExtract 节点后端）：PDF（pdf-parse v2）/ Word docx
 * （mammoth）→ 纯文本；txt/md/文本类直读。重解析库全部懒加载——
 * 空载工作流不付出启动成本；解析失败抛可读错误（节点层转失败码）。
 */
import { readFile } from "node:fs/promises";

/** 直读文本扩展名（与资料库检索白名单同口径从宽） */
const PLAIN_TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "log",
  "yml",
  "yaml",
  "toml",
  "json",
  "html",
  "xml",
]);

export class DocExtractError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "DocExtractError";
  }
}

/** 按扩展名分流提取文本；不支持的类型抛 doc_unsupported_type */
export async function extractDocumentText(filePath: string): Promise<string> {
  const ext = filePath.slice(filePath.lastIndexOf(".") + 1).toLowerCase();
  if (PLAIN_TEXT_EXTENSIONS.has(ext)) {
    return readFile(filePath, "utf-8");
  }
  if (ext === "pdf") {
    return extractPdf(filePath);
  }
  if (ext === "docx") {
    return extractDocx(filePath);
  }
  throw new DocExtractError(
    "doc_unsupported_type",
    `不支持的文档类型: .${ext}（支持 pdf/docx 及 txt/md 等文本类）`,
  );
}

/** pdf-parse v2：data 传入 Buffer，getText() 汇总整册文本 */
async function extractPdf(filePath: string): Promise<string> {
  try {
    const { PDFParse } = await import("pdf-parse");
    const data = await readFile(filePath);
    const parser = new PDFParse({ data });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy().catch(() => {});
    }
  } catch (e) {
    if (e instanceof DocExtractError) {
      throw e;
    }
    throw new DocExtractError(
      "doc_parse_failed",
      `PDF 解析失败: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** mammoth：docx → 纯文本（值消息，丢格式） */
async function extractDocx(filePath: string): Promise<string> {
  try {
    const mammoth = await import("mammoth");
    const buffer = await readFile(filePath);
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  } catch (e) {
    if (e instanceof DocExtractError) {
      throw e;
    }
    throw new DocExtractError(
      "doc_parse_failed",
      `Word 解析失败: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
