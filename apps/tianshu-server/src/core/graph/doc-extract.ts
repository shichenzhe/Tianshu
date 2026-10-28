// eslint 并检适配（GA-T4 备案，先例 metrics.interceptor/main.ts 整文件
// 豁免）：本文件为 mirror 逐行摘取副本——@tianshu/core（file: 包）类型在
// eslint projectService 下不可解析（GA-T3 graph.repository 同况，tsc 正常）
// 与未安装驱动的 vendor-decls 环境声明面（exceljs/nodemailer 等 any）触发
// typed-lint 噪音；require-await 系 mirror 原文即有的 async 无 await 形态
// （逐行保持优先）。规则豁免不改变运行时行为。
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-base-to-string */
/* eslint-disable @typescript-eslint/require-await */
// electron/domains/ai/orchestration/doc-extract.ts
/**
 * 自 mirror electron/domains/ai/orchestration/doc-extract.ts 直摘（GA-T4
 * 闭包随行件——executor docExtract 节点动态引用；spec §3.4 原列「按需
 * 后续」排除，因 executor 引用无法缺席而随行）。零逻辑改动；pdf-parse/
 * mammoth 懒加载且 server 未安装（vendor-decls.d.ts 备案）——txt/md 等
 * 纯文本提取可用，pdf/docx 未装驱动时报节点失败。
 */
/**
 * 文档提取（docExtract 节点后端）：PDF（pdf-parse v2）/ Word docx
 * （mammoth）→ 纯文本；txt/md/文本类直读。重解析库全部懒加载——
 * 空载工作流不付出启动成本；解析失败抛可读错误（节点层转失败码）。
 */
import { readFile } from 'node:fs/promises';

/** 直读文本扩展名（与资料库检索白名单同口径从宽） */
const PLAIN_TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'log',
  'yml',
  'yaml',
  'toml',
  'json',
  'html',
  'xml',
]);

export class DocExtractError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DocExtractError';
  }
}

/** 按扩展名分流提取文本；不支持的类型抛 doc_unsupported_type */
export async function extractDocumentText(filePath: string): Promise<string> {
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase();
  if (PLAIN_TEXT_EXTENSIONS.has(ext)) {
    return readFile(filePath, 'utf-8');
  }
  if (ext === 'pdf') {
    return extractPdf(filePath);
  }
  if (ext === 'docx') {
    return extractDocx(filePath);
  }
  throw new DocExtractError(
    'doc_unsupported_type',
    `不支持的文档类型: .${ext}（支持 pdf/docx 及 txt/md 等文本类）`,
  );
}

/** pdf-parse v2：data 传入 Buffer，getText() 汇总整册文本 */
async function extractPdf(filePath: string): Promise<string> {
  try {
    const { PDFParse } = await import('pdf-parse');
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
      'doc_parse_failed',
      `PDF 解析失败: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** mammoth：docx → 纯文本（值消息，丢格式） */
async function extractDocx(filePath: string): Promise<string> {
  try {
    const mammoth = await import('mammoth');
    const buffer = await readFile(filePath);
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  } catch (e) {
    if (e instanceof DocExtractError) {
      throw e;
    }
    throw new DocExtractError(
      'doc_parse_failed',
      `Word 解析失败: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
