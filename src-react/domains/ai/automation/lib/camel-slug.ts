/**
 * slug → 小驼峰,映射 i18n templateData 键
 * (如 "daily-ai-news" → "dailyAiNews")。
 */
export function camelSlug(slug: string): string {
  return slug.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}
