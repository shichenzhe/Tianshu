/** .env 密钥写入类型声明（实现见 env-file.js，CommonJS） */
export declare function upsertEnvSecret(
  rootDir: string,
  secret: string,
): Promise<string>;
