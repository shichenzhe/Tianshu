/**
 * 可选数字输入解析：空串视为未填写返回 undefined，非法数字抛错
 */
export const parseOptionalNumber = (raw: string): number | undefined => {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error("invalid-number");
  }
  return parsed;
};

export const parseOptionalInt = (raw: string): number | undefined => {
  const parsed = parseOptionalNumber(raw);
  if (parsed !== undefined && !Number.isInteger(parsed)) {
    throw new Error("invalid-number");
  }
  return parsed;
};
