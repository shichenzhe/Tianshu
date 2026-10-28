/** 首字母大写（空串安全：charAt(0) 空串原样返回） */
export function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** kebab-case → PascalCase（"invalid-config" → "InvalidConfig"；i18n reason/state key 拼装用） */
export function kebabToPascal(s: string): string {
  return s
    .split("-")
    .map(cap)
    .join("");
}
