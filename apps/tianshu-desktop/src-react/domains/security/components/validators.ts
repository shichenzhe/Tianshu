/**
 * 安全二级页名单条目校验共享（终审 S3：自 NetworkDetailView/FileDetailView
 * 三处重复抽取）：非空即收，归一化兜底在服务端 pick*Array 完成。
 */

/** 名单条目校验：trim 后非空返回归一值；空输入返回 null（RuleSection 提示无效） */
export const validateNonEmpty = (raw: string): string | null => {
  const trimmed = raw.trim();
  return trimmed !== "" ? trimmed : null;
};
