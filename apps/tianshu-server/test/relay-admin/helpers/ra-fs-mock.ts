/**
 * relay-admin e2e 套件共享 fs mock（Task 12 收编：此前 users/bootstrap/aks
 * 三套件各自内联同款）。**必须以副作用导入置于一切被测导入之前**——
 * configuration.ts 顶层按 __dirname 读 <root>/config/config.yml（jest 直跑
 * src 下不存在），mock 让探测命中内存假配置（磁盘/内存健康检查关闭，
 * 保持用例密闭）。
 *
 * 注意：本文件不得 import 任何被测模块——TS 的 CommonJS 产码把 import
 * 的 require 提到文件顶部，先于 jest.mock 语句执行就穿了帮。
 */
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  // log.maxDays 必须在——file-stream-rotator 无兜底，缺它直接崩；
  // response.excludePaths 含 /relay-admin/revocations——CRL 名单端点
  // 直出名单体（Task 12 契约：relay 侧 crl.ts parseList 读顶层双数组，
  // 统一包装会破坏该契约）
  const fakeYaml = [
    'database:',
    "  url: 'file:./ra-test.db'",
    'app:',
    "  name: 'relay-admin-test'",
    'response:',
    '  excludePaths:',
    '    - /actuator/health',
    '    - /relay-admin/revocations',
    'auth:',
    '  jwt:',
    "    expiresIn: '30m'",
    "    refreshExpiresIn: '12h'",
    'log:',
    "  level: 'info'",
    "  dir: './logs'",
    '  maxSize: 50MB',
    '  maxFiles: 10',
    '  maxDays: 7',
    '  datePattern: YYYY-MM-DD',
    '  format: YYYY-MM-DD HH:mm:ss,SSS',
    'management:',
    '  health:',
    '    diskSpace:',
    '      enabled: false',
    '    memory:',
    '      enabled: false',
  ].join('\n');
  return {
    ...actual,
    existsSync: (path: unknown): boolean =>
      typeof path === 'string' && path.endsWith('/config.yml')
        ? true
        : actual.existsSync(path as Parameters<typeof actual.existsSync>[0]),
    readFileSync: (
      path: unknown,
      ...rest: Parameters<typeof actual.readFileSync>[1][]
    ): ReturnType<typeof actual.readFileSync> =>
      typeof path === 'string' && path.endsWith('/config.yml')
        ? fakeYaml
        : actual.readFileSync(
            path as Parameters<typeof actual.readFileSync>[0],
            ...rest,
          ),
  };
});
