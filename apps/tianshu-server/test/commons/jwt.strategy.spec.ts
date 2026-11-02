import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from '../../src/commons/auth/strategy/jwt.strategy';
import { PrismaService } from '../../src/commons/database/prisma.service';
import { IJwtPayload } from '../../src/commons/auth/interface/auth.interface';

/**
 * JwtStrategy.validate 幻影用户防护（2026-11-02，对齐 mirror 批修复）：
 * JWT 是无状态凭证，验签通过不等于用户仍在——user 表数据消失（删行/
 * 重建库/换库）后残留 token 在有效期内验签依然通过。validate 须回查
 * user 表确认存在，不存在拒绝（NestJS passport 惯例：validate 回查库）。
 */
describe('JwtStrategy.validate（幻影用户防护）', () => {
  let strategy: JwtStrategy;
  const mockConfigService = { get: jest.fn() };
  const mockPrisma = { user: { findUnique: jest.fn() } };

  beforeAll(async () => {
    mockConfigService.get.mockReturnValue({
      defaultStrategy: 'jwt',
      jwt: { secret: 'test-secret', expiresIn: '1h', refreshExpiresIn: '7d' },
    });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JwtStrategy,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    strategy = module.get(JwtStrategy);
  });

  const validPayload: IJwtPayload = {
    sub: 'user-uuid-1',
    username: 'alice',
    name: '爱丽丝',
    roles: ['user'],
  };

  it('用户存在 → 返回操作上下文载荷', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-uuid-1' });
    await expect(strategy.validate(validPayload)).resolves.toEqual({
      sub: 'user-uuid-1',
      name: '爱丽丝',
      username: 'alice',
      roles: ['user'],
    });
    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-uuid-1' },
      select: { id: true },
    });
  });

  it('签名有效但用户数据已不存在 → 401 拒绝', async () => {
    // 场景：user 表数据消失后残留 token——必须回查 user 表拦下
    mockPrisma.user.findUnique.mockResolvedValue(null);
    await expect(strategy.validate(validPayload)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('payload 缺 sub → 401 拒绝', async () => {
    await expect(
      strategy.validate({ ...validPayload, sub: '' } as IJwtPayload),
    ).rejects.toThrow(UnauthorizedException);
  });
});
