import { UnauthorizedException } from '@nestjs/common';
import { AuthController } from '../../src/modules/auth/auth.controller';
import { JwtAuthService } from '../../src/commons/auth/jwt-auth.service';
import { UserService } from '../../src/modules/user/user.service';
import { IJwtPayload } from '../../src/commons/auth/interface/auth.interface';
import { UserEntity } from '../../src/modules/user/entity/user.entity';

/**
 * POST /auth/refresh 幻影用户防护（2026-11-02，对齐 mirror 批修复）：
 * 端点 @Public + 仅验签即原样续签——用户删除后 refresh 令牌可无限续命。
 * 修复语义：发新凭证的标准对齐 login（存在 + isActive），无效即 401；
 * 存量 accessToken 到期自然出局（短命），续签断供。
 */
describe('AuthController.refreshToken（幻影用户防护）', () => {
  let controller: AuthController;
  const jwtAuthService: { verifyToken: jest.Mock; generateTokens: jest.Mock } =
    { verifyToken: jest.fn(), generateTokens: jest.fn() };
  const userService: { getById: jest.Mock } = { getById: jest.fn() };

  const payload: IJwtPayload = {
    sub: 'user-uuid-1',
    username: 'alice',
    name: '爱丽丝',
    roles: ['user'],
  };

  const activeUser = new UserEntity({
    id: 'user-uuid-1',
    username: 'alice',
    isActive: true,
  });

  beforeAll(() => {
    controller = new AuthController(
      jwtAuthService as unknown as JwtAuthService,
      userService as unknown as UserService,
    );
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('用户存在且启用 → 续签新令牌对', async () => {
    jwtAuthService.verifyToken.mockReturnValue({ ...payload });
    userService.getById.mockResolvedValue(activeUser);
    jwtAuthService.generateTokens.mockReturnValue({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
    });

    const result = await controller.refreshToken({
      refreshToken: 'valid-refresh-token',
    });

    expect(result).toEqual({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
    });
    expect(userService.getById).toHaveBeenCalledWith('user-uuid-1');
  });

  it('签名有效但用户已不存在 → 401 拒绝（幻影用户防护）', async () => {
    jwtAuthService.verifyToken.mockReturnValue({ ...payload });
    userService.getById.mockResolvedValue(null);

    await expect(
      controller.refreshToken({ refreshToken: 'valid-refresh-token' }),
    ).rejects.toThrow(UnauthorizedException);
    expect(jwtAuthService.generateTokens).not.toHaveBeenCalled();
  });

  it('用户已禁用 → 401 拒绝（发新凭证对齐 login 标准）', async () => {
    jwtAuthService.verifyToken.mockReturnValue({ ...payload });
    userService.getById.mockResolvedValue(
      new UserEntity({ id: 'user-uuid-1', username: 'alice', isActive: false }),
    );

    await expect(
      controller.refreshToken({ refreshToken: 'valid-refresh-token' }),
    ).rejects.toThrow(UnauthorizedException);
    expect(jwtAuthService.generateTokens).not.toHaveBeenCalled();
  });

  it('验签失败 → 401 拒绝（既有语义保留）', async () => {
    jwtAuthService.verifyToken.mockImplementation(() => {
      throw new Error('Invalid or expired token');
    });

    await expect(
      controller.refreshToken({ refreshToken: 'bad-token' }),
    ).rejects.toThrow(UnauthorizedException);
  });
});
