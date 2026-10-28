/* eslint-disable */
import { readFileSync, existsSync } from 'fs';
import * as yaml from 'js-yaml';
import { join } from 'path';
import * as _ from 'lodash';
import { applyJwtSecretEnv } from './env-secret';

/** 日志目录 env 覆盖名（桌面端 connections.ts 打包态 spawn 注入） */
export const LOG_DIR_ENV = 'TIANSHU_LOG_DIR';

const YAML_CONFIG_FILENAME = 'config/config.yml';
const filePath = join(__dirname, '../../../', YAML_CONFIG_FILENAME);
const envfilePath = join(
  __dirname,
  '../../../',
  `config/config.${process.env.NODE_ENV || 'development'}.yml`,
);

/**
 * 安全加载YAML配置文件
 * @param configPath 配置文件路径
 * @param isRequired 是否为必需文件
 * @returns 解析后的配置对象，如果文件不存在且非必需则返回空对象
 */
function loadConfigSafely(configPath: string, isRequired: boolean = true): any {
  if (!existsSync(configPath)) {
    if (isRequired) {
      throw new Error(`必需的配置文件不存在: ${configPath}`);
    }
    console.warn(`可选配置文件不存在，跳过加载: ${configPath}`);
    return {};
  }

  try {
    return yaml.load(readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`配置文件解析失败: ${configPath}, 错误: ${error.message}`);
  }
}

// 加载基础配置（必需）
const commonConfig = loadConfigSafely(filePath, true);

// 加载环境配置（可选，如果不存在则使用空对象）
const envConfig = loadConfigSafely(envfilePath, false);

// 合并配置
const configuration = _.merge(commonConfig, envConfig);

/**
 * 日志目录外移（PK 终审 F1）：config.yml 的 log.dir 缺省 ./logs 相对 cwd——
 * 打包内嵌态 cwd=serverRoot，日志落 .app 包体（写包体反模式+随更新整包
 * 替换丢失）。桌面端 spawn 注入 TIANSHU_LOG_DIR 绝对路径，此处覆盖进配置
 * 对象（LoggerFactory 经 ConfigService 取 'log' 的正规消费路径）；未注入
 * 零改动（dev 态仓内 ./logs 现状不变）。与 TIANSHU_DB_URL 同族独立命名
 * （DATABASE_URL 会被顶层覆写，log 段无此问题但保持 env 家族一致口径）。
 */
export function applyLogDirEnv(
  config: { log?: { dir?: string } },
  env: Partial<Pick<NodeJS.ProcessEnv, 'TIANSHU_LOG_DIR'>>,
): { log?: { dir?: string } } {
  const fromEnv = env[LOG_DIR_ENV]?.trim();
  if (fromEnv) {
    config.log ??= {};
    config.log.dir = fromEnv;
  }
  return config;
}

process.env.DATABASE_URL = configuration.database.url;

// JWT 密钥外移 .env（spec §13 项 6）：config.yml 不含 auth.jwt.secret，
// env JWT_SECRET 优先覆盖。必须在 load 工厂内应用（F5 修复）——工厂由
// ConfigService 在 loadEnvFile 把 .env 装入 process.env 之后求值；若在
// 模块顶层执行则早于 dotenv，.env 的密钥永不胜出（随机兜底冒名顶替）
export default () => {
  applyJwtSecretEnv(configuration, process.env);
  applyLogDirEnv(configuration, process.env);
  return configuration;
};
