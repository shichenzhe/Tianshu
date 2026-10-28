/**
 * sdk/api-types.d.ts 编译兜底（SK-2，spec §2.2）：生成类型为 gitignore
 * 产物（npm run sdk:generate 按需重生），fresh clone 未生成时 tsconfig
 * paths `#sdk/api-types` 回退解析本桩，保 test/sdk-contract.spec.ts 的
 * 类型层 import 可编译（否则 ts-jest 编译红——skip 语义失效）。桩形
 * any——「以 any 形静默放行断言」的风险由该 spec 的运行时 skip 门禁
 * 封死（openapi.json / api-types.d.ts 任一缺失即 describe.skip）。
 */
export interface components {
  schemas: any;
}
