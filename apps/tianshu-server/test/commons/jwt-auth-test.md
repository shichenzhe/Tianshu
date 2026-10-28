# JwtAuthService 单元测试说明

## 概述

本文档说明了 `JwtAuthService` 的单元测试实现。测试文件位于 `src/commons/auth/jwt-auth.service.spec.ts`。

## 测试策略

### 测试原则

- **不mock JwtAuthService**：直接测试真实的服务实例
- **只mock依赖项**：仅对 `ConfigService` 和 `JwtService` 进行mock
- **专注公共方法**：只测试对外暴露的公共方法

### 被测试的公共方法

1. `generateTokens(payload: IJwtPayload): TokenDto` - 生成访问令牌和刷新令牌
2. `verifyToken(token: string): IJwtPayload` - 验证JWT令牌

## 测试用例覆盖

### generateTokens 方法测试

- ✅ 成功生成访问令牌和刷新令牌
- ✅ payload缺少sub字段时抛出错误
- ✅ payload缺少username字段时抛出错误
- ✅ JWT配置缺少secret时抛出错误
- ✅ JWT配置缺少expiresIn时抛出错误
- ✅ JWT配置缺少refreshExpiresIn时抛出错误
- ✅ auth配置为null时抛出错误

### verifyToken 方法测试

- ✅ 成功验证有效令牌
- ✅ JWT配置缺少secret时抛出错误
- ✅ auth配置为null时抛出错误
- ✅ 令牌无效时抛出错误
- ✅ 令牌过期时抛出错误
- ✅ JWT服务抛出意外错误时处理

## 运行测试

### 运行单个测试文件

```bash
npm test -- jwt-auth.service.spec.ts
```

### 运行测试并查看覆盖率

```bash
npm run test:cov -- jwt-auth.service.spec.ts
```

### 运行所有测试

```bash
npm test
```

## 测试结果

- **测试用例数量**: 14个
- **测试覆盖率**: 100%
- **所有测试**: ✅ 通过

## Mock配置说明

### ConfigService Mock

```typescript
const mockConfigService = {
  get: jest.fn(),
};
```

### JwtService Mock

```typescript
const mockJwtService = {
  sign: jest.fn(),
  verify: jest.fn(),
};
```

### 测试配置

```typescript
const mockAuthConfig: IAuthConfig = {
  defaultStrategy: 'jwt',
  global: true,
  jwt: {
    secret: 'test-secret-key',
    expiresIn: '1h',
    refreshExpiresIn: '7d',
  },
};
```

## 最佳实践

1. **AAA模式**: 所有测试用例都遵循 Arrange-Act-Assert 模式
2. **清晰的测试描述**: 每个测试用例都有明确的描述说明测试目的
3. **完整的断言**: 验证方法调用次数、参数和返回值
4. **边界条件测试**: 覆盖各种异常情况和边界条件
5. **Mock隔离**: 每个测试后清理mock状态，确保测试独立性
