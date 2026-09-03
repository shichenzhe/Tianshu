/**
 * 编辑对话框可选字段差量：与原值一致返回 undefined（Prisma update 跳过该列），
 * 有变更时空白/空 → null（真正清空可空列），否则返回新值。
 * 创建态不走差量：直接「空 → undefined」即可。
 */

/** 字符串可选字段（先去空白再比较，写入值同样去空白） */
export function diffOptionalString(
  next: string,
  original: string | undefined,
): string | null | undefined {
  const trimmed = next.trim();
  if (trimmed === (original ?? "")) {
    return undefined;
  }
  return trimmed || null;
}

/** 数值等可选字段（入参为已解析的新值） */
export function diffOptionalValue<T>(
  next: T | undefined,
  original: T | undefined,
): T | null | undefined {
  if (next === original) {
    return undefined;
  }
  return next ?? null;
}
