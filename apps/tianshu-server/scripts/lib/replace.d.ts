/** 占位符替换引擎类型声明（实现见 replace.js，CommonJS） */
export declare const PLACEHOLDERS: string[];
export declare function applyPlaceholders(
  rootDir: string,
  values: Record<string, string>,
): Promise<string[]>;
